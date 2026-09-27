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

import { createWorkflowProject } from '../api/adapters'
import type { WorkflowProject } from '../api/types'

interface ProjectCreateDialogProps {
  onCreated: (project: WorkflowProject) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}

/** Creates only a canonical Project. The caller may add the selected Workflow
 * after success; neither this form nor template joining starts a Run. */
export function ProjectCreateDialog({ onCreated, onOpenChange, open }: ProjectCreateDialogProps) {
  const { t } = useI18n()
  const copy = t.businessWorkspace.projects.create
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setName('')
    setObjective('')
    setSubmitting(false)
    setError(false)
    window.setTimeout(() => nameRef.current?.focus(), 0)
  }, [open])

  const submit = async () => {
    const normalizedName = name.trim()
    const normalizedObjective = objective.trim()

    if (!normalizedName || !normalizedObjective || submitting) {
      return
    }

    setSubmitting(true)
    setError(false)

    const result = await createWorkflowProject({ name: normalizedName, objective: normalizedObjective })

    setSubmitting(false)

    if (result.mode === 'created') {
      onOpenChange(false)
      onCreated(result.item)

      return
    }

    setError(true)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-xs font-medium" htmlFor="business-project-name">
            {copy.nameLabel}
            <Input
              id="business-project-name"
              maxLength={200}
              onChange={event => setName(event.target.value)}
              placeholder={copy.namePlaceholder}
              ref={nameRef}
              value={name}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium" htmlFor="business-project-objective">
            {copy.objectiveLabel}
            <Textarea
              className="min-h-24 resize-y"
              id="business-project-objective"
              maxLength={4000}
              onChange={event => setObjective(event.target.value)}
              placeholder={copy.objectivePlaceholder}
              value={objective}
            />
          </label>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {copy.failed}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button
            aria-busy={submitting || undefined}
            disabled={!name.trim() || !objective.trim() || submitting}
            onClick={() => void submit()}
            size="sm"
          >
            {submitting ? copy.creating : copy.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
