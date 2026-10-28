/**
 * hc-1086 identity guard (hard rule 11), main-process side: what main writes
 * into the engine's spawn env at launch for every `desktop_features` switch.
 *
 * `__identity__/multi-bot-handoff/launch-env-off.json` was recorded on fork
 * main aa8e554e with this file, before any relay (接力) code existed. Every
 * case in it must stay byte-identical: the relay switch off, several
 * assistants off, or single-thread off.
 *
 * Run with: npx vitest run electron/apex-multi-bot-handoff-identity.test.ts --project electron
 */

import { describe, expect, test } from 'vitest'

import { applyDesktopFeatureSwitches } from './apex-model-tiers'

const SINGLE = 'APEXNODES_SINGLE_THREAD'
const MULTI = 'APEXNODES_MULTI_BOT'
const HANDOFF = 'APEXNODES_MULTI_BOT_HANDOFF'

type Env = Record<string, string | undefined>

/** `desktop_features` as the platform's client config carries it. */
const features = (names: string[]) => ({ desktop_features: Object.fromEntries(names.map(name => [name, true])) })

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

/** Cases whose relay switch is off for this launch (or that cannot be on at all). */
const OFF_CASES: [string, Env, unknown][] = [
  ['nothing', {}, null],
  ['single-thread alone', {}, features(['single_thread'])],
  ['several assistants from the platform', {}, features(['single_thread', 'multi_bot'])],
  ['relay from the platform, several assistants off', {}, features(['single_thread', 'multi_bot_handoff'])],
  ['relay from the platform, single-thread off', {}, features(['multi_bot', 'multi_bot_handoff'])],
  ['relay from the platform, both off', {}, features(['multi_bot_handoff'])],
  [
    'relay off on this install, everything on',
    { [HANDOFF]: '0' },
    features(['single_thread', 'multi_bot', 'multi_bot_handoff'])
  ],
  ['relay on this install, several assistants off', { [HANDOFF]: '1' }, features(['single_thread'])],
  [
    'relay on this install, several assistants off on this install',
    { [HANDOFF]: '1', [MULTI]: '0' },
    features(['single_thread', 'multi_bot'])
  ],
  [
    'relay on this install, single-thread off on this install',
    { [HANDOFF]: '1', [SINGLE]: '0' },
    features(['single_thread', 'multi_bot'])
  ],
  ['a non-literal true', {}, { desktop_features: { multi_bot: true, multi_bot_handoff: 'true', single_thread: true } }],
  ['an unreadable install value, platform off', { [HANDOFF]: 'maybe' }, features(['single_thread', 'multi_bot'])],
  [
    'tiers and hosted Hypit beside the relay',
    { [HANDOFF]: '1' },
    features(['model_tiers', 'hypihub_apex', 'single_thread'])
  ]
]

describe('launch switches with the relay off: byte-identical to fork main', () => {
  test('every off case', async () => {
    const recorded = Object.fromEntries(OFF_CASES.map(([label, env, payload]) => [label, launch(env, payload)]))

    await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot(
      './__identity__/multi-bot-handoff/launch-env-off.json'
    )
  })
})
