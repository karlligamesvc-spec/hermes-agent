/**
 * hc-1100: 「上次被打断了」 under a turn that quitting APEX cut off.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $interruptedTurns, resetInterruptedTurnsForTest } from '@/store/interrupted-turns'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import { remixLiveTurn, remixRunningTurn } from '@/test/remix-turn'

import { turnUnfinished } from './interrupted-turn'
import type { TurnPart } from './turn-process'

const submitted = vi.hoisted(() => [] as string[])

vi.mock('@/app/chat/composer/focus', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestComposerSubmit: (text: string) => {
    submitted.push(text)

    return true
  }
}))

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

stubThreadEnvironment()
stubThreadViewportSize()

const THREAD = 'clip-main-thread'
const GOLDEN = '../../../__identity__/single-thread'
const T0 = Date.UTC(2026, 9, 28, 10, 1, 1) / 1000

const tool = (id: string, command: string, result: unknown, span: [number, number], background = false) => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: 'terminal',
  args: { command, ...(background ? { background: true } : {}) },
  argsText: JSON.stringify({ command }),
  result,
  timestamp: T0 + span[0],
  completedAt: T0 + span[1]
})

/** M7's F4 turn as reloaded after the quit: a background render, a wait, then nothing. */
function cutOffTurn(): ThreadMessage[] {
  return [
    {
      id: 'f4-ask',
      role: 'user',
      content: [{ type: 'text', text: '用 ffmpeg 把 qa-20min.mp4 的前 10 分钟转成 1080p H.264' }],
      attachments: [],
      createdAt,
      metadata: { custom: {} }
    } as ThreadMessage,
    {
      id: 'f4-work',
      role: 'assistant',
      content: [
        { type: 'text', text: '跟上一版参数完全一样，我照原参数再跑一遍，大约 17 分钟。' },
        tool(
          'call-render',
          'ffmpeg -hide_banner -y -i qa-20min.mp4 -t 600 -c:v libx264 qa-10min-f4.mp4',
          { output: 'Background process started', session_id: 'proc_5c3a434da870', exit_code: 0, error: null },
          [6, 6],
          true
        ),
        tool(
          'call-wait',
          'sleep 300; tail -c 200 qa-10min-f4.progress',
          { output: '[Command interrupted]', exit_code: 130, error: null },
          [12, 228]
        )
      ],
      status: { type: 'complete', reason: 'stop' },
      createdAt,
      metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
    } as unknown as ThreadMessage
  ]
}

/** Cut off while still thinking: no step yet, no answer. */
function thoughtOnlyTurn(): ThreadMessage[] {
  return [
    cutOffTurn()[0],
    {
      id: 'thinking',
      role: 'assistant',
      content: [{ type: 'reasoning', text: '先看看素材。', timestamp: T0, completedAt: T0 + 3 }],
      status: { type: 'complete', reason: 'stop' },
      createdAt,
      metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
    } as unknown as ThreadMessage
  ]
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

async function renderThread(messages: ThreadMessage[]) {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelector('[data-role="assistant"]')).not.toBeNull())
  await settle()

  return view.container
}

function messageArea(container: HTMLElement): string {
  return [...container.querySelectorAll('[data-slot="aui_assistant-message-root"]')]
    .map(node => node.outerHTML)
    .join('\n')
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
    .replace(/data-placeholder="[^"]*"/g, 'data-placeholder="«rotating»"')
}

const settled: string[][] = []

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $singleThreadFlag.set(true)
  $activeSessionId.set('runtime-1')
  $selectedStoredSessionId.set(THREAD)
  $gatewayState.set('open')
  $authState.set({ ...$authState.get(), enabled: true, gateReason: null, status: 'signed-in' })
  resetInterruptedTurnsForTest([THREAD])
  submitted.length = 0
  settled.length = 0
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    settleInterruptedTurns: (ids: string[]) => settled.push(ids)
  }
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  resetInterruptedTurnsForTest()
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
})

