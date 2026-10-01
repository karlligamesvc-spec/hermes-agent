import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'

import { updateWorkflowProject } from '../api/adapters'
import type { WorkflowProject } from '../api/types'

interface ProjectEditDialogProps {
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  open: boolean
  project: WorkflowProject
}

export function ProjectEditDialog({ onOpenChange, onSaved, open, project }: ProjectEditDialogProps) {
  const { t } = useI18n()
  const copy = t.businessWorkspace.projects
  const [name, setName] = useState(project.name)
  const [objective, setObjective] = useState(project.objective || '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setName(project.name)
    setObjective(project.objective || '')
    setFailed(false)
    window.setTimeout(() => nameRef.current?.focus(), 0)
  }, [open, project.id, project.name, project.objective])

  const save = async () => {
    if (!name.trim() || saving) {
      return
    }

    setSaving(true)
    setFailed(false)
    const result = await updateWorkflowProject({ name: name.trim(), objective: objective.trim(), projectId: project.id })
    setSaving(false)

    if (result.mode === 'updated') {
      onOpenChange(false)
      onSaved()

      return
    }

    setFailed(true)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{copy.edit.title}</DialogTitle>
          <DialogDescription>{copy.edit.description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-xs font-medium" htmlFor="business-project-edit-name">
            {copy.create.nameLabel}
            <Input
              id="business-project-edit-name"
              maxLength={200}
              onChange={event => setName(event.target.value)}
              ref={nameRef}
              value={name}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium" htmlFor="business-project-edit-objective">
            {copy.create.objectiveLabel}
            <Textarea
              className="min-h-24 resize-y"
              id="business-project-edit-objective"
              maxLength={4000}
              onChange={event => setObjective(event.target.value)}
              value={objective}
            />
          </label>
          {failed && <p className="text-xs text-destructive" role="alert">{copy.edit.failed}</p>}
        </div>
        <DialogFooter>
          <Button disabled={saving} onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button aria-busy={saving || undefined} disabled={!name.trim() || saving} onClick={() => void save()} size="sm">
            {saving ? copy.edit.saving : copy.edit.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
