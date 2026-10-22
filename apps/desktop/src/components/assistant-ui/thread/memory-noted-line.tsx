import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, useEffect, useMemo, useState } from 'react'

import { MEMORY_LEDGER_COPY } from '@/app/memory-ledger/memory-ledger-copy'
import { useI18n } from '@/i18n'
import { type MemoryNote, memoryNotesFromParts } from '@/lib/memory-ledger'
import { $authState } from '@/store/auth'
import { $memoryLedger, memoryLedgerOn, removeMemory, syncMemoryLedger } from '@/store/memory-ledger'
import { useSingleThreadMode } from '@/store/single-thread'

/** Entries already announced to the main process, so a re-render does not re-read the ledger. */
const refreshedFor = new Set<string>()

/**
 * hc-1016 记得你 v1: one centred line under a reply when the assistant remembered
 * something new this turn — 「记下了：… · 撤销」 (Grok's "Updated memory" line,
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
  const [state, setState] = useState<'failed' | 'noted' | 'undoing' | 'undone'>('noted')

  const undo = async () => {
    setState('undoing')
    setState((await removeMemory(accountId, note.id)).ok ? 'undone' : 'failed')
  }

  return (
    <p className="max-w-full text-center text-xs leading-5 text-(--ui-text-tertiary)" role="status">
      <span className="wrap-anywhere">{state === 'undone' ? copy.undone(note.content) : copy.line(note.content)}</span>
      {(state === 'noted' || state === 'undoing') && (
        <>
          <span aria-hidden="true"> · </span>
          <button
            className="text-(--ui-text-secondary) underline-offset-2 hover:underline disabled:opacity-60"
            disabled={state === 'undoing'}
            onClick={() => void undo()}
            type="button"
          >
            {copy.undo}
          </button>
        </>
      )}
      {state === 'failed' && <span className="block text-destructive">{copy.undoFailed}</span>}
    </p>
  )
}
