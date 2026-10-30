/**
 * hc-1113: what the main window does with a Quick Entry line. In 0.17.67, with
 * several assistants on, a line went into no conversation and nothing said so.
 * It now goes to the assistant the quick window named, through the composer's
 * own submit, and anything that keeps it from landing comes back as a failure.
 */
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BOT_SWITCH_WAIT_MS } from '@/app/single-thread/quick-entry'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { initQuickEntryBridge, QUICK_TARGET_NEW, setQuickEntrySubmitHandler } from '@/store/quick-entry'
import { $busy } from '@/store/session'
import { sessionTileDelegate } from '@/store/session-states'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, openBot, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { deliverQuickCapture } from './deliver'

vi.mock('@/store/single-thread-bots', async importOriginal => ({
  ...(await importOriginal<object>()),
  openBot: vi.fn()
}))

vi.mock('@/store/session-states', async importOriginal => ({
  ...(await importOriginal<object>()),
  sessionTileDelegate: vi.fn(() => null)
}))

const ROWS = [
  { is_default: true, name: 'default', ui_meta: { apex: { name: 'APEX' } } },
  { name: 'apex-bot-2', ui_meta: { apex: { created: 1, name: '剪辑助手' } } }
]

const EDITOR = { name: '剪辑助手', profile: 'apex-bot-2' }
const LINE = '标题写 3 个'

function severalOn(): void {
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setToolViewMode('product')
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
}

// What openBot does once the engine answers: the active profile moves, then its thread is found.
function landOn(profile: string): void {
  $activeGatewayProfile.set(profile)
  noteMainThreadClaimed(profile, `${profile}-root`)
}

function deps(result: unknown = true) {
  return { startFreshSessionDraft: vi.fn(), submitText: vi.fn(async () => result) }
}

