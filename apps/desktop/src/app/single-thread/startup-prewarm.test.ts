import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $activeGatewayProfile, $gatewaySwapTarget } from '@/store/profile'
import { $botIntent, apexBot, namedBot, resetBotRosterForTest } from '@/store/single-thread-bots'

import { LAST_ASSISTANT_KEY, startupPrewarmTarget, useStartupPrewarm } from './startup-prewarm'

const { prewarmProfileBackend } = vi.hoisted(() => ({ prewarmProfileBackend: vi.fn() }))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  prewarmProfileBackend
}))

const ROSTER = [apexBot(), namedBot({ name: 'writer' }), namedBot({ name: 'editor' })]

beforeEach(() => {
  window.localStorage.removeItem(LAST_ASSISTANT_KEY)
  resetBotRosterForTest(ROSTER)
  prewarmProfileBackend.mockReset()
})

afterEach(() => {
  window.localStorage.removeItem(LAST_ASSISTANT_KEY)
  resetBotRosterForTest()
  $botIntent.set(null)
  $gatewaySwapTarget.set(null)
  $activeGatewayProfile.set('default')
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
  it('once the main engine answers, starts the last assistant’s engine — once per launch', () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    const { rerender } = renderHook(({ open }) => useStartupPrewarm(true, open), { initialProps: { open: false } })

    expect(prewarmProfileBackend).not.toHaveBeenCalled()

    rerender({ open: true })
    rerender({ open: false })
    rerender({ open: true })

    expect(prewarmProfileBackend.mock.calls).toEqual([['writer']])
  })

  it('remembers the assistant on screen once its switch settled, when the window goes away', () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    renderHook(() => useStartupPrewarm(true, true))

    expect(prewarmProfileBackend.mock.calls).toEqual([['writer']])

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

  it('off (one assistant, developer mode), it neither warms nor remembers', () => {
    window.localStorage.setItem(LAST_ASSISTANT_KEY, 'writer')
    renderHook(() => useStartupPrewarm(false, true))
    window.dispatchEvent(new Event('pagehide'))

    expect(prewarmProfileBackend).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(LAST_ASSISTANT_KEY)).toBe('writer')
  })
})
