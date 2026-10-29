// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setMultiBotHandoffFlagForTest } from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'
import {
  clearWaitingState,
  roster,
  runningTurnHtml,
  seedWaitingState,
  severalSidebarHtml,
  sidebarHtml,
  THREAD_STATES
} from './__identity__/waiting-for-you/render'

/**
 * hc-1107 「等你确认」 identity guard (hard rule 11).
 *
 * The goldens under `__identity__/waiting-for-you/` were recorded on fork main
 * 91b2f71eaf with the same harness (render.tsx), before any hc-1107 code: the
 * sidebar with the one assistant waiting on an approval, on a choice, just
 * after an approval was answered, writing its reply, with a send refused, and
 * quiet; four assistants with three of them in those states; and a running
 * turn's foot waiting on an approval and on a choice.
 *
 * - Switch off and developer mode (one assistant or several): byte-identical,
 *   always. hc-1107 changes single-thread product mode only.
 * - Product mode (`product-*`): recorded before the change; hc-1107's commit
 *   re-records them, so the PR diff of those files is exactly what it changes
 *   on screen.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/waiting-for-you'

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  clearWaitingState()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  $activeGatewayProfile.set('default')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
})

describe.each([
  ['the switch off', 'switch-off', false, 'product', false],
  ['developer mode', 'developer', true, 'technical', false],
  ['developer mode, several assistants and relay on', 'developer-several', true, 'technical', true],
  ['product mode, one assistant', 'product', true, 'product', false],
  ['product mode, several assistants and relay on', 'product-several', true, 'product', true]
] as const)('%s', (_label, prefix, singleThread, toolView, several) => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedWaitingState()
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(several)
    setMultiBotHandoffFlagForTest(several)
    setToolViewMode(toolView)
    resetBotRosterForTest(several ? roster() : undefined)
  })

  it.each(THREAD_STATES)('the sidebar from another page, the thread %s', async name => {
    await expect(sidebarHtml(name)).toMatchFileSnapshot(`${GOLDEN}/${prefix}-sidebar-${name}.html`)
  })

  it('the sidebar on the conversation, waiting on an approval', async () => {
    await expect(sidebarHtml('approval', 'chat')).toMatchFileSnapshot(`${GOLDEN}/${prefix}-sidebar-approval-chat.html`)
  })

  it.each(['approval', 'clarify'] as const)('a running turn waiting on %s', async name => {
    await expect(await runningTurnHtml(name)).toMatchFileSnapshot(`${GOLDEN}/${prefix}-turn-${name}.html`)
  })

  it.runIf(several)('assistants in the background waiting, on a relay, refused', async () => {
    await expect(severalSidebarHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-background.html`)
  })

  it.runIf(several)('the same with the relay confirm card up', async () => {
    const html = severalSidebarHtml({ proposal: true })

    expect(html.length).toBeGreaterThan(0)
    await expect(html).toMatchFileSnapshot(`${GOLDEN}/${prefix}-background-proposal.html`)
  })
})
