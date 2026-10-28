// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { resetHandoffsForTest, setMultiBotHandoffFlagForTest } from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

import { planThreadRowsHtml } from './__identity__/handoff-plan/render'
import { seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1091 identity guard (hard rule 11) for the relay plan (一条龙接力).
 *
 * The goldens under `__identity__/handoff-plan/` were recorded before the plan
 * card existed, with the same harness (render.tsx): APEX's transcript rows
 * ending in a reply that carries an `apex:plan` block.
 *
 * - relay off (several assistants, product and developer mode; one assistant):
 *   byte-identical.
 * - relay on in developer mode: the developer golden (relay counts only in
 *   single-thread product mode).
 * - relay on with several assistants in product mode: the plan card is the
 *   change, pinned by the plan card's own tests, not here.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/handoff-plan'

const ROSTER_ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'cutter', ui_meta: { apex: { color: 'teal', created: 2, name: '剪辑助手', shape: 'cloud' } } }
]

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  cleanup()
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  $activeGatewayProfile.set('default')
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
  localStorage.clear()
})

describe.each([
  ['several assistants, product mode, relay off', 'product', 'product', true, false],
  ['several assistants, developer mode, relay off', 'developer', 'technical', true, false],
  ['several assistants, developer mode, relay on', 'developer', 'technical', true, true],
  ['one assistant, relay off', 'one-assistant', 'product', false, false],
  ['one assistant, relay switch on', 'one-assistant', 'product', false, true]
] as const)('single_thread on, %s', (_label, prefix, toolView, several, relay) => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedShellState()
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(several)
    setMultiBotHandoffFlagForTest(relay)
    setToolViewMode(toolView)

    if (several) {
      resetBotRosterForTest(botRosterFrom(ROSTER_ROWS, () => true))
    }

    noteMainThreadClaimed('default', 'chat-a')
  })

  it('APEX’s transcript ending in a reply with a plan block', async () => {
    await expect(await planThreadRowsHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-plan-thread.html`)
  })
})
