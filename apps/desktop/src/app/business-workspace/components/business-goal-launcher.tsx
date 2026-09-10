import { type FormEvent, type KeyboardEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import type { ComposerAttachment } from '@/store/composer'

import { AttachmentList } from '../../chat/composer/attachments'

export interface BusinessGoalLauncherProps {
  attachments?: ComposerAttachment[]
  disabled?: boolean
  draft?: string
  onDraftChange?: (draft: string) => void
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
  onRemoveAttachment?: (id: string) => void
  onSubmit?: (goal: string) => Promise<boolean> | boolean
  submitBlockedReason?: string
}

export const BUSINESS_GOAL_INPUT_ID = 'business-goal-input'
export const BUSINESS_GOAL_BLOCKED_REASON_ID = 'business-goal-blocked-reason'

/** Compact view onto ChatView's existing submit callback. */
export function BusinessGoalLauncher({
  attachments = [],
  disabled = false,
  draft,
  onDraftChange,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onRemoveAttachment,
  onSubmit,
  submitBlockedReason
}: BusinessGoalLauncherProps) {
  const { t } = useI18n()
  const copy = t.businessWorkspace.goalLauncher
  const [localDraft, setLocalDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const controlled = draft !== undefined && onDraftChange !== undefined
  const goal = controlled ? draft : localDraft
  const setGoal = controlled ? onDraftChange : setLocalDraft
  const normalizedGoal = goal.trim()

  const canSubmit = Boolean(onSubmit) && !disabled && !submitting && !submitBlockedReason && normalizedGoal.length > 0

  const canPickAttachment = Boolean(onPickFiles || onPickFolders || onPickImages) && !disabled && !submitting

  const submitGoal = async () => {
    if (!canSubmit || !onSubmit) {
      return
    }

    setSubmitting(true)

    try {
      const accepted = await onSubmit(normalizedGoal)

      if (accepted !== false) {
        setGoal('')
      }
    } catch {
      // The canonical submit path owns user-facing transport errors. Preserve
      // the goal here so the user can retry instead of losing their draft.
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitGoal()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }

    event.preventDefault()
    void submitGoal()
  }

  const removeAttachment = (id: string) => {
    onRemoveAttachment?.(id)
    window.requestAnimationFrame(() => window.document.getElementById(BUSINESS_GOAL_INPUT_ID)?.focus())
  }

  return (
    <form
      className="apex-goal-launcher pointer-events-auto w-full rounded-2xl border border-transparent p-3 text-left transition-[border-color,box-shadow]"
      data-business-goal-launcher=""
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor={BUSINESS_GOAL_INPUT_ID}>
        {copy.label}
      </label>
      {attachments.length > 0 && <AttachmentList attachments={attachments} onRemove={removeAttachment} />}
      <textarea
        aria-describedby={submitBlockedReason ? BUSINESS_GOAL_BLOCKED_REASON_ID : undefined}
        aria-label={copy.label}
        autoCapitalize="sentences"
        autoComplete="off"
        autoCorrect="on"
        className="block min-h-[3rem] w-full resize-none border-0 bg-transparent p-0 text-[0.9375rem] leading-6 text-foreground outline-none placeholder:text-(--ui-text-tertiary) disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || submitting}
        id={BUSINESS_GOAL_INPUT_ID}
        onChange={event => setGoal(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={copy.placeholder}
        rows={2}
        spellCheck
        value={goal}
      />
      {submitBlockedReason && (
        <p
          className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200"
          id={BUSINESS_GOAL_BLOCKED_REASON_ID}
          role="alert"
        >
          {submitBlockedReason}
        </p>
      )}
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="sr-only">{copy.hint}</span>
        <Button
          aria-busy={submitting}
          aria-describedby={submitBlockedReason ? BUSINESS_GOAL_BLOCKED_REASON_ID : undefined}
          aria-label={copy.submit}
          className="order-2 ml-auto rounded-full"
          disabled={!canSubmit}
          size="icon"
          type="submit"
        >
          <Codicon name={submitting ? 'loading' : 'send'} size="0.875rem" spinning={submitting} />
        </Button>
        <div className="order-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t.composer.attachLabel}
                disabled={!canPickAttachment}
                size="icon-sm"
                title={t.composer.attachLabel}
                type="button"
                variant="ghost"
              >
                <Codicon name="add" size="0.875rem" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuItem disabled={!onPickFiles} onSelect={() => onPickFiles?.()}>
                <Codicon name="file" size="0.875rem" />
                {t.composer.files}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!onPickFolders} onSelect={() => onPickFolders?.()}>
                <Codicon name="folder-opened" size="0.875rem" />
                {t.composer.folder}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!onPickImages} onSelect={() => onPickImages?.()}>
                <Codicon name="file-media" size="0.875rem" />
                {t.composer.images}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </form>
  )
}
