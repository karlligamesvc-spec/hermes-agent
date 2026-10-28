/**
 * hc-1090 多助手二期 R5: when a relay (接力) comes back, one 「最近发生的」 line
 * goes into the account's memory ledger (i18n/handoff-ledger.ts says what it
 * reads), through the bridge the 「它记得什么」 page writes with
 * (store/memory-ledger.ts `addMemory` → electron/apex-memory-ledger.ts, the
 * login JWT in main). The ledger is the account's, shared by every assistant
 * and the WeChat APEX (K1, K7).
 *
 * Once per relay:
 * - only a relay that came back (`returned`); failed, stopped and cancelled ones
 *   leave nothing;
 * - the line is composed once, when the relay comes back, and kept with its
 *   account until the cloud has it, so a retry sends the very same sentence
 *   (the cloud keeps one entry per sentence) and never to another account;
 * - a relay this install has written, or is writing, is not written again;
 * - only a relay of the account signed in now (its `owner`, hc-1086);
 * - a write that did not get through (offline, the login expired, the window
 *   closed mid-write) is tried again the next time relay comes on or the
 *   account signs back in, for a day; later its 「最近发生的」 date would be wrong, so it
 *   is dropped. A refusal from the cloud (too long, sensitive) is final after
 *   one try without the point.
 *
 * Off, nothing here runs and nothing is written: the hook reads its switch and
 * returns.
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { handoffLedgerLines } from '@/i18n/handoff-ledger'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { readJson, writeJson } from '@/lib/storage'

import { $authState } from './auth'
import { addMemory } from './memory-ledger'
import { $botRoster, botFor } from './single-thread-bots'
import {
  $handoffMode,
  $handoffs,
  type HandoffRecord,
  isHandoffMode,
  isOwnHandoff,
  onHandoffReturned
} from './single-thread-handoff'

const STORE_KEY = 'apex.single-thread.handoff-ledger.v1'

/** Relays written, newest last: twice the settled records R1 keeps, so none of those is forgotten. */
const DONE_KEPT = 120

/** How long a line that did not get through is tried again. */
export const HANDOFF_LEDGER_RETRY_MS = 24 * 60 * 60_000

/** The cloud refused the sentence itself: the line without the point may still go in. */
const REFUSED_WITH_POINT: ReadonlySet<string> = new Set(['content_too_long', 'sensitive_content'])

interface PendingLine {
  accountId: string
  bare: string
  full: string
}

interface LedgerMarks {
  done: string[]
  pending: Record<string, PendingLine>
}

function isPending(value: unknown): value is PendingLine {
  const row = value as Partial<PendingLine> | null

  return Boolean(
    row && typeof row.accountId === 'string' && typeof row.full === 'string' && typeof row.bare === 'string'
  )
}

function loadMarks(): LedgerMarks {
  const raw = readJson<Partial<LedgerMarks>>(STORE_KEY)
  const done = Array.isArray(raw?.done) ? raw.done.filter((id): id is string => typeof id === 'string') : []
  const rows = raw?.pending && typeof raw.pending === 'object' ? Object.entries(raw.pending) : []

  return { done, pending: Object.fromEntries(rows.filter(([, row]) => isPending(row))) }
}

function saveMarks(marks: LedgerMarks): void {
  writeJson(STORE_KEY, { done: marks.done.slice(-DONE_KEPT), pending: marks.pending })
}

function markDone(id: string): void {
  const marks = loadMarks()
  const { [id]: _written, ...pending } = marks.pending

  saveMarks({ done: [...marks.done.filter(other => other !== id), id], pending })
}

/** The account a line goes to: the signed-in one, else none (no ledger to write). */
function ledgerAccount(): null | string {
  const auth = $authState.get()

  return auth.status === 'signed-in' && auth.accountId ? auth.accountId : null
}

const writing = new Set<string>()

