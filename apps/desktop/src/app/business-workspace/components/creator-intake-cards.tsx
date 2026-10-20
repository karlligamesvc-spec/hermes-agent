import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useEffect, useState } from 'react'

import {
  ChoiceButton,
  CLARIFY_TEXTAREA_CLASS,
  ClarifyShell,
  KeyBadge,
  letterFor,
  OPTION_ROW_CLASS
} from '@/components/assistant-ui/clarify-tool'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type {
  DesktopCreatorContentType,
  DesktopCreatorIntakeStep,
  DesktopCreatorPainPoint,
  DesktopCreatorPlatform,
  DesktopCreatorProfilePatch
} from '@/global'
import { useI18n } from '@/i18n'
import { Loader2, MessageQuestion } from '@/lib/icons'
import { isSubmitEnter } from '@/lib/ime'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import { $creatorProfile, creatorProfileFor, loadCreatorProfile, saveCreatorProfile } from '@/store/creator-profile'

import { CREATOR_INTAKE_COPY, creatorAnswerSummary, type CreatorIntakeCopy } from '../creator-intake-copy'

export const CREATOR_INTAKE_STEPS: readonly DesktopCreatorIntakeStep[] = ['content_type', 'platforms', 'pain_point']

export const CREATOR_CONTENT_TYPES: readonly Exclude<DesktopCreatorContentType, 'other'>[] = [
  'product_review',
  'knowledge',
  'store_visit',
  'drama',
  'vlog'
]

export const CREATOR_PLATFORMS: readonly DesktopCreatorPlatform[] = [
  'douyin',
  'xiaohongshu',
  'channels',
  'kuaishou',
  'bilibili'
]

export const CREATOR_PAIN_POINTS: readonly DesktopCreatorPainPoint[] = [
  'no_topic',
  'no_script',
  'no_editing',
  'no_traffic',
  'no_shooting'
]

// The cloud keeps "其他（自己写）" to one short line: it lands in every prompt.
export const CREATOR_OTHER_MAX_CHARS = 40

/**
 * hc-991 first-use intake on the Start page: three cards, one at a time, built
 * from the clarify card's shell, rows and letter badges. A tap answers a
 * single-choice card; the platform card is multi-select with Continue; the
 * first card also takes a typed answer. Every card can be skipped, and once
 * the third is answered or skipped nothing more is asked (the cloud records
 * that). The answers go into the account's profile, which every assistant of
 * that account reads; they are edited later in Settings › Personalization.
 */
export function CreatorIntakeCards() {
  const { locale } = useI18n()
  const copy = CREATOR_INTAKE_COPY[locale]
  const { accountId, status } = useStore($authState)
  const profile = creatorProfileFor(useStore($creatorProfile), accountId)
  const [doneLine, setDoneLine] = useState<null | string>(null)

  useEffect(() => {
    if (status === 'signed-in') {
      void loadCreatorProfile(accountId)
    }
  }, [accountId, status])

  // A line for the account that finished here, never carried to another account.
  useEffect(() => setDoneLine(null), [accountId])

  if (doneLine) {
    return (
      <section
        aria-label={copy.region}
        className="flex items-start gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-3 text-sm"
        data-creator-intake="done"
        role="status"
      >
        <p className="m-0 flex-1 text-(--ui-text-primary)">{doneLine}</p>
        <Button onClick={() => setDoneLine(null)} size="xs" type="button" variant="text">
          {copy.dismiss}
        </Button>
      </section>
    )
  }

  const step = profile && !profile.intake.completed ? profile.intake.nextStep : null

  if (!step) {
    return null
  }

  const save = async (patch: DesktopCreatorProfilePatch): Promise<boolean> => {
    const saved = await saveCreatorProfile(accountId, patch)
    const next = creatorProfileFor($creatorProfile.get(), accountId)

    if (saved && next?.intake.completed) {
      const summary = creatorAnswerSummary(copy, next.answers)

      setDoneLine(summary ? copy.done(summary) : copy.doneNothing)
    }

    return saved
  }

  return <IntakeCard copy={copy} key={step} onSave={save} step={step} />
}

