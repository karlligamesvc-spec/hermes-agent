import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pendingThreadClaim } from '@/app/single-thread/composer-middleware'
import { resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile, $gatewaySwapTarget } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { switchFollowTrace } from './__identity__/switch-follow/trace'

/**
 * hc-1099 identity guard (hard rule 11) for the shell around an assistant
 * switch: the gateway switches it asks for, the routes it visits and where the
 * stores end, while a warm switch publishes the target before the fresh draft
 * lands (__identity__/switch-follow/trace.tsx).
 *
 * The goldens were recorded on fork main 966a3aa618 with this harness, before
 * hc-1099 touched the shell: both switches off, single-thread alone, and
 * developer mode with both on. None of them may change.
 */

const { ensureGatewayProfile } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined)
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

beforeEach(() => {
  $gatewayState.set('open')
  resetBotRosterForTest()
  ensureGatewayProfile.mockClear()
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

const GOLDEN = './__identity__/switch-follow'

describe.each([
  ['switch-off', false, false, 'product'],
  ['single-thread-only', true, false, 'product'],
  ['developer', true, true, 'technical']
] as const)('%s: the shell around a warm assistant switch', (name, singleThread, multiBot, toolView) => {
  it('asks for the same switches and visits the same routes', async () => {
    // Tool view first: switch-on-then-developer would pass through product mode on the way.
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(multiBot)

    await expect(await switchFollowTrace(() => ensureGatewayProfile.mock.calls)).toMatchFileSnapshot(
      `${GOLDEN}/${name}.json`
    )
  })
})
