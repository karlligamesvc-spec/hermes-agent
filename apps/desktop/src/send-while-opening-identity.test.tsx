import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pendingThreadClaim } from '@/app/single-thread/composer-middleware'
import { stubThreadEnvironment } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'
import { resetMainThreadForTest } from '@/store/main-thread'
import { $notifications } from '@/store/notifications'
import { $activeGatewayProfile, $gatewaySwapTarget } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { $botIntent, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { OPENING_CASES, sendWhileOpeningTrace } from './__identity__/send-while-opening/trace'

/**
 * hc-1146 发消息半天没反应: a message sent while the thread is still opening
 * (__identity__/send-while-opening/trace.tsx — every 「正在打开对话」 exit of
 * the single-thread middleware).
 *
 * Every golden was first recorded on fork main 3992e465 (Desktop 0.17.72) with
 * this harness, before hc-1146 touched the send. With several assistants on
 * (`multi-bot.json`) hc-1146 changes it on purpose — the message is held above
 * the composer and goes out once the thread opens, instead of coming back with
 * a notice — and the PR shows that diff. The other three (both switches off,
 * single-thread alone, developer mode with both on) are the identity guard
 * (hard rule 11): none of them may change by a byte.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

// The "+" menu saves the generation model choice through the desktop bridge when it mounts; not what this is about.
vi.mock('@/app/chat/composer/generation-models', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  saveGenerationModelChoice: vi.fn(async () => undefined),
  saveImageGenerationModel: vi.fn(async () => undefined),
  saveVideoGenerationModel: vi.fn(async () => undefined)
}))

stubThreadEnvironment()

const GOLDEN = './__identity__/send-while-opening'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

function resetStores(): void {
  resetMainThreadForTest()
  resetBotRosterForTest()
  $pendingThreadClaim.set(null)
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $botIntent.set(null)
  $gatewaySwapTarget.set(null)
  $activeGatewayProfile.set('default')
  $notifications.set([])
  mainComposerScope.clear()
  clearSessionDraft(null)
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  $gatewayState.set('open')
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: false,
    status: 'signed-in'
  })
  resetStores()
})

afterEach(() => {
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetStores()
  $gatewayState.set('idle')
  setRuntimeI18nLocale('en')
})

describe.each([
  ['switch-off', false, false, 'product'],
  ['single-thread-only', true, false, 'product'],
  ['developer', true, true, 'technical'],
  ['multi-bot', true, true, 'product']
] as const)('%s: a send while the thread opens', (name, singleThread, multiBot, toolView) => {
  it('does what the golden recorded', async () => {
    // Tool view first: switch-on-then-developer would pass through product mode on the way.
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(multiBot)

    const steps: Record<string, unknown> = {}

    for (const kase of OPENING_CASES) {
      resetStores()
      steps[kase] = await sendWhileOpeningTrace(kase)
    }

    await expect(`${JSON.stringify(steps, null, 2)}\n`).toMatchFileSnapshot(`${GOLDEN}/${name}.json`)
  }, 30_000)
})
