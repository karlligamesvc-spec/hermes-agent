/**
 * hc-1063 (prototype v2 「第一次打开」): the empty single thread reads as the
 * start of a conversation. APEX greets (and says its name can be changed),
 * asks the hc-991 intake questions as cards inside the chat — a tap answers,
 * an answered card folds to the question and the pick, APEX says a line
 * between cards — then one centred 「✓ APEX 记下了：… · 撤销」 line, today's
 * ideas (only when `desktop_features.daily_ideas` is on) and a closing tip.
 *
 * The answers are the account's creator profile, the same ids the Start page
 * cards and Settings › 个性化 write, so the cloud's prompts and today's ideas
 * read them unchanged. 撤销 clears the three answers for real; the cloud keeps
 * the intake finished (its `completed_at` is never cleared), so the cards do
 * not come back.
 */

import { useStore } from '@nanostores/react'
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'

import { CLARIFY_TEXTAREA_CLASS, KeyBadge, letterFor } from '@/components/assistant-ui/clarify-tool'
import { NOTED_ACTION_CLASS, NotedLine } from '@/components/assistant-ui/thread/memory-noted-line'
import { Textarea } from '@/components/ui/textarea'
import type {
  DesktopCreatorIntakeStep,
  DesktopCreatorPainPoint,
  DesktopCreatorPlatform,
  DesktopCreatorProfile,
  DesktopCreatorProfilePatch
} from '@/global'
import { useI18n } from '@/i18n'
import { useSingleThreadChatCopy } from '@/i18n/single-thread-chat'
import { type SingleThreadFirstOpenCopy, useSingleThreadFirstOpenCopy } from '@/i18n/single-thread-first-open'
import { isSubmitEnter } from '@/lib/ime'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import { $creatorProfile, creatorProfileFor, loadCreatorProfile, saveCreatorProfile } from '@/store/creator-profile'

import {
  CREATOR_CONTENT_TYPES,
  CREATOR_INTAKE_STEPS,
  CREATOR_OTHER_MAX_CHARS
} from '../business-workspace/components/creator-intake-cards'
import { CREATOR_INTAKE_COPY, type CreatorIntakeCopy } from '../business-workspace/creator-intake-copy'

import { FIRST_OPEN_BUBBLE_CLASS, FirstOpenIdeas } from './first-open-ideas'

type Answers = DesktopCreatorProfile['answers']

/** The platform card answers in one tap, so 「抖音和小红书都发」 stands in for picking two. */
export const FIRST_OPEN_PLATFORMS: readonly { id: string; platforms: readonly DesktopCreatorPlatform[] }[] = [
  { id: 'douyin', platforms: ['douyin'] },
  { id: 'xiaohongshu', platforms: ['xiaohongshu'] },
  { id: 'channels', platforms: ['channels'] },
  { id: 'douyin_xiaohongshu', platforms: ['douyin', 'xiaohongshu'] },
  { id: 'kuaishou', platforms: ['kuaishou'] },
  { id: 'bilibili', platforms: ['bilibili'] }
]

/** The prototype's order; every id the cloud knows is offered. */
export const FIRST_OPEN_PAIN_POINTS: readonly DesktopCreatorPainPoint[] = [
  'no_topic',
  'no_traffic',
  'no_editing',
  'no_script',
  'no_shooting'
]

const CARD_CLASS =
  'flex w-[28.75rem] max-w-full flex-col gap-0.5 self-start rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-3.5 py-3'

const OPTION_CLASS =
  'flex w-full items-center gap-2.5 rounded-[0.625rem] px-2 py-1.5 text-left text-[0.90625rem] text-(--ui-text-primary)'

interface Option {
  id: string
  label: string
  patch: DesktopCreatorProfilePatch
}

interface Labels {
  copy: SingleThreadFirstOpenCopy
  intake: CreatorIntakeCopy
}

function optionsFor(step: DesktopCreatorIntakeStep, { copy, intake }: Labels): Option[] {
  if (step === 'content_type') {
    return CREATOR_CONTENT_TYPES.map(id => ({ id, label: intake.contentTypes[id], patch: { contentType: id } }))
  }

  if (step === 'platforms') {
    return FIRST_OPEN_PLATFORMS.map(({ id, platforms }) => ({
      id,
      label: platforms.length > 1 ? copy.douyinAndXiaohongshu : intake.platforms[platforms[0]],
      patch: { platforms: [...platforms] }
    }))
  }

  return FIRST_OPEN_PAIN_POINTS.map(id => ({ id, label: copy.painPoints[id], patch: { painPoint: id } }))
}

function answered(step: DesktopCreatorIntakeStep, answers: Answers): boolean {
  return step === 'content_type'
    ? Boolean(answers.contentType)
    : step === 'platforms'
      ? answers.platforms.length > 0
      : Boolean(answers.painPoint)
}

