/**
 * hc-1090 (多助手二期 R5): a relay that comes back leaves one 「最近发生的」 line
 * in the account's memory ledger, through the bridge the 「它记得什么」 page
 * writes with — once per relay, also across a restart; failed, stopped and
 * cancelled relays leave nothing; relay off, nothing runs.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'
import type { DesktopMemoryLedger, DesktopMemoryLedgerRequest, DesktopMemoryLedgerResult } from '@/lib/memory-ledger'

import { $authState } from './auth'
import {
  HANDOFF_LEDGER_RETRY_MS,
  noteHandoffInLedger,
  resetHandoffLedgerForTest,
  retryPendingHandoffNotes,
  useHandoffLedger
} from './handoff-ledger'
import { $memoryLedger } from './memory-ledger'
import { setSingleThreadFlagForTest } from './single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from './single-thread-bots'
import {
  type HandoffRecord,
  type HandoffStatus,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest,
  startHandoff,
  updateHandoff
} from './single-thread-handoff'
import { setToolViewMode } from './tool-view'

type Bridge = (request: DesktopMemoryLedgerRequest) => Promise<DesktopMemoryLedgerResult>

const STORE_KEY = 'apex.single-thread.handoff-ledger.v1'

const LEDGER: DesktopMemoryLedger = {
  aboutYou: [],
  limits: { aboutYouMax: 30, contentMaxChars: 100, recentKeepDays: 30, recentMax: 50 },
  recent: []
}

const TAKEN: DesktopMemoryLedgerResult = { created: true, ledger: LEDGER, ok: true }

const roster = (editorName: string) =>
  botRosterFrom(
    [
      { is_default: true, name: 'default' },
      { name: 'editor', ui_meta: { apex: { created: 1, name: editorName } } }
    ],
    () => true
  )

const LINE = '在电脑上，剪辑 帮 APEX 做完了「把口播剪成 30 秒」，交回：剪好了 30 秒版本，字幕已烧进去。'
const BARE = '在电脑上，剪辑 帮 APEX 做完了「把口播剪成 30 秒」'

let bridge: ReturnType<typeof vi.fn<Bridge>>

function install(answer: Bridge = async () => TAKEN): void {
  bridge = vi.fn<Bridge>(answer)
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { managed: { memoryLedger: bridge } }
}

function relayOn(on = true): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(on)
  resetBotRosterForTest(roster('剪辑'))
}

function signIn(accountId: null | string): void {
  $authState.set({ ...$authState.get(), accountId, status: accountId ? 'signed-in' : 'signed-out' })
}

/** A relay from APEX to 剪辑, queued then running, as the dispatcher would leave it. */
function running(): HandoffRecord {
  const result = startHandoff({
    ask: '把口播剪成 30 秒',
    from: { messageId: 'm-1', profile: 'default', storedSessionId: 'apex-root' },
    previous: { text: '口播稿' },
    to: 'editor'
  })

  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`)
  }

  return updateHandoff(result.handoff.id, { startedAt: Date.now(), status: 'running' })!
}

function settle(id: string, status: HandoffStatus, summary = '剪好了 30 秒版本，字幕已烧进去。'): HandoffRecord {
  const text = `剪好了。\n<!-- apex:handback\n${summary}\n-->`

  return updateHandoff(id, {
    finishedAt: Date.now(),
    result: status === 'returned' ? { at: Date.now(), files: [], links: [], summary, text } : null,
    status
  })!
}

const adds = () => bridge.mock.calls.map(([request]) => request)

beforeEach(() => {
  localStorage.clear()
  resetHandoffsForTest()
  resetHandoffLedgerForTest()
  relayOn()
  signIn('acc-1')
  $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
  setRuntimeI18nLocale('zh')
  install()
})

afterEach(() => {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
})

describe('a relay that comes back (hc-1090)', () => {
  it('leaves one 「最近发生的」 line through the ledger bridge', async () => {
    renderHook(() => useHandoffLedger(true))
    const record = running()

    settle(record.id, 'returned')

    await waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    expect(adds()).toEqual([{ action: 'add', content: LINE, kind: 'recent' }])
    // Done: nothing left to retry.
    await retryPendingHandoffNotes()
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it.each<HandoffStatus>(['failed', 'stopped', 'cancelled'])('a %s relay leaves nothing', async status => {
    renderHook(() => useHandoffLedger(true))
    const record = running()
    const over = settle(record.id, status)

    expect(await noteHandoffInLedger(over)).toBe(false)
    await retryPendingHandoffNotes()
    expect(bridge).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORE_KEY)).toBeNull()
  })

  it('is written once, however often it is announced', async () => {
    const record = settle(running().id, 'returned')
    const [first, second] = await Promise.all([noteHandoffInLedger(record), noteHandoffInLedger(record)])

    expect([first, second]).toEqual([true, false])
    expect(await noteHandoffInLedger(record)).toBe(false)

    // A restart: nothing in flight any more, what was written is remembered.
    resetHandoffLedgerForTest({ keepMarks: true })
    expect(await noteHandoffInLedger(record)).toBe(false)
    await retryPendingHandoffNotes()
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('a result harvested after a restart is written once', async () => {
    const record = running()

    // The window went away mid-turn; the reopened one's dispatcher harvests it.
    resetHandoffLedgerForTest({ keepMarks: true })
    renderHook(() => useHandoffLedger(true))
    settle(record.id, 'returned')

    await waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    resetHandoffLedgerForTest({ keepMarks: true })
    renderHook(() => useHandoffLedger(true))
    await retryPendingHandoffNotes()
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('a window closed mid-write retries the very same sentence, once', async () => {
    install(() => new Promise<DesktopMemoryLedgerResult>(() => undefined))
    const record = settle(running().id, 'returned')

    void noteHandoffInLedger(record)
    expect(adds()).toEqual([{ action: 'add', content: LINE, kind: 'recent' }])

    // Reopened later: the receiver was renamed and the app speaks English now.
    resetHandoffLedgerForTest({ keepMarks: true })
    resetBotRosterForTest(roster('小剪'))
    setRuntimeI18nLocale('en')
    install()
    renderHook(() => useHandoffLedger(true))

    await waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    expect(adds()).toEqual([{ action: 'add', content: LINE, kind: 'recent' }])
    await retryPendingHandoffNotes()
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('a retry while the write is still out sends nothing more', async () => {
    install(() => new Promise<DesktopMemoryLedgerResult>(() => undefined))
    const record = settle(running().id, 'returned')

    void noteHandoffInLedger(record)
    await retryPendingHandoffNotes()
    renderHook(() => useHandoffLedger(true))
    await Promise.resolve()

    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('a write that did not get through is tried again when relay comes back on', async () => {
    install(async () => ({ ledger: null, message: 'FETCH_FAILED', ok: false }))
    const record = settle(running().id, 'returned')

    expect(await noteHandoffInLedger(record)).toBe(false)

    install()
    const { rerender } = renderHook(({ on }) => useHandoffLedger(on), { initialProps: { on: false } })

    expect(bridge).not.toHaveBeenCalled()
    rerender({ on: true })
    await waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    expect(adds()).toEqual([{ action: 'add', content: LINE, kind: 'recent' }])
  })

  it.each(['sensitive_content', 'content_too_long'])(
    'refused as %s: once more without the point, then never again',
    async code => {
      install(async request =>
        request.action === 'add' && request.content === LINE
          ? { code, ledger: null, message: 'INVALID', ok: false }
          : TAKEN
      )
      const record = settle(running().id, 'returned')

      expect(await noteHandoffInLedger(record)).toBe(true)
      expect(adds()).toEqual([
        { action: 'add', content: LINE, kind: 'recent' },
        { action: 'add', content: BARE, kind: 'recent' }
      ])
      await retryPendingHandoffNotes()
      expect(bridge).toHaveBeenCalledTimes(2)
    }
  )

  it('refused outright: final, not retried', async () => {
    install(async () => ({ code: 'sensitive_content', ledger: null, message: 'INVALID', ok: false }))
    const record = settle(running().id, 'returned')

    expect(await noteHandoffInLedger(record)).toBe(false)
    expect(bridge).toHaveBeenCalledTimes(2)
    await retryPendingHandoffNotes()
    expect(bridge).toHaveBeenCalledTimes(2)
  })

  it('without a point there is one try only', async () => {
    install(async () => ({ code: 'sensitive_content', ledger: null, message: 'INVALID', ok: false }))
    const record = settle(running().id, 'returned', '')

    await noteHandoffInLedger(record)
    expect(adds()).toEqual([{ action: 'add', content: BARE, kind: 'recent' }])
    await retryPendingHandoffNotes()
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('a line meant for one account never goes to another', async () => {
    install(async () => ({ ledger: null, message: 'FETCH_FAILED', ok: false }))
    const record = settle(running().id, 'returned')

    await noteHandoffInLedger(record)
    install()
    signIn('acc-2')
    $memoryLedger.set({ accountId: 'acc-2', ledger: LEDGER, status: 'ready' })
    renderHook(() => useHandoffLedger(true))
    await retryPendingHandoffNotes()
    expect(bridge).not.toHaveBeenCalled()

    // acc-1 signs back in: its line goes now.
    signIn(null)
    $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
    signIn('acc-1')
    await waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
  })

  it('signed out: nothing is written or kept', async () => {
    signIn(null)
    const record = settle(running().id, 'returned')

    expect(await noteHandoffInLedger(record)).toBe(false)
    expect(bridge).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORE_KEY)).toBeNull()
  })

  it('a line older than a day is dropped, not written late', async () => {
    install(async () => ({ ledger: null, message: 'FETCH_FAILED', ok: false }))
    const record = settle(running().id, 'returned')

    await noteHandoffInLedger(record)
    install()
    await retryPendingHandoffNotes(Date.now() + HANDOFF_LEDGER_RETRY_MS + 1)
    expect(bridge).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}').pending).toEqual({})
  })

  it('a line whose relay was forgotten is dropped', async () => {
    install(async () => ({ ledger: null, message: 'FETCH_FAILED', ok: false }))
    const record = settle(running().id, 'returned')

    await noteHandoffInLedger(record)
    resetHandoffsForTest()
    install()
    await retryPendingHandoffNotes()
    expect(bridge).not.toHaveBeenCalled()
  })
})

describe('relay off', () => {
  it('subscribes to nothing, writes nothing, keeps nothing', async () => {
    const record = settle(running().id, 'returned')

    relayOn(false)
    renderHook(() => useHandoffLedger(true))
    expect(await noteHandoffInLedger(record)).toBe(false)
    await retryPendingHandoffNotes()

    // A relay finishing while off (records written before the switch went off).
    resetHandoffsForTest([{ ...record, finishedAt: null, result: null, status: 'running' }])
    updateHandoff(record.id, { result: record.result, status: 'returned' })
    await Promise.resolve()

    expect(bridge).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORE_KEY)).toBeNull()
  })

  it('a shell without several assistants mounts nothing', async () => {
    renderHook(() => useHandoffLedger(false))
    settle(running().id, 'returned')
    await Promise.resolve()

    expect(bridge).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORE_KEY)).toBeNull()
  })
})