beforeEach(() => {
  $activeGatewayProfile.set('default')
  $busy.set(false)
  vi.mocked(openBot).mockReset()
  vi.mocked(sessionTileDelegate).mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  $activeGatewayProfile.set('default')
  $busy.set(false)
  setQuickEntrySubmitHandler(null)
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('hc-1113 one assistant: the chat on screen gets the line, as before', () => {
  it('delivered through the composer’s submit', async () => {
    const d = deps()

    await expect(deliverQuickCapture({ target: 'current', text: LINE }, d)).resolves.toEqual({
      kind: 'current',
      ok: true,
      profile: 'default'
    })
    expect(d.submitText).toHaveBeenCalledWith(LINE)
    expect(openBot).not.toHaveBeenCalled()
  })

  it.each([
    ['a turn still running', true, 'busy'],
    ['anything else the app refuses (onboarding first, a read-only transcript…)', false, 'refused']
  ])('a refused send is a failure, not silence: %s', async (_label, busy, reason) => {
    $busy.set(busy)

    await expect(deliverQuickCapture({ target: 'current', text: LINE }, deps(false))).resolves.toMatchObject({
      ok: false,
      profile: 'default',
      reason
    })
  })

  it('a new session: fresh draft, then the submit', async () => {
    const d = deps()

    await expect(deliverQuickCapture({ target: QUICK_TARGET_NEW, text: LINE }, d)).resolves.toMatchObject({
      kind: 'new',
      ok: true
    })
    expect(d.startFreshSessionDraft).toHaveBeenCalledTimes(1)
  })

  it('a picked stored session goes in the background; if that fails, the chat on screen takes it', async () => {
    const delegate = { resumeTile: vi.fn(async () => 'rt-1'), submitToSession: vi.fn(async () => undefined) }
    vi.mocked(sessionTileDelegate).mockReturnValue(delegate as never)
    const d = deps()

    await expect(deliverQuickCapture({ target: 's1', text: LINE }, d)).resolves.toMatchObject({
      kind: 'session',
      ok: true
    })
    expect(delegate.submitToSession).toHaveBeenCalledWith('rt-1', LINE)
    expect(d.submitText).not.toHaveBeenCalled()

    delegate.resumeTile.mockRejectedValueOnce(new Error('gone'))

    await expect(deliverQuickCapture({ target: 's1', text: LINE }, d)).resolves.toMatchObject({
      kind: 'current',
      ok: true
    })
    expect(d.submitText).toHaveBeenCalledWith(LINE)
  })
})

describe('hc-1113 several assistants: the line goes to the one the quick window named', () => {
  it('already on screen: straight into its thread', async () => {
    severalOn()
    landOn('apex-bot-2')
    const d = deps()

    await expect(deliverQuickCapture({ assistant: EDITOR, target: 'current', text: LINE }, d)).resolves.toEqual({
      kind: 'current',
      ok: true,
      profile: 'apex-bot-2'
    })
    expect(openBot).not.toHaveBeenCalled()
    expect(d.submitText).toHaveBeenCalledWith(LINE)
  })

  it('another one on screen by now: that one is opened first, and the line goes into its thread', async () => {
    severalOn()
    landOn('default')
    vi.mocked(openBot).mockImplementation(async profile => landOn(profile))
    const d = deps()

    await expect(deliverQuickCapture({ assistant: EDITOR, target: 'current', text: LINE }, d)).resolves.toMatchObject({
      ok: true,
      profile: 'apex-bot-2'
    })
    expect(openBot).toHaveBeenCalledWith('apex-bot-2')
    expect(d.submitText).toHaveBeenCalledWith(LINE)
  })

  it('it does not open: a failure, and nothing is sent to the one on screen', async () => {
    severalOn()
    landOn('default')
    vi.mocked(openBot).mockRejectedValue(new Error('every slot busy'))
    const d = deps()

    await expect(deliverQuickCapture({ assistant: EDITOR, target: 'current', text: LINE }, d)).resolves.toEqual({
      detail: 'every slot busy',
      ok: false,
      profile: 'apex-bot-2',
      reason: 'switch'
    })
    expect(d.submitText).not.toHaveBeenCalled()
  })

  it('it opens but its thread never comes: after the wait a failure, never a send into APEX’s thread', async () => {
    vi.useFakeTimers()
    severalOn()
    landOn('default')
    // The engine answers, the thread lookup never finishes.
    vi.mocked(openBot).mockImplementation(async profile => {
      $activeGatewayProfile.set(profile)
    })
    const d = deps()
    let outcome: unknown = null

    void deliverQuickCapture({ assistant: EDITOR, target: 'current', text: LINE }, d).then(value => (outcome = value))
    await vi.advanceTimersByTimeAsync(BOT_SWITCH_WAIT_MS - 1)
    expect(outcome).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toMatchObject({ ok: false, profile: 'apex-bot-2', reason: 'switch' })
    expect(d.submitText).not.toHaveBeenCalled()
  })
})

describe('hc-1113 the main window answers main for every line', () => {
  function install() {
    let capture: ((payload: unknown) => void) | null = null

    const receipt = vi.fn()

    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
      quickEntry: {
        onSubmit: (callback: (payload: unknown) => void) => {
          capture = callback

          return () => (capture = null)
        },
        receipt
      }
    }

    const dispose = initQuickEntryBridge()

    return { dispose, receipt, submit: (payload: unknown) => capture?.(payload) }
  }

  it('accepted at once, then what became of it', async () => {
    const bridge = install()
    setQuickEntrySubmitHandler(async () => ({
      detail: 'a turn is still running',
      ok: false,
      profile: 'default',
      reason: 'busy'
    }))

    await act(async () => bridge.submit({ id: 'qe-7', target: 'current', text: LINE }))

    expect(bridge.receipt.mock.calls).toEqual([
      [{ id: 'qe-7', stage: 'accepted' }],
      [{ detail: 'a turn is still running', id: 'qe-7', profile: 'default', reason: 'busy', stage: 'failed' }]
    ])
    bridge.dispose()
  })

  it.each([
    ['a handler that throws', () => Promise.reject(new Error('boom')), 'error'],
    ['no handler at all', null, 'refused']
  ])('%s is still answered, as a failure', async (_label, handler, reason) => {
    const bridge = install()
    setQuickEntrySubmitHandler(handler as never)

    await act(async () => bridge.submit({ id: 'qe-8', target: 'current', text: LINE }))

    expect(bridge.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'qe-8', reason, stage: 'failed' }))
    bridge.dispose()
  })
})
