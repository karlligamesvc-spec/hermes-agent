import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
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
import { pickProjectFolder } from '@/store/projects'

import { createWorkflowProject } from '../api/adapters'
import type { WorkflowProject } from '../api/types'

interface ProjectCreateDialogProps {
  onCreated: (project: WorkflowProject) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}

/** Creates an honest, initially empty workflow-domain Project. A Workflow and
 * Run are only added after the user explicitly chooses a path from the project
 * detail, so the dialog never fabricates progress or silently starts work. */
export function ProjectCreateDialog({ onCreated, onOpenChange, open }: ProjectCreateDialogProps) {
  const { t } = useI18n()
  const copy = t.businessWorkspace.projects.create
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setName('')
    setObjective('')
    setLocalPath('')
    setSubmitting(false)
    setError(false)
    window.setTimeout(() => nameRef.current?.focus(), 0)
  }, [open])

  const chooseFolder = async () => {
    const path = await pickProjectFolder()

    if (path) {
      setLocalPath(path)
    }
  }

  const submit = async () => {
    const normalizedName = name.trim()
    const normalizedObjective = objective.trim()

    if (!normalizedName || !normalizedObjective || submitting) {
      return
    }

    setSubmitting(true)
    setError(false)

    const result = await createWorkflowProject({
      ...(localPath ? { localPath } : {}),
      name: normalizedName,
      objective: normalizedObjective
    })

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
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">{copy.folderLabel}</span>
            <div className="flex min-w-0 items-center gap-2">
              <Button onClick={() => void chooseFolder()} size="sm" type="button" variant="outline">
                <Codicon name="folder-opened" size="0.875rem" />
                {copy.chooseFolder}
              </Button>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={localPath}>
                {localPath || copy.folderOptional}
              </span>
            </div>
          </div>
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
