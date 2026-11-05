import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $poolLimits, POOL_LIMITS_DEFAULTS } from '@/store/pool-limits'
import { $activeGatewayProfile, $gatewaySwapTarget } from '@/store/profile'
import { $botIntent, apexBot, namedBot, resetBotRosterForTest } from '@/store/single-thread-bots'

import { LAST_ASSISTANT_KEY, startupPrewarmFits, startupPrewarmTarget, useStartupPrewarm } from './startup-prewarm'

const { openSecondaryCount, prewarmProfileBackend } = vi.hoisted(() => ({
  openSecondaryCount: vi.fn(() => 0),
  prewarmProfileBackend: vi.fn()
}))

vi.mock('@/store/gateway', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  openSecondaryCount
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  prewarmProfileBackend
}))

const ROSTER = [apexBot(), namedBot({ name: 'writer' }), namedBot({ name: 'editor' })]

beforeEach(() => {
  window.localStorage.removeItem(LAST_ASSISTANT_KEY)
  resetBotRosterForTest(ROSTER)
  prewarmProfileBackend.mockReset()
  openSecondaryCount.mockReset()
  openSecondaryCount.mockReturnValue(0)
  $poolLimits.set({ ...POOL_LIMITS_DEFAULTS })
})

afterEach(() => {
  window.localStorage.removeItem(LAST_ASSISTANT_KEY)
  resetBotRosterForTest()
  $botIntent.set(null)
  $gatewaySwapTarget.set(null)
  $activeGatewayProfile.set('default')
  $poolLimits.set({ ...POOL_LIMITS_DEFAULTS })
})

describe('hc-1146 which assistant starts warming at launch', () => {
  it.each([
    ['the last one on screen', 'writer', 'default', 'writer'],
    ['not the one already answering (the main engine)', 'writer', 'writer', null],
    ['nothing remembered yet', null, 'default', null],
    ['one that was deleted since', 'gone', 'default', null]
  ] as const)('%s', (_label, last, active, target) => {
    expect(startupPrewarmTarget(last, active, ROSTER)).toBe(target)
  })
})

describe('hc-1146 useStartupPrewarm', () => {
  it('once the main engine answers, starts the last assistant’s engine — once per launch', async () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    const { rerender } = renderHook(({ open }) => useStartupPrewarm(true, open), { initialProps: { open: false } })

    expect(prewarmProfileBackend).not.toHaveBeenCalled()

    rerender({ open: true })
    rerender({ open: false })
    rerender({ open: true })

    await waitFor(() => expect(prewarmProfileBackend.mock.calls).toEqual([['writer']]))
  })

  it('remembers the assistant on screen once its switch settled, when the window goes away', async () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    renderHook(() => useStartupPrewarm(true, true))

    await waitFor(() => expect(prewarmProfileBackend.mock.calls).toEqual([['writer']]))

    // Switching writes nothing.
    act(() => $botIntent.set('editor'))
    act(() => {
      $activeGatewayProfile.set('editor')
      $botIntent.set(null)
    })
    expect(window.localStorage.getItem(LAST_ASSISTANT_KEY)).toBe('writer')

    // Mid-switch, the one asked for is not settled yet: the last settled one is what is kept.
    act(() => $botIntent.set('default'))
    window.dispatchEvent(new Event('pagehide'))

    expect(window.localStorage.getItem(LAST_ASSISTANT_KEY)).toBe('editor')
  })

  it('off (one assistant, developer mode), it neither warms nor remembers', async () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    renderHook(() => useStartupPrewarm(false, true))
    window.dispatchEvent(new Event('pagehide'))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(prewarmProfileBackend).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(LAST_ASSISTANT_KEY)).toBe('writer')
  })
})

describe('hc-1146 a launch warm leaves the next click a free pool slot', () => {
  it.each([
    ['the default pool, nothing open', 0, 3, true],
    ['a pool of two, nothing open', 0, 2, true],
    ['a pool of three, one already open', 1, 3, true],
    ['a pool of one: the warm would be what the next click must evict', 0, 1, false],
    ['a pool of two, one already open', 1, 2, false],
    ['a full pool', 3, 3, false]
  ] as const)('%s → %s', (_label, open, max, fits) => {
    expect(startupPrewarmFits(open, max)).toBe(fits)
  })

  it('with the pool held to one engine, the last assistant is not warmed at launch', async () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    $poolLimits.set({ ...POOL_LIMITS_DEFAULTS, maxBackends: 1 })
    renderHook(() => useStartupPrewarm(true, true))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(prewarmProfileBackend).not.toHaveBeenCalled()
  })

  it('nor when the engines already open would leave no slot after it', async () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    openSecondaryCount.mockReturnValue(2)
    renderHook(() => useStartupPrewarm(true, true))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(prewarmProfileBackend).not.toHaveBeenCalled()
  })
})
