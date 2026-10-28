/**
 * hc-1086 identity guard (hard rule 11) for the relay (接力) dispatcher,
 * renderer side: what the single-thread shell asks the engine and writes to
 * this install's storage while no relay is in play.
 *
 * The traces under `__identity__/multi-bot-handoff/` were recorded on fork main
 * aa8e554e with the same harness (trace.tsx), before any relay code existed:
 * one assistant, several assistants in product mode, several assistants in
 * developer mode. Each must stay byte-identical with the relay switch off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { traceJson, traceShell } from './__identity__/multi-bot-handoff/trace'

const { ensureGatewayProfile } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined)
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

const GOLDEN = './__identity__/multi-bot-handoff'

beforeEach(() => {
  localStorage.clear()
  resetMainThreadForTest()
  resetBotRosterForTest()
  $gatewayState.set('open')
  $activeGatewayProfile.set('default')
  setSingleThreadFlagForTest(true)
})

afterEach(() => {
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  resetBotRosterForTest()
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $gatewayState.set('idle')
  localStorage.clear()
})

describe.each([
  ['one assistant', 'one-assistant', false, 'product'],
  ['several assistants, product mode', 'several-product', true, 'product'],
  ['several assistants, developer mode', 'several-developer', true, 'technical']
] as const)('single_thread on, %s: byte-identical to main', (_label, name, multiBot, toolView) => {
  it('engine requests and storage writes over two roster refreshes', async () => {
    setToolViewMode(toolView)
    setMultiBotFlagForTest(multiBot)
    localStorage.clear()

    await expect(traceJson(await traceShell(2))).toMatchFileSnapshot(`${GOLDEN}/shell-${name}.json`)
  })
})
