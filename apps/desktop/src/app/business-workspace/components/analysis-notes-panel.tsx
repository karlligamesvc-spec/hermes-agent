import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

import type { AnalysisNote } from '../analysis-types'

export function AnalysisNotesPanel({ copy, notes, draft, anchorId, busy, onChange, onSave, onDelete, onJump }: {
  copy: { notes: string; note: string; notePlaceholder: string; selectedAnchor: string; citation: string; deleteNote: string }
  notes: AnalysisNote[]
  draft: string
  anchorId: string | null
  busy: boolean
  onChange: (draft: string) => void
  onSave: () => void
  onDelete: (id: string) => void
  onJump: (id: string) => void
}) {
  return <section className="space-y-3">
    <h3 className="font-medium">{copy.notes}</h3>
    {anchorId && <p className="text-xs text-(--ui-text-secondary)">{copy.selectedAnchor}: {anchorId}</p>}
    <Textarea aria-label={copy.notePlaceholder} onChange={event => onChange(event.target.value)} placeholder={copy.notePlaceholder} value={draft} />
    <Button disabled={busy || !draft.trim()} onClick={onSave} type="button">{copy.note}</Button>
    {notes.map(item => <div className="flex justify-between gap-3 rounded-lg border p-3 text-sm" key={item.id}>
      <div className="min-w-0"><p className="whitespace-pre-wrap break-words">{item.body}</p>
        {item.anchor_id && <Button onClick={() => onJump(item.anchor_id!)} size="inline" type="button" variant="text">{copy.citation} · {item.anchor_id}</Button>}
      </div>
      <Button aria-label={copy.deleteNote} disabled={busy} onClick={() => onDelete(item.id)} size="sm" type="button" variant="ghost">×</Button>
    </div>)}
  </section>
}
