import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, type ReactNode, useEffect, useMemo, useState } from 'react'

import { MEMORY_LEDGER_COPY } from '@/app/memory-ledger/memory-ledger-copy'
import { useI18n } from '@/i18n'
import { SINGLE_THREAD_CHAT_COPY } from '@/i18n/single-thread-chat'
import { Check } from '@/lib/icons'
import { type MemoryNote, memoryNotesFromParts } from '@/lib/memory-ledger'
import { $authState } from '@/store/auth'
import { $memoryLedger, memoryLedgerOn, removeMemory, syncMemoryLedger } from '@/store/memory-ledger'
import { useSingleThreadMode } from '@/store/single-thread'
import { useBotName } from '@/store/single-thread-bots'

/** Entries already announced to the main process, so a re-render does not re-read the ledger. */
const refreshedFor = new Set<string>()

/** The undo button on a noted line (prototype v2: the link colour, underlined). */
export const NOTED_ACTION_CLASS = 'text-primary underline underline-offset-2 hover:text-primary/80 disabled:opacity-60'

/**
 * One centred system line: 「✓ APEX 记下了：… · 撤销」 (hc-1063, prototype v2).
 * Shared by the memory notes below and the first-open intake, so both read the
 * same way.
 */
export const NotedLine: FC<{ action?: ReactNode; checked: boolean; children: ReactNode; error?: ReactNode }> = ({
  action,
  checked,
  children,
  error
}) => (
  <p className="max-w-full text-center text-xs leading-5 text-(--ui-text-tertiary)" role="status">
    {checked && (
      <Check
        aria-hidden="true"
        className="me-1 inline size-3.5 align-[-0.2em] text-emerald-600 dark:text-emerald-400"
      />
    )}
    <span className="wrap-anywhere">{children}</span>
    {action && (
      <>
        <span aria-hidden="true"> · </span>
        {action}
      </>
    )}
    {error && <span className="block text-destructive">{error}</span>}
  </p>
)

/**
 * hc-1016 记得你 v1: one centred line under a reply when the assistant remembered
 * something new this turn — 「APEX 记下了：… · 撤销」 (Grok's "Updated memory" line,
 * with Muse's undo). 撤销 deletes the entry from the account's ledger for real.
 * Shows only in single-thread product mode (`$singleThreadMode`); otherwise
 * renders nothing. One line per new entry, each undoable.
 */
export const MemoryNotedLine: FC = () => {
  // A string selector stays equal across streaming deltas, so the line does not
  // re-render with every token.
  const notesKey = useAuiState(s => JSON.stringify(memoryNotesFromParts(s.message.parts)))
  const notes = useMemo(() => JSON.parse(notesKey) as MemoryNote[], [notesKey])
  const { accountId } = useStore($authState)
  const ledger = useStore($memoryLedger)
  // Product mode only: 开发者模式 keeps today's transcript (the tool row shows the write).
  const productMode = useSingleThreadMode()
  const on = productMode && memoryLedgerOn(ledger, accountId)

  useEffect(() => {
    const fresh = notes.filter(note => !refreshedFor.has(note.id))

    if (!on || fresh.length === 0) {
      return
    }

    fresh.forEach(note => refreshedFor.add(note.id))
    // The engine wrote through its own key: re-read so the page and the next
    // session's prompt copy include it.
    void syncMemoryLedger(accountId)
  }, [accountId, notes, on])

  if (!on || notes.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col items-center gap-0.5 px-(--message-text-indent) pt-1" data-memory-noted="">
      {notes.map(note => (
        <NotedRow accountId={accountId} key={note.id} note={note} />
      ))}
    </div>
  )
}

const NotedRow: FC<{ accountId: null | string | undefined; note: MemoryNote }> = ({ accountId, note }) => {
  const { locale } = useI18n()
  const copy = MEMORY_LEDGER_COPY[locale].noted
  // hc-1077: the assistant on screen remembered it (the ledger itself is one for all, K1).
  const name = useBotName() ?? SINGLE_THREAD_CHAT_COPY[locale].assistantName
  const [state, setState] = useState<'failed' | 'noted' | 'undoing' | 'undone'>('noted')

  const undo = async () => {
    setState('undoing')
    setState((await removeMemory(accountId, note.id)).ok ? 'undone' : 'failed')
  }

  return (
    <NotedLine
      action={
        (state === 'noted' || state === 'undoing') && (
          <button
            className={NOTED_ACTION_CLASS}
            disabled={state === 'undoing'}
            onClick={() => void undo()}
            type="button"
          >
            {copy.undo}
          </button>
        )
      }
      checked={state !== 'undone'}
      error={state === 'failed' && copy.undoFailed}
    >
      {state === 'undone' ? copy.undone(note.content) : copy.line(note.content, name)}
    </NotedLine>
  )
}
