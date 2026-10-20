import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// hc-995 (Q10): an APEX account's rotation offers no developer tip and never
// the local-model campaign; a non-APEX install keeps both.

const { offerLocalSetupTip } = vi.hoisted(() => ({ offerLocalSetupTip: vi.fn(() => false) }))

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('nanostores')

  return { $gateway: atom<unknown>(null), activeGateway: () => ({ request: vi.fn(async () => undefined) }) }
})
vi.mock('@/store/session', async () => {
  const { atom } = await import('nanostores')

  return { $awaitingResponse: atom(false), $busy: atom(false) }
})
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('./local-setup-offer', () => ({ offerLocalSetupTip }))

import { en } from '@/i18n/en'

const QUIET_AND_DUE_MS = 11 * 60_000

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  offerLocalSetupTip.mockClear()
  vi.useFakeTimers()
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
  // jsdom lays nothing out: give the anchor a visible, on-screen box.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 40,
    height: 30,
    left: 10,
    right: 110,
    top: 10,
    width: 100,
    x: 10,
    y: 10,
    toJSON: () => ({})
  } as DOMRect)
  window.document.body.innerHTML = '<button data-tour="sidebar-nav-new-session">新对话</button>'
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.document.body.innerHTML = ''
})

async function runRotation(apexAccount: boolean) {
  const auth = await import('@/store/auth')
  const tips = await import('@/store/tips')
  const { useTipRotation } = await import('./use-tip-rotation')

  auth.$authState.set({ ...auth.$authState.get(), enabled: apexAccount, status: apexAccount ? 'signed-in' : 'signed-out' })
  renderHook(() => useTipRotation(en.tips))
  act(() => vi.advanceTimersByTime(QUIET_AND_DUE_MS))

  return tips.$activeTip.get()
}

it('an APEX account gets neither a catalog tip nor the local-model campaign', async () => {
  expect(await runRotation(true)).toBeNull()
  expect(offerLocalSetupTip).not.toHaveBeenCalled()
})

it('any other install keeps the rotation and the campaign', async () => {
  expect((await runRotation(false))?.tipId).toBe('new-session')
  expect(offerLocalSetupTip).toHaveBeenCalled()
})
