import { useStore } from '@nanostores/react'
import { type FormEvent, type KeyboardEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { type ComposerAttachment, requestVoiceConversationStart } from '@/store/composer'
import { $toolViewMode } from '@/store/tool-view'

import { AttachmentList } from '../../chat/composer/attachments'
import { SEND_ICON_BTN } from '../../chat/composer/control-classes'
import { ModelPill } from '../../chat/composer/model-pill'
import { DraftPasteActions } from '../../chat/composer/paste-action-chips'
import { notePastedText } from '../../chat/composer/paste-actions'
import { StartVoiceButton } from '../../chat/composer/start-voice-button'
import type { ChatBarState } from '../../chat/composer/types'

import { GoalLauncherAddMenu, type GoalLauncherWorkflow } from './goal-launcher-add-menu'

export interface BusinessGoalLauncherProps {
  attachments?: ComposerAttachment[]
  disabled?: boolean
  draft?: string
  model?: ChatBarState['model']
  onDraftChange?: (draft: string) => void
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
  onRemoveAttachment?: (id: string) => void
  onSubmit?: (goal: string) => Promise<boolean> | boolean
  submitBlockedReason?: string
  /** The workflow choice: a footer button in developer mode, the "+" menu's
   *  高级 row otherwise. */
  workflow?: GoalLauncherWorkflow
}

export const BUSINESS_GOAL_INPUT_ID = 'business-goal-input'
export const BUSINESS_GOAL_BLOCKED_REASON_ID = 'business-goal-blocked-reason'

/** This input's paste-to-act key (the chat composers use their focus target). */
const PASTE_KEY = 'business-start'

/** Compact view onto ChatView's existing submit callback. */
export function BusinessGoalLauncher({
  attachments = [],
  disabled = false,
  draft,
  model,
  onDraftChange,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onRemoveAttachment,
  onSubmit,
  submitBlockedReason,
  workflow
}: BusinessGoalLauncherProps) {
  const { t } = useI18n()
  const copy = t.businessWorkspace.goalLauncher
  const developer = useStore($toolViewMode) === 'technical'
  const [localDraft, setLocalDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const controlled = draft !== undefined && onDraftChange !== undefined
  const goal = controlled ? draft : localDraft
  const setGoal = controlled ? onDraftChange : setLocalDraft
  const normalizedGoal = goal.trim()
  const inputLocked = disabled || submitting

  const canSubmit = Boolean(onSubmit) && !inputLocked && !submitBlockedReason && normalizedGoal.length > 0

  // A paste-to-act chip sends its own request in place of the typed goal (a
  // dropped video needs no typed words first).
  const submitGoal = async (text: string = normalizedGoal) => {
    if (!onSubmit || inputLocked || submitBlockedReason || !text.trim()) {
      return
    }

    setSubmitting(true)

    try {
      const accepted = await onSubmit(text.trim())

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
      className="apex-goal-launcher apex-composer-surface pointer-events-auto w-full rounded-2xl border border-transparent p-4 text-left transition-[border-color,box-shadow]"
      data-business-goal-launcher=""
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor={BUSINESS_GOAL_INPUT_ID}>
        {copy.label}
      </label>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden">
        <DraftPasteActions
          attachments={attachments}
          disabled={inputLocked || !onSubmit || Boolean(submitBlockedReason)}
          draft={goal}
          onSend={request => void submitGoal(request)}
          pasteKey={PASTE_KEY}
        />
      </div>
      {attachments.length > 0 && <AttachmentList attachments={attachments} onRemove={removeAttachment} />}
      <textarea
        aria-describedby={submitBlockedReason ? BUSINESS_GOAL_BLOCKED_REASON_ID : undefined}
        aria-label={copy.label}
        autoCapitalize="sentences"
        autoComplete="off"
        autoCorrect="on"
        className="block min-h-[7rem] w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[0.9375rem] leading-6 text-foreground outline-none placeholder:text-(--ui-text-tertiary) disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-[8rem]"
        data-slot="business-goal-input"
        disabled={inputLocked}
        id={BUSINESS_GOAL_INPUT_ID}
        onChange={event => setGoal(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={event => notePastedText(PASTE_KEY, event.clipboardData.getData('text'))}
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
      <div className="mt-1 flex items-center gap-3" data-business-goal-footer="">
        <span className="sr-only">{copy.hint}</span>
        <Button
          aria-busy={submitting}
          aria-describedby={submitBlockedReason ? BUSINESS_GOAL_BLOCKED_REASON_ID : undefined}
          aria-label={copy.submit}
          className={`order-4 ${SEND_ICON_BTN}`}
          disabled={!canSubmit}
          size="icon"
          type="submit"
        >
          <Codicon name={submitting ? 'loading' : 'send'} size="0.875rem" spinning={submitting} />
        </Button>
        <div className="order-1">
          <GoalLauncherAddMenu
            disabled={inputLocked}
            pickers={{ onPickFiles, onPickFolders, onPickImages }}
            workflow={developer ? undefined : workflow}
          />
        </div>
        {developer && workflow && (
          <div className="order-2 min-w-0" data-start-workflow-selection="">
            <Button disabled={workflow.disabled} onClick={workflow.onChoose} size="inline" type="button" variant="text">
              <Codicon name="workflow" size="0.875rem" />
              <span className="truncate">{workflow.label}</span>
            </Button>
          </div>
        )}
        {model && (
          <div className="order-2 ml-auto min-w-0">
            <ModelPill disabled={inputLocked || !model.canSwitch} model={model} />
          </div>
        )}
        <div className={`order-3 ${model ? '' : 'ml-auto'}`}>
          <StartVoiceButton disabled={inputLocked} label={t.composer.startVoice} onStart={requestVoiceConversationStart} />
        </div>
      </div>
    </form>
  )
}
