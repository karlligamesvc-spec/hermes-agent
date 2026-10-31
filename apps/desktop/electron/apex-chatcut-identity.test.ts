/**
 * hc-1122 identity guard (hard rule 11), main-process side: what main writes
 * into the engine's spawn env at launch while the ChatCut switch is off.
 *
 * `__identity__/chatcut/launch-env-off.json` was recorded on fork main
 * c16f890339 with this file, before any ChatCut code existed. Every case in it
 * must stay byte-identical.
 *
 * Run with: npx vitest run electron/apex-chatcut-identity.test.ts --project electron
 */

import { describe, expect, test } from 'vitest'

import { applyDesktopFeatureSwitches } from './apex-model-tiers'

type Env = Record<string, string | undefined>

const features = (flags: Record<string, unknown>) => ({ desktop_features: flags })

/** One launch: what main settles into the spawn env, and what it logs. */
function launch(env: Env, payload: unknown) {
  const spawnEnv: Env = { ...env }
  const lines: string[] = []
  const set = applyDesktopFeatureSwitches(spawnEnv, payload, line => lines.push(line))

  return {
    env: Object.fromEntries(
      Object.entries(spawnEnv)
        .filter(([key]) => key.startsWith('APEX'))
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    lines,
    set
  }
}

const OFF_CASES: [string, Env, unknown][] = [
  ['nothing', {}, null],
  ['no such flag', {}, features({})],
  ['explicitly false', {}, features({ chatcut: false })],
  ['a non-literal true: string', {}, features({ chatcut: 'true' })],
  ['a non-literal true: number', {}, features({ chatcut: 1 })],
  ['a top-level key is not the switch', {}, { chatcut: true }],
  ['off on this install while the platform says on', { APEXNODES_CHATCUT: '0' }, features({ chatcut: true })],
  ['beside single-thread', {}, features({ single_thread: true })],
  ['beside everything else', {}, features({ hypihub_apex: true, model_tiers: true, multi_bot: true, single_thread: true })]
]

describe('launch switches with ChatCut off: byte-identical to fork main', () => {
  test('every off case', async () => {
    const recorded = Object.fromEntries(OFF_CASES.map(([label, env, payload]) => [label, launch(env, payload)]))

    await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot(
      './__identity__/chatcut/launch-env-off.json'
    )
  })
})
