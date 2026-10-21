import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { renderSync } from '@hermes/ink'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, it, vi } from 'vitest'

import { ClarifyPrompt } from '../components/prompts.js'
import { DEFAULT_THEME } from '../theme.js'

// The prompt prints each choice as the backend sent it. A question with no
// better answer (`recommended: false`) arrives with no wire marker on any
// choice, so no row may carry one: the prompt never labels by position.

class FakeInput extends EventEmitter {
  isRaw = false
  isTTY = true
  readableLength = 0
  read = () => null
  ref = vi.fn()
  setEncoding = vi.fn()
  setRawMode = vi.fn((enabled: boolean) => {
    this.isRaw = enabled
  })
  unref = vi.fn()
}

const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

async function rows(choices: string[]) {
  const stdout = Object.assign(new PassThrough(), { columns: 80, isTTY: false, rows: 24 })
  const frames: string[] = []
  stdout.on('data', chunk => frames.push(chunk.toString()))

  const instance = renderSync(
    <ClarifyPrompt
      onCancel={vi.fn()}
      onQuestionAnswer={vi.fn()}
      req={{ questions: [{ choices, multiSelect: false, qid: 'q0', question: 'What do you film?' }], requestId: 'r1' }}
      t={DEFAULT_THEME}
    />,
    {
      patchConsole: false,
      stdin: new FakeInput() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    }
  )

  await settle()
  instance.unmount()
  instance.cleanup()

  return stripAnsi(frames.join(''))
    .split('\n')
    .map(line => line.replace(/^[\s▸]+/, '').trimEnd())
}

describe('ClarifyPrompt recommended label', () => {
  it('labels no row of a question that arrives unmarked', async () => {
    const screen = await rows(['Vlogs', 'Skits'])

    expect(screen).toContain('1. Vlogs')
    expect(screen).toContain('2. Skits')
    expect(screen.join('\n')).not.toContain('Recommended')
  })

  it('shows the label only on the choice the backend marked', async () => {
    const screen = await rows(['Vlogs', 'Skits (Recommended)'])

    expect(screen).toContain('1. Vlogs')
    expect(screen).toContain('2. Skits (Recommended)')
  })
})
