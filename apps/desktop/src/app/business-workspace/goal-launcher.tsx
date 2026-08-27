import { type FormEvent, type KeyboardEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

export interface BusinessGoalLauncherProps {
  disabled?: boolean
  draft?: string
  onDraftChange?: (draft: string) => void
  onSubmit?: (goal: string) => Promise<boolean> | boolean
}

export const BUSINESS_GOAL_INPUT_ID = 'business-goal-input'

/**
 * Goal-first entrance for the business Start zero state.
 *
 * This is only a second view onto ChatView's existing submit callback. It does
 * not create a Project, Workflow, Run, or parallel message transport. The
 * docked Composer stays mounted below with its full attachment/model/voice
 * controls; this compact entrance exists for the prototype's primary
 * "describe the outcome and start" path.
 */
export function BusinessGoalLauncher({ disabled = false, draft, onDraftChange, onSubmit }: BusinessGoalLauncherProps) {
  const { t } = useI18n()
  const copy = t.businessWorkspace.goalLauncher
  const [localDraft, setLocalDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const controlled = draft !== undefined && onDraftChange !== undefined
  const goal = controlled ? draft : localDraft
  const setGoal = controlled ? onDraftChange : setLocalDraft
  const normalizedGoal = goal.trim()
  const canSubmit = Boolean(onSubmit) && !disabled && !submitting && normalizedGoal.length > 0

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

  return (
    <form
      className="pointer-events-auto w-full rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-4 text-left shadow-(--shadow-composer) transition-[border-color,box-shadow] focus-within:border-primary/45"
      data-business-goal-launcher=""
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor={BUSINESS_GOAL_INPUT_ID}>
        {copy.label}
      </label>
      <textarea
        aria-label={copy.label}
        autoCapitalize="sentences"
        autoComplete="off"
        autoCorrect="on"
        className="block min-h-16 w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 text-foreground outline-none placeholder:text-(--ui-text-tertiary) disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || submitting}
        id={BUSINESS_GOAL_INPUT_ID}
        onChange={event => setGoal(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={copy.placeholder}
        rows={3}
        spellCheck
        value={goal}
      />
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-(--ui-stroke-tertiary) pt-3">
        <span className="text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{copy.hint}</span>
        <Button aria-label={copy.submit} disabled={!canSubmit} size="icon-sm" type="submit">
          <Codicon name={submitting ? 'loading' : 'send'} size="0.875rem" spinning={submitting} />
        </Button>
      </div>
    </form>
  )
}