function IntakeCard({
  copy,
  onSave,
  step
}: {
  copy: CreatorIntakeCopy
  onSave: (patch: DesktopCreatorProfilePatch) => Promise<boolean>
  step: DesktopCreatorIntakeStep
}) {
  const question = copy.questions[step]
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [platforms, setPlatforms] = useState<DesktopCreatorPlatform[]>([])
  const [draft, setDraft] = useState('')
  const trimmedDraft = draft.trim()

  const submit = async (patch: DesktopCreatorProfilePatch) => {
    if (saving) {
      return
    }

    setSaving(true)
    setFailed(false)

    // On success the next card (or the done line) normally replaces this one.
    const saved = await onSave(patch)

    setSaving(false)
    setFailed(!saved)
  }

  const options: { id: string; label: string; onPick: () => void; selected?: boolean }[] =
    step === 'content_type'
      ? CREATOR_CONTENT_TYPES.map(id => ({
          id,
          label: copy.contentTypes[id],
          onPick: () => void submit({ contentType: id })
        }))
      : step === 'platforms'
        ? CREATOR_PLATFORMS.map(id => ({
            id,
            label: copy.platforms[id],
            onPick: () =>
              setPlatforms(current => (current.includes(id) ? current.filter(p => p !== id) : [...current, id])),
            selected: platforms.includes(id)
          }))
        : CREATOR_PAIN_POINTS.map(id => ({
            id,
            label: copy.painPoints[id],
            onPick: () => void submit({ painPoint: id })
          }))

  const submitOther = () => {
    if (trimmedDraft) {
      void submit({ contentType: 'other', contentTypeOther: trimmedDraft })
    }
  }

  const handleOtherKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitEnter(event) && !event.shiftKey) {
      event.preventDefault()
      submitOther()
    }
  }

  const continueEnabled = step === 'platforms' ? platforms.length > 0 : step === 'content_type' && Boolean(trimmedDraft)
  const index = CREATOR_INTAKE_STEPS.indexOf(step)

  return (
    <section aria-label={copy.region} className="grid gap-3" data-creator-intake={step}>
      <ClarifyShell className="grid gap-2">
        <p className="m-0 text-sm text-(--ui-text-secondary)">{question.lead}</p>
        <div className="flex items-start gap-2">
          <h2 className="m-0 flex-1 text-base font-medium leading-(--conversation-line-height)">{question.title}</h2>
          <span className="shrink-0 text-xs text-(--ui-text-tertiary)">
            {copy.progress(index + 1, CREATOR_INTAKE_STEPS.length)}
          </span>
          <MessageQuestion aria-hidden className="mt-px size-4 shrink-0 text-(--ui-text-tertiary)" />
        </div>

        <div aria-label={question.title} className="grid gap-px" role="group">
          {options.map((option, position) => (
            <ChoiceButton
              char={letterFor(position)}
              choice={option.label}
              disabled={saving}
              key={option.id}
              onClick={option.onPick}
              selected={option.selected}
            />
          ))}
          {step === 'content_type' && (
            <label className={cn(OPTION_ROW_CLASS, 'items-center')}>
              <KeyBadge char={letterFor(options.length)} selected={Boolean(trimmedDraft)} />
              <Textarea
                aria-label={copy.otherPlaceholder}
                className={CLARIFY_TEXTAREA_CLASS}
                disabled={saving}
                maxLength={CREATOR_OTHER_MAX_CHARS}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={handleOtherKey}
                placeholder={copy.otherPlaceholder}
                rows={1}
                size="sm"
                value={draft}
              />
            </label>
          )}
        </div>
      </ClarifyShell>

      <div className="flex flex-wrap items-center gap-2">
        <p
          className={cn('m-0 flex-1 text-xs', failed ? 'text-destructive' : 'text-(--ui-text-tertiary)')}
          role={failed ? 'alert' : saving ? 'status' : undefined}
        >
          {failed ? copy.saveFailed : saving ? copy.saving : question.hint}
        </p>
        <Button disabled={saving} onClick={() => void submit({ skip: [step] })} size="xs" type="button" variant="text">
          {copy.skip}
        </Button>
        {step !== 'pain_point' && (
          <Button
            disabled={saving || !continueEnabled}
            onClick={() =>
              step === 'platforms'
                ? void submit({ platforms: CREATOR_PLATFORMS.filter(id => platforms.includes(id)) })
                : submitOther()
            }
            size="xs"
            type="button"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : copy.continueLabel}
          </Button>
        )}
      </div>
    </section>
  )
}
