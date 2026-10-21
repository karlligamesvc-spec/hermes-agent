import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopMemoryLedger, DesktopMemoryLedgerRequest, DesktopMemoryLedgerResult } from '@/lib/memory-ledger'

import { $memoryLedger, addMemory, memoryLedgerOn, removeMemory, syncMemoryLedger } from './memory-ledger'
import { setSingleThreadFlagForTest } from './single-thread'

type Bridge = (request: DesktopMemoryLedgerRequest) => Promise<DesktopMemoryLedgerResult>

const LEDGER: DesktopMemoryLedger = {
  aboutYou: [
    { content: '不露脸', createdAt: '', id: '3f2a9c1d-0000-4000-8000-000000000001', kind: 'about_you', source: 'app' }
  ],
  limits: { aboutYouMax: 30, contentMaxChars: 100, recentKeepDays: 30, recentMax: 50 },
  recent: []
}

function install(bridge: Bridge | undefined, features: Record<string, unknown> | null = { single_thread: true }) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    clientConfig: { get: async () => ({ payload: features ? { desktop_features: features } : {} }) },
    managed: bridge ? { memoryLedger: bridge } : {}
  }
}

describe('memory ledger store (hc-1016)', () => {
  beforeEach(() => {
    $memoryLedger.set({ accountId: null, ledger: null, status: 'idle' })
    // Forget hc-1014's once-per-window read so each case reads its own client config.
    setSingleThreadFlagForTest(false)
  })

  afterEach(() => {
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it.each([
    ['absent', null],
    ['false', { single_thread: false }],
    ['not literally true', { single_thread: 'yes' }],
    ['another feature', { daily_ideas: true }]
  ])('with the switch %s it only drops the local copy and shows nothing', async (_label, features) => {
    const bridge = vi.fn<Bridge>(async () => ({ ledger: null, ok: true }))

    install(bridge, features)
    await syncMemoryLedger('acc-1')

    expect(bridge.mock.calls).toEqual([[{ action: 'off' }]])
    expect($memoryLedger.get()).toEqual({ accountId: 'acc-1', ledger: null, status: 'off' })
    expect(memoryLedgerOn($memoryLedger.get(), 'acc-1')).toBe(false)
    expect(await addMemory('acc-1', 'about_you', 'x')).toEqual({ ok: false })
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('with the switch on it reads the ledger for the account', async () => {
    const bridge = vi.fn<Bridge>(async () => ({ ledger: LEDGER, ok: true }))

    install(bridge)
    await syncMemoryLedger('acc-1')

    expect(bridge.mock.calls).toEqual([[{ action: 'get' }]])
    expect($memoryLedger.get()).toEqual({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
    expect(memoryLedgerOn($memoryLedger.get(), 'acc-1')).toBe(true)
    expect(memoryLedgerOn($memoryLedger.get(), 'acc-2')).toBe(false)
  })

  it('an account without a ledger, or an older main process, shows the unavailable state', async () => {
    install(async () => ({ ledger: null, ok: true }))
    await syncMemoryLedger('acc-1')
    expect($memoryLedger.get().status).toBe('unavailable')

    install(undefined)
    await syncMemoryLedger('acc-1')
    expect($memoryLedger.get().status).toBe('unavailable')
  })

  it('a reply for an account that is no longer current is dropped', async () => {
    let release: (value: DesktopMemoryLedgerResult) => void = () => {}

    install(() => new Promise(resolve => (release = resolve)))
    const first = syncMemoryLedger('acc-1')
    await vi.waitFor(() => expect($memoryLedger.get().status).toBe('loading'))
    install(async () => ({ ledger: null, ok: true }), null)
    setSingleThreadFlagForTest(false)
    await syncMemoryLedger('acc-2')
    release({ ledger: LEDGER, ok: true })
    await first

    expect($memoryLedger.get()).toEqual({ accountId: 'acc-2', ledger: null, status: 'off' })
  })

  it('writes land in the store and carry the refusal reason', async () => {
    const bridge = vi.fn<Bridge>(async request => {
      if (request.action === 'add') {
        return { code: 'sensitive_content', ledger: null, message: 'INVALID', ok: false }
      }

      if (request.action === 'remove') {
        return { ledger: { ...LEDGER, aboutYou: [] }, ok: true }
      }

      return { ledger: LEDGER, ok: true }
    })

    install(bridge)
    await syncMemoryLedger('acc-1')

    expect(await addMemory('acc-1', 'about_you', '密码是 1')).toEqual({ code: 'sensitive_content', ok: false })
    expect($memoryLedger.get().ledger).toEqual(LEDGER)
    expect(await removeMemory('acc-1', LEDGER.aboutYou[0].id)).toEqual({ ok: true })
    expect($memoryLedger.get().ledger?.aboutYou).toEqual([])
  })
})
