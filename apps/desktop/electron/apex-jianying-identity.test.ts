/**
 * hc-1219 identity guard (hard rule 11), main-process side: what main writes
 * into the engine's spawn env at launch while the 剪映 switch is off.
 *
 * `__identity__/jianying/launch-env-off.json` was recorded on fork main
 * 6bf1b9080e with this file, before any 剪映 code existed. Every case in it
 * must stay byte-identical.
 *
 * Run with: npx vitest run electron/apex-jianying-identity.test.ts --project electron
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
  ['explicitly false', {}, features({ jianying: false })],
  ['a non-literal true: string', {}, features({ jianying: 'true' })],
  ['a non-literal true: number', {}, features({ jianying: 1 })],
  ['a top-level key is not the switch', {}, { jianying: true }],
  ['off on this install while the platform says on', { APEXNODES_JIANYING: '0' }, features({ jianying: true })],
  ['beside ChatCut', {}, features({ chatcut: true })],
  ['beside everything else', {}, features({ chatcut: true, model_tiers: true, multi_bot: true, single_thread: true })]
]

describe('launch switches with 剪映 off: byte-identical to fork main', () => {
  test('every off case', async () => {
    const recorded = Object.fromEntries(OFF_CASES.map(([label, env, payload]) => [label, launch(env, payload)]))

    await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot(
      './__identity__/jianying/launch-env-off.json'
    )
  })
})
