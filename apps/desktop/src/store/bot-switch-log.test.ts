/**
 * hc-1099: the desktop.log line openBot writes when a switch fails, does not
 * land, hangs or is undone by the shell following the conversation on screen
 * — and silence when it lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatRendererConsoleLine } from '../../electron/renderer-log'

import { BOT_SWITCH_SLOW_MS, FOLLOW_UNDO_WINDOW_MS, resetBotSwitchLogForTest } from './bot-switch-log'
import { $activeGatewayProfile, $gatewaySwapTarget } from './profile'
import { $botIntent, openBot, resetBotRosterForTest } from './single-thread-bots'

const { ensureGatewayProfile } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string): Promise<void> => undefined)
}))

vi.mock('./profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile,
  pinNewChatProfile: vi.fn((name: string) => name),
  requestFreshSession: vi.fn()
}))

/** An engine that answers: the switch lands on the profile asked for. */
const lands = async (profile: string) => {
  $activeGatewayProfile.set(profile)
}

let logged: string[]

beforeEach(() => {
  resetBotRosterForTest()
  resetBotSwitchLogForTest()
  $activeGatewayProfile.set('default')
  $gatewaySwapTarget.set(null)
  ensureGatewayProfile.mockReset()
  ensureGatewayProfile.mockImplementation(lands)
  logged = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('hc-1099 a switch that goes wrong leaves one line in desktop.log', () => {
  it('says nothing when the switch lands', async () => {
    await openBot('writer')

    expect(logged).toEqual([])
  })

  it('names both assistants, the reason and the time when the engine cannot be reached', async () => {
    ensureGatewayProfile.mockRejectedValueOnce(new Error('timed out\n  while waiting for a free slot'))

    await expect(openBot('writer')).rejects.toThrow('timed out')

    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(
      /^\[multi-bot\] switch default → writer failed after \d+ ms: timed out while waiting for a free slot$/
    )
  })

  it('says which engine answers when the activation did not land', async () => {
    ensureGatewayProfile.mockImplementationOnce(async () => undefined)

    await openBot('writer')

    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(
      /^\[multi-bot\] switch default → writer did not land after \d+ ms: the engine answering is default's$/
    )
  })

  it('stays quiet about a switch a later click replaced', async () => {
    let release!: () => void

    ensureGatewayProfile.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (release = () => resolve(undefined)))
    )

    const first = openBot('writer')

    $botIntent.set('editor')
    release()
    await first

    expect(logged).toEqual([])
  })

  it('says once that a switch is still waiting, and nothing more when it lands', async () => {
    vi.useFakeTimers()
    let release!: () => void

    ensureGatewayProfile.mockImplementationOnce(
      () =>
        new Promise<undefined>(resolve => {
          release = () => {
            $activeGatewayProfile.set('writer')
            resolve(undefined)
          }
        })
    )

    const switching = openBot('writer')

    vi.advanceTimersByTime(BOT_SWITCH_SLOW_MS - 1)
    expect(logged).toEqual([])
    vi.advanceTimersByTime(1)
    expect(logged).toEqual([`[multi-bot] switch default → writer still waiting after ${BOT_SWITCH_SLOW_MS} ms`])

    release()
    await switching
    vi.advanceTimersByTime(BOT_SWITCH_SLOW_MS * 2)

    expect(logged).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never says a switch that landed in time is waiting, and leaves no timer behind', async () => {
    vi.useFakeTimers()

    ensureGatewayProfile.mockImplementationOnce(async (profile: string) => {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      $activeGatewayProfile.set(profile)
    })

    const switching = openBot('writer')

    await vi.advanceTimersByTimeAsync(1_000)
    await switching
    vi.advanceTimersByTime(BOT_SWITCH_SLOW_MS * 2)

    expect(logged).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('names a click’s switch the shell undid while it was still under way', async () => {
    let release!: () => void

    ensureGatewayProfile.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (release = () => resolve(undefined)))
    )

    const click = openBot('writer')

    $activeGatewayProfile.set('writer')
    const follow = openBot('default', 'follow')

    expect(logged).toEqual([
      '[multi-bot] switch to writer undone: the conversation on screen belongs to default (while that switch was still under way)'
    ])

    release()
    await Promise.all([click, follow])
  })

  it('names one the shell undid soon after it landed, but not a follow long after', async () => {
    vi.useFakeTimers()

    await openBot('writer')
    vi.advanceTimersByTime(1_000)
    await openBot('default', 'follow')

    expect(logged).toEqual([
      '[multi-bot] switch to writer undone: the conversation on screen belongs to default (1000 ms after it landed)'
    ])

    logged = []
    await openBot('writer')
    vi.advanceTimersByTime(FOLLOW_UNDO_WINDOW_MS)
    await openBot('default', 'follow')

    expect(logged).toEqual([])
  })

  it('writes at error level, the one level main keeps from the renderer console', () => {
    // electron/renderer-log.ts: only level 3 (error) of the main window reaches desktop.log.
    expect(
      formatRendererConsoleLine('main', { level: 3, lineNumber: 1, message: '[multi-bot] x', sourceUrl: 'a' })
    ).toBe('[renderer console:main] [multi-bot] x (a:1)')
    expect(
      formatRendererConsoleLine('main', { level: 2, lineNumber: 1, message: '[multi-bot] x', sourceUrl: 'a' })
    ).toBeNull()
  })
})
