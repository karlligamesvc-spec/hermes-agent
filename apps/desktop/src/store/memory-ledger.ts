/**
 * hc-1016 记得你 v1: renderer cache of the signed-in account's memory ledger,
 * read and edited through the main-process bridge (electron/apex-memory-ledger.ts;
 * the login JWT never reaches the renderer).
 *
 * Keyed by account like store/creator-profile.ts: switching accounts drops the
 * previous ledger at once, and a reply for an account that is no longer signed
 * in is discarded. `syncMemoryLedger` runs on start, on an account change and
 * when the window comes back after a while: with `desktop_features.single_thread`
 * off it only asks main to drop the local prompt copy (status 'off'), so nothing
 * shows and nothing is read.
 */

import { atom } from 'nanostores'

import {
  type DesktopMemoryEntry,
  type DesktopMemoryLedger,
  type DesktopMemoryLedgerRequest,
  type DesktopMemoryLedgerResult,
  type MemoryKind,
  memoryLedgerBridge,
  singleThreadOn
} from '@/lib/memory-ledger'

export interface MemoryLedgerStoreState {
  accountId: null | string
  ledger: DesktopMemoryLedger | null
  /**
   * off: the switch is off (nothing shows) · loading: first read in flight ·
   * ready: the ledger is on screen · unavailable: no ledger for this account,
   * no bridge, or the read failed.
   */
  status: 'idle' | 'loading' | 'off' | 'ready' | 'unavailable'
}

export const $memoryLedger = atom<MemoryLedgerStoreState>({ accountId: null, ledger: null, status: 'idle' })

let latestSync = 0
let lastSyncedAt = 0

/** The ledger for this account, or null while another account's (or nothing) is held. */
export function memoryLedgerFor(state: MemoryLedgerStoreState, accountId: null | string | undefined) {
  return accountId && state.accountId === accountId && state.status === 'ready' ? state.ledger : null
}

/** Whether the one-thread assistant's memory surfaces show for this account. */
export function memoryLedgerOn(state: MemoryLedgerStoreState, accountId: null | string | undefined): boolean {
  return Boolean(accountId) && state.accountId === accountId && (state.status === 'ready' || state.status === 'loading')
}

function landed(accountId: string, result: DesktopMemoryLedgerResult): void {
  if ($memoryLedger.get().accountId !== accountId) {
    return
  }

  if (result.ledger) {
    $memoryLedger.set({ accountId, ledger: result.ledger, status: 'ready' })
  } else if (result.ok) {
    $memoryLedger.set({ accountId, ledger: null, status: 'unavailable' })
  }
}

/** Read the switch, then the ledger (on) or drop the local copy (off). Never throws. */
export async function syncMemoryLedger(accountId: null | string | undefined): Promise<void> {
  const serial = ++latestSync

  if (!accountId) {
    $memoryLedger.set({ accountId: null, ledger: null, status: 'idle' })

    return
  }

  const on = await singleThreadOn()
  const call = memoryLedgerBridge()

  if (serial !== latestSync) {
    return
  }

  lastSyncedAt = Date.now()

  if (!call) {
    $memoryLedger.set({ accountId, ledger: null, status: on ? 'unavailable' : 'off' })

    return
  }

  if (!on) {
    $memoryLedger.set({ accountId, ledger: null, status: 'off' })

    try {
      await call({ action: 'off' })
    } catch {
      // Main removes the copy on sign-out and account change anyway.
    }

    return
  }

  if ($memoryLedger.get().accountId !== accountId || $memoryLedger.get().status !== 'ready') {
    $memoryLedger.set({ accountId, ledger: null, status: 'loading' })
  }

  try {
    const result = await call({ action: 'get' })

    if (serial !== latestSync) {
      return
    }

    if (result.ledger || result.ok) {
      landed(accountId, result)
    } else if ($memoryLedger.get().status === 'loading') {
      $memoryLedger.set({ accountId, ledger: null, status: 'unavailable' })
    }
  } catch {
    if (serial === latestSync && $memoryLedger.get().status === 'loading') {
      $memoryLedger.set({ accountId, ledger: null, status: 'unavailable' })
    }
  }
}

/** Re-read when the window comes back after `staleMs`, so IM-side or other-device edits show up. */
export function syncMemoryLedgerIfStale(accountId: null | string | undefined, staleMs = 10 * 60_000): void {
  if (Date.now() - lastSyncedAt >= staleMs) {
    void syncMemoryLedger(accountId)
  }
}

export interface MemoryWriteOutcome {
  code?: string
  entry?: DesktopMemoryEntry
  ok: boolean
}

async function write(
  accountId: null | string | undefined,
  request: DesktopMemoryLedgerRequest
): Promise<MemoryWriteOutcome> {
  const call = memoryLedgerBridge()

  if (!accountId || !call || $memoryLedger.get().status === 'off') {
    return { ok: false }
  }

  try {
    const result = await call(request)

    landed(accountId, result)

    const code = result.code ?? (result.message === 'NOT_FOUND' ? 'entry_not_found' : undefined)

    return { ...(code ? { code } : {}), ...(result.entry ? { entry: result.entry } : {}), ok: result.ok }
  } catch {
    return { ok: false }
  }
}

export const addMemory = (accountId: null | string | undefined, kind: MemoryKind, content: string) =>
  write(accountId, { action: 'add', content, kind })

export const editMemory = (accountId: null | string | undefined, id: string, content: string) =>
  write(accountId, { action: 'edit', content, id })

/** Delete for real (the page's 删, and 撤销 on a 记下了 line). */
export const removeMemory = (accountId: null | string | undefined, id: string) =>
  write(accountId, { action: 'remove', id })
