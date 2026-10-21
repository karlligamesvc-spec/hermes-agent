import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useEffect, useState } from 'react'

import { MEMORY_LEDGER_COPY, type MemoryLedgerCopy } from '@/app/memory-ledger/memory-ledger-copy'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Brain } from '@/lib/icons'
import { isSubmitEnter } from '@/lib/ime'
import { type DesktopMemoryEntry, type DesktopMemoryLedger, MEMORY_KINDS, type MemoryKind } from '@/lib/memory-ledger'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import {
  $memoryLedger,
  addMemory,
  editMemory,
  memoryLedgerFor,
  type MemoryWriteOutcome,
  removeMemory,
  syncMemoryLedger
} from '@/store/memory-ledger'
import { useSingleThreadMode } from '@/store/single-thread'

import { CONTROL_TEXT } from './constants'
import { ListRow, SectionHeading } from './primitives'

type Settings = MemoryLedgerCopy['settings']

function outcomeMessage(s: Settings, outcome: MemoryWriteOutcome): null | string {
  if (outcome.ok) {
    return null
  }

  if (outcome.code === 'entry_not_found') {
    return s.gone
  }

  return (outcome.code && s.refusals[outcome.code]) || s.failed
}

/**
 * hc-1016 「它记得什么」: the account's memory ledger (关于你 / 最近发生的), shared
 * by the assistant on this computer and in IM. Every entry can be edited,
 * deleted (for real) and added. Renders nothing outside single-thread product
 * mode (`$singleThreadMode`), so with the switch off, or in 开发者模式, the
 * Personalization page is what it was.
 */
export function MemoryLedgerSettings() {
  const { locale } = useI18n()
  const s = MEMORY_LEDGER_COPY[locale].settings
  const { accountId, status } = useStore($authState)
  const state = useStore($memoryLedger)
  const ledger = memoryLedgerFor(state, accountId)
  const productMode = useSingleThreadMode()

  useEffect(() => {
    if (status === 'signed-in') {
      void syncMemoryLedger(accountId)
    }
  }, [accountId, status])

  if (!productMode || state.accountId !== accountId || !['loading', 'ready', 'unavailable'].includes(state.status)) {
    return null
  }

  return (
    <div className="mt-6" data-memory-ledger-settings="">
      <SectionHeading icon={Brain} title={s.title} />
      <p className="p5-section-intro">{s.intro}</p>
      <p className="p5-section-intro">{s.deleteNote}</p>
      {ledger ? (
        MEMORY_KINDS.map(kind => <KindGroup accountId={accountId} key={kind} kind={kind} ledger={ledger} s={s} />)
      ) : (
        <p className="p5-section-intro" role="status">
          {state.status === 'loading' ? s.loading : s.unavailable}
        </p>
      )}
    </div>
  )
}

function KindGroup({
  accountId,
  kind,
  ledger,
  s
}: {
  accountId: null | string
  kind: MemoryKind
  ledger: DesktopMemoryLedger
  s: Settings
}) {
  const group = s.groups[kind]
  const entries = kind === 'about_you' ? ledger.aboutYou : ledger.recent
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<null | string>(null)

  const run = async (write: () => Promise<MemoryWriteOutcome>): Promise<boolean> => {
    setBusy(true)
    const outcome = await write()
    setBusy(false)
    setMessage(outcomeMessage(s, outcome))

    return outcome.ok
  }

  const add = async () => {
    const text = draft.trim()

    if (!text) {
      setMessage(s.refusals.empty_content)

      return
    }

    if (await run(() => addMemory(accountId, kind, text))) {
      setDraft('')
    }
  }

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isSubmitEnter(event)) {
      event.preventDefault()
      void add()
    }
  }

  return (
    <section className="mt-3.5" data-memory-kind={kind}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-medium">{group.title}</h3>
        <span className="text-xs text-(--ui-text-tertiary)">{group.hint(ledger.limits.recentKeepDays)}</span>
      </div>
      <div className="p5-card p5-rows mt-2">
        {entries.length === 0 && <ListRow title={<span className="text-(--ui-text-tertiary)">{s.empty}</span>} />}
        {entries.map(entry => (
          <EntryRow
            accountId={accountId}
            busy={busy}
            entry={entry}
            key={entry.id}
            limit={ledger.limits.contentMaxChars}
            run={run}
            s={s}
          />
        ))}
        <ListRow
          action={
            <Button disabled={busy} onClick={() => void add()} size="xs" type="button" variant="outline">
              {s.add}
            </Button>
          }
          title={
            <Input
              aria-label={group.placeholder}
              className={cn(CONTROL_TEXT, 'max-w-md')}
              maxLength={ledger.limits.contentMaxChars}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={onKey}
              placeholder={group.placeholder}
              value={draft}
            />
          }
        />
      </div>
      {message && (
        <p className="mt-1.5 text-xs text-destructive" role="alert">
          {message}
        </p>
      )}
    </section>
  )
}

function EntryRow({
  accountId,
  busy,
  entry,
  limit,
  run,
  s
}: {
  accountId: null | string
  busy: boolean
  entry: DesktopMemoryEntry
  limit: number
  run: (write: () => Promise<MemoryWriteOutcome>) => Promise<boolean>
  s: Settings
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)

  const save = async () => {
    const text = draft.trim()

    if (text === entry.content) {
      setEditing(false)

      return
    }

    if (await run(() => editMemory(accountId, entry.id, text))) {
      setEditing(false)
    }
  }

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isSubmitEnter(event)) {
      event.preventDefault()
      void save()
    }

    if (event.key === 'Escape') {
      setDraft(entry.content)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <ListRow
        action={
          <div className="flex gap-1.5">
            <Button disabled={busy} onClick={() => void save()} size="xs" type="button">
              {s.save}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(entry.content)
                setEditing(false)
              }}
              size="xs"
              type="button"
              variant="ghost"
            >
              {s.cancel}
            </Button>
          </div>
        }
        title={
          <Input
            aria-label={s.edit}
            autoFocus
            className={cn(CONTROL_TEXT, 'max-w-md')}
            maxLength={limit}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKey}
            value={draft}
          />
        }
      />
    )
  }

  return (
    <ListRow
      action={
        <div className="flex gap-1.5">
          <Button disabled={busy} onClick={() => setEditing(true)} size="xs" type="button" variant="ghost">
            {s.edit}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run(() => removeMemory(accountId, entry.id))}
            size="xs"
            type="button"
            variant="ghost"
          >
            {s.remove}
          </Button>
        </div>
      }
      title={<span className="wrap-anywhere font-normal">{entry.content}</span>}
    />
  )
}