/** What an answered card shows: the letter of the option it matches (none for a mix made in Settings) and its words. */
function pickFor(
  step: DesktopCreatorIntakeStep,
  answers: Answers,
  labels: Labels
): { char: null | string; label: string } {
  const options = optionsFor(step, labels)

  const index = options.findIndex(option =>
    step === 'content_type'
      ? option.patch.contentType === answers.contentType
      : step === 'platforms'
        ? [...(option.patch.platforms ?? [])].sort().join() === [...answers.platforms].sort().join()
        : option.patch.painPoint === answers.painPoint
  )

  if (index >= 0) {
    return { char: letterFor(index), label: options[index].label }
  }

  if (step === 'content_type') {
    return { char: letterFor(options.length), label: answers.contentTypeOther ?? '' }
  }

  return {
    char: null,
    label: answers.platforms.map(id => labels.intake.platforms[id]).join(labels.intake.listSeparator)
  }
}

/**
 * The empty thread: greeting, the intake while it is open (or the answers it
 * got), and once it is settled today's ideas and the tip. Nothing but the
 * greeting while the profile is still being read, so no card flashes.
 */
export function FirstOpen() {
  const copy = useSingleThreadFirstOpenCopy()
  const { assistantName, greeting } = useSingleThreadChatCopy()
  const intake = CREATOR_INTAKE_COPY[useI18n().locale]
  const { accountId, status } = useStore($authState)
  const state = useStore($creatorProfile)
  const profile = creatorProfileFor(state, accountId)
  // The answers as they stood when the third card was answered here; 撤销 clears the profile but not this.
  const [finished, setFinished] = useState<Answers | null>(null)

  useEffect(() => {
    if (status === 'signed-in') {
      void loadCreatorProfile(accountId)
    }
  }, [accountId, status])

  useEffect(() => setFinished(null), [accountId])

  // Still checking the sign-in counts as not known yet: the tip must not show and then give way to a card.
  const signedOut = status !== 'signed-in' && status !== 'checking'
  const noIntake = signedOut || (state.accountId === accountId && state.status === 'unavailable')
  const settled = noIntake || Boolean(profile?.intake.completed)

  const save = async (patch: DesktopCreatorProfilePatch): Promise<boolean> => {
    const saved = await saveCreatorProfile(accountId, patch)
    const next = creatorProfileFor($creatorProfile.get(), accountId)

    if (saved && next?.intake.completed) {
      setFinished(next.answers)
    }

    return saved
  }

  return (
    <>
      <p className={FIRST_OPEN_BUBBLE_CLASS}>{copy.greeting(greeting)}</p>
      {profile && (
        <IntakeTurns
          answers={finished ?? profile.answers}
          finishedHere={finished !== null}
          labels={{ copy, intake }}
          name={assistantName}
          nextStep={profile.intake.completed ? null : profile.intake.nextStep}
          onSave={save}
        />
      )}
      {settled && (
        <>
          <FirstOpenIdeas />
          <p className={FIRST_OPEN_BUBBLE_CLASS} data-first-open-tip="">
            {copy.tip}
          </p>
        </>
      )}
    </>
  )
}

function IntakeTurns({
  answers,
  finishedHere,
  labels,
  name,
  nextStep,
  onSave
}: {
  answers: Answers
  finishedHere: boolean
  labels: Labels
  name: string
  nextStep: DesktopCreatorIntakeStep | null
  onSave: (patch: DesktopCreatorProfilePatch) => Promise<boolean>
}) {
  const { copy } = labels
  // A step shows answered, or as the one card waiting; a skipped step shows nothing.
  const shown = CREATOR_INTAKE_STEPS.filter(step => answered(step, answers) || step === nextStep)

  if (shown.length === 0) {
    return null
  }

  const turns: ReactNode[] = []

  shown.forEach((step, position) => {
    const before = shown[position - 1]

    if (before === 'content_type' && answered(before, answers)) {
      turns.push(
        <p className={FIRST_OPEN_BUBBLE_CLASS} key="ack">
          {copy.contentTypeAck(pickFor(before, answers, labels).label)}
        </p>
      )
    }

    if (step === 'pain_point' && position > 0) {
      turns.push(
        <p className={FIRST_OPEN_BUBBLE_CLASS} key="last">
          {copy.lastQuestion}
        </p>
      )
    }

    turns.push(
      step === nextStep ? (
        <IntakeCard key={step} labels={labels} onSave={onSave} step={step} />
      ) : (
        <AnsweredCard key={step} pick={pickFor(step, answers, labels)} title={copy.questions[step]} />
      )
    )
  })

  return (
    <>
      <p className={FIRST_OPEN_BUBBLE_CLASS}>{copy.intro}</p>
      {turns}
      {finishedHere && <IntakeNoted answers={answers} labels={labels} name={name} />}
    </>
  )
}