async function send(id: string, line: PendingLine): Promise<boolean> {
  writing.add(id)

  try {
    let outcome = await addMemory(line.accountId, 'recent', line.full)

    if (!outcome.ok && outcome.code && REFUSED_WITH_POINT.has(outcome.code) && line.bare !== line.full) {
      outcome = await addMemory(line.accountId, 'recent', line.bare)
    }

    // Written, or refused for good: either way this relay is done with the ledger.
    if (outcome.ok || outcome.code) {
      markDone(id)
    }

    return outcome.ok
  } finally {
    writing.delete(id)
  }
}

/**
 * Write a returned relay's line, once. Resolves to whether the cloud took it
 * (as a new entry or one it already had).
 */
export function noteHandoffInLedger(record: HandoffRecord): Promise<boolean> {
  const accountId = record.owner

  if (!isHandoffMode() || record.status !== 'returned' || !record.result || !accountId || writing.has(record.id)) {
    return Promise.resolve(false)
  }

  // R1 announces 交回 only for the account signed in now; checked again here for any other caller.
  if (!isOwnHandoff(record)) {
    return Promise.resolve(false)
  }

  const marks = loadMarks()

  if (marks.done.includes(record.id) || marks.pending[record.id]) {
    return Promise.resolve(false)
  }

  const lines = handoffLedgerLines(
    {
      ask: record.ask,
      fromName: record.from.name || botFor($botRoster.get(), record.from.profile).name,
      summary: record.result.summary,
      toName: botFor($botRoster.get(), record.to).name
    },
    getRuntimeI18nLocale()
  )

  const line: PendingLine = { accountId, ...lines }

  // Kept before the write goes out, so a window closed mid-write leaves it to retry.
  saveMarks({ ...marks, pending: { ...marks.pending, [record.id]: line } })

  // Its login expired meanwhile: kept, and written once the account is signed in again.
  if (ledgerAccount() !== accountId) {
    return Promise.resolve(false)
  }

  return send(record.id, line)
}

/**
 * Try again the lines that did not get through for the signed-in account, and
 * drop those whose relay is gone, no longer returned, or came back more than
 * {@link HANDOFF_LEDGER_RETRY_MS} ago.
 */
export async function retryPendingHandoffNotes(now = Date.now()): Promise<void> {
  const accountId = ledgerAccount()

  if (!isHandoffMode() || !accountId) {
    return
  }

  const marks = loadMarks()
  const records = $handoffs.get()
  const kept: Record<string, PendingLine> = {}

  for (const [id, line] of Object.entries(marks.pending)) {
    const record = records.find(other => other.id === id)
    const at = record?.finishedAt ?? record?.updatedAt ?? 0

    if (record?.status === 'returned' && now - at <= HANDOFF_LEDGER_RETRY_MS) {
      kept[id] = line
    }
  }

  if (Object.keys(kept).length !== Object.keys(marks.pending).length) {
    saveMarks({ ...marks, pending: kept })
  }

  for (const [id, line] of Object.entries(kept)) {
    if (line.accountId === accountId && !writing.has(id)) {
      await send(id, line)
    }
  }
}

/**
 * The shell's part (use-multi-bot-shell.ts), mounted before the relay
 * dispatcher so a result it harvests is heard: while relay is on, note every
 * relay that comes back, and retry what did not get through when relay comes
 * on and when an account signs in. Off, it subscribes to nothing.
 */
export function useHandoffLedger(multiBot: boolean): void {
  const on = useStore($handoffMode) && multiBot

  useEffect(() => {
    if (!on) {
      return
    }

    let account = ledgerAccount()
    const offReturned = onHandoffReturned(record => void noteHandoffInLedger(record))

    const offAuth = $authState.listen(() => {
      const next = ledgerAccount()

      if (next && next !== account) {
        void retryPendingHandoffNotes()
      }

      account = next
    })

    void retryPendingHandoffNotes()

    return () => {
      offReturned()
      offAuth()
    }
  }, [on])
}

/** Tests only: forget the writes in flight (a restart) and, unless kept, what was written. */
export function resetHandoffLedgerForTest(options: { keepMarks?: boolean } = {}): void {
  writing.clear()

  if (!options.keepMarks) {
    writeJson(STORE_KEY, null)
  }
}
