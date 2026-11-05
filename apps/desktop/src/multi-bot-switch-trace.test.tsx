import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pendingThreadClaim } from '@/app/single-thread/composer-middleware'
import { resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile, $gatewaySwapTarget } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { multiBotSwitchTrace } from './__identity__/multi-bot-switch/trace'

/**
 * hc-1146 切换助手不闪屏: what the conversation column goes through while the
 * user clicks from APEX to another assistant and back, both engines warm
 * (__identity__/multi-bot-switch/trace.tsx).
 *
 * Every golden was first recorded on fork main 50265a41 with this harness,
 * before hc-1146 touched the switch. With several assistants on
 * (`multi-bot.json`) hc-1146 changed it on purpose — no detour through `/`,
 * no `loading` thread — and the PR shows that diff. The other three (both
 * switches off, single-thread alone, developer mode with both on) are the
 * identity guard (hard rule 11): none of them may change.
 */

const { ensureGatewayProfile } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined)
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

/** A warm engine: published as the active profile in the click's tick, the swap settles 20 ms later. */
function warmEngine() {
  ensureGatewayProfile.mockImplementation(async (profile: string) => {
    $gatewaySwapTarget.set(profile)
    $activeGatewayProfile.set(profile)
    await new Promise(resolve => window.setTimeout(resolve, 20))
    $gatewaySwapTarget.set(null)
  })
}

beforeEach(() => {
  $gatewayState.set('open')
  resetBotRosterForTest()
  ensureGatewayProfile.mockReset()
  warmEngine()
})

afterEach(() => {
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  resetBotRosterForTest()
  $pendingThreadClaim.set(null)
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $gatewaySwapTarget.set(null)
  $activeGatewayProfile.set('default')
  $gatewayState.set('idle')
})

const GOLDEN = './__identity__/multi-bot-switch'

describe.each([
  ['switch-off', false, false, 'product'],
  ['single-thread-only', true, false, 'product'],
  ['developer', true, true, 'technical'],
  ['multi-bot', true, true, 'product']
] as const)('%s: a click to another assistant and back', (name, singleThread, multiBot, toolView) => {
  it('paints the frames in the golden', async () => {
    // Tool view first: switch-on-then-developer would pass through product mode on the way.
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(multiBot)

    await expect(await multiBotSwitchTrace(() => ensureGatewayProfile.mock.calls)).toMatchFileSnapshot(
      `${GOLDEN}/${name}.json`
    )
  })
})