function AnsweredCard({ pick, title }: { pick: { char: null | string; label: string }; title: string }) {
  return (
    <section aria-label={title} className={CARD_CLASS} data-first-open-card="answered">
      <h3 className="m-0 px-2 pt-0.5 pb-1.5 text-[0.84375rem] font-medium text-(--ui-text-secondary)">{title}</h3>
      <p className={cn(OPTION_CLASS, 'm-0')}>
        {pick.char && <KeyBadge char={pick.char} selected />}
        <span className="min-w-0 flex-1 wrap-anywhere">{pick.label}</span>
      </p>
    </section>
  )
}

function IntakeCard({
  labels,
  onSave,
  step
}: {
  labels: Labels
  onSave: (patch: DesktopCreatorProfilePatch) => Promise<boolean>
  step: DesktopCreatorIntakeStep
}) {
  const { copy } = labels
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState('')
  const options = optionsFor(step, labels)
  const title = copy.questions[step]

  const submit = async (patch: DesktopCreatorProfilePatch) => {
    if (saving) {
      return
    }

    setSaving(true)
    setFailed(false)
    // On success this card folds and the next one (or the noted line) follows.
    const saved = await onSave(patch)
    setSaving(false)
    setFailed(!saved)
  }

  const handleOtherKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitEnter(event) && !event.shiftKey) {
      event.preventDefault()
      const text = draft.trim()

      if (text) {
        void submit({ contentType: 'other', contentTypeOther: text })
      }
    }
  }

  return (
    <section aria-label={title} className={CARD_CLASS} data-first-open-card={step}>
      <h3 className="m-0 px-2 pt-0.5 pb-1.5 text-[0.9375rem] font-semibold text-(--ui-text-primary)">
        {title}
        <span className="ms-1.5 text-xs font-normal text-(--ui-text-tertiary)">
          {copy.progress(CREATOR_INTAKE_STEPS.indexOf(step) + 1, CREATOR_INTAKE_STEPS.length)}
        </span>
      </h3>
      <div aria-label={title} className="grid gap-px" role="group">
        {options.map((option, position) => (
          <button
            className={cn(
              OPTION_CLASS,
              'hover:bg-(--chrome-action-hover) disabled:cursor-not-allowed disabled:opacity-60'
            )}
            disabled={saving}
            key={option.id}
            onClick={() => void submit(option.patch)}
            type="button"
          >
            <KeyBadge char={letterFor(position)} selected={false} />
            <span className="min-w-0 flex-1 wrap-anywhere">{option.label}</span>
          </button>
        ))}
        {step === 'content_type' && (
          <label className={OPTION_CLASS}>
            <KeyBadge char={letterFor(options.length)} selected={Boolean(draft.trim())} />
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
      {(saving || failed) && (
        <p
          className={cn('m-0 px-2 pt-1 text-xs', failed ? 'text-destructive' : 'text-(--ui-text-tertiary)')}
          role={failed ? 'alert' : 'status'}
        >
          {failed ? copy.saveFailed : copy.saving}
        </p>
      )}
    </section>
  )
}

function IntakeNoted({ answers, labels, name }: { answers: Answers; labels: Labels; name: string }) {
  const { copy } = labels
  const { accountId } = useStore($authState)
  const [state, setState] = useState<'failed' | 'noted' | 'undoing' | 'undone'>('noted')

  const parts = CREATOR_INTAKE_STEPS.filter(step => answered(step, answers)).map(step => {
    const { label } = pickFor(step, answers, labels)

    return step === 'pain_point' ? copy.notedPainPoint(label) : label
  })

  if (parts.length === 0) {
    return null
  }

  const undo = async () => {
    setState('undoing')

    const cleared = await saveCreatorProfile(accountId, {
      contentType: null,
      contentTypeOther: null,
      painPoint: null,
      platforms: []
    })

    setState(cleared ? 'undone' : 'failed')
  }

  return (
    <div className="flex flex-col items-center" data-first-open-noted={state}>
      <NotedLine
        action={
          (state === 'noted' || state === 'undoing') && (
            <button
              className={NOTED_ACTION_CLASS}
              disabled={state === 'undoing'}
              onClick={() => void undo()}
              type="button"
            >
              {copy.undo}
            </button>
          )
        }
        checked={state !== 'undone'}
        error={state === 'failed' ? copy.undoFailed : null}
      >
        {state === 'undone' ? copy.undone(parts.length) : copy.noted(name, parts)}
      </NotedLine>
    </div>
  )
}