describe('turnUnfinished', () => {
  const text = (value: string): TurnPart => ({ type: 'text', text: value })
  const call: TurnPart = { type: 'tool-call', toolCallId: 'c', toolName: 'terminal', result: {} }
  const thought: TurnPart = { type: 'reasoning', text: '想一想' }

  it.each<[string, TurnPart[], boolean]>([
    ['an answer after the last step', [text('先转码'), call, text('转好了，82 MB')], false],
    ['an answer and no step', [text('好的')], false],
    ['the last step with nothing after it', [text('先转码'), call], true],
    ['a step and an empty text after it', [call, text('  ')], true],
    ['thought only', [thought], true],
    ['nothing at all', [], true]
  ])('%s', (_name, parts, expected) => {
    expect(turnUnfinished(parts)).toBe(expected)
  })
})

describe('single-thread product mode', () => {
  it('says the turn was cut off and offers the stopped step’s three ways on', async () => {
    const container = await renderThread(cutOffTurn())
    const notice = container.querySelector('[data-interrupted-turn]')

    expect(notice?.textContent).toContain('上次被打断了：APEX 退出时，这一轮还没做完。')
    expect(notice?.textContent).toContain('已经拿到的部分不会丢。')

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(submitted).toEqual([expect.stringMatching(/^再试一次「.+」这一步。$/)])
    expect(screen.getByRole('button', { name: '换个办法' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '先给我能出的部分' })).toBeTruthy()
    expect(settled).toEqual([])
  })

  it('a turn cut off before its first step gets one 「接着做」', async () => {
    const container = await renderThread(thoughtOnlyTurn())
    const notice = container.querySelector('[data-interrupted-turn]')

    expect(notice?.textContent).toContain('上次被打断了')
    expect(notice?.textContent).not.toContain('已经拿到的部分不会丢。')

    fireEvent.click(screen.getByRole('button', { name: '接着做' }))
    expect(submitted).toEqual(['上次退出时被打断了，接着把这件事做完。'])
  })

  it('the buttons wait for the engine connection', async () => {
    $gatewayState.set('closed')
    await renderThread(cutOffTurn())

    expect((screen.getByRole('button', { name: '重试' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a listed turn that got its answer (finished while the window was closed) shows nothing and is settled', async () => {
    const container = await renderThread(remixLiveTurn())

    expect(container.querySelector('[data-interrupted-turn]')).toBeNull()
    await waitFor(() => expect(settled).toEqual([[THREAD]]))
    expect($interruptedTurns.get().has(THREAD)).toBe(false)
  })

  it('an unlisted conversation shows nothing', async () => {
    resetInterruptedTurnsForTest(['another-thread'])
    const container = await renderThread(cutOffTurn())

    expect(container.querySelector('[data-interrupted-turn]')).toBeNull()
    expect(settled).toEqual([])
  })

  it('a turn still running shows nothing', async () => {
    const container = await renderThread(remixRunningTurn())

    expect(container.querySelector('[data-interrupted-turn]')).toBeNull()
  })

  it('only the last turn can carry it', async () => {
    const container = await renderThread([...cutOffTurn(), ...remixLiveTurn()])

    expect(container.querySelector('[data-interrupted-turn]')).toBeNull()
  })
})

describe('switch off and developer mode are untouched', () => {
  it('switch off: no line, and nothing is settled', async () => {
    $singleThreadFlag.set(false)
    const container = await renderThread(cutOffTurn())

    expect(container.querySelector('[data-interrupted-turn]')).toBeNull()
    expect(settled).toEqual([])
  })

  it('developer mode with the conversation listed renders its golden byte for byte', async () => {
    setToolViewMode('technical')
    const container = await renderThread(remixLiveTurn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/thread-finished-developer.html`)
  })

  it('switch off with the conversation listed renders its golden byte for byte', async () => {
    $singleThreadFlag.set(false)
    const container = await renderThread(remixLiveTurn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/thread-finished.html`)
  })
})
