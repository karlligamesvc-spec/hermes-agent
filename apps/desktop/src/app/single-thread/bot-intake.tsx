/**
 * hc-1079 (多助手第一期 M3, prototype ⑧ BotIntake): what the empty thread of an
 * assistant the user made says the first time it opens. It greets (APEX already
 * passed on the account, so that is not asked again), asks three cards — what
 * it mainly does, how it talks, which platform, the first platform option being
 * 「跟 APEX 一样」 with the account's own answer — then one centred
 * 「✓ X 记下了：… · 撤销」 line and a closing line.
 *
 * The same cards hc-1063 draws for APEX (first-open.tsx): a tap answers, an
 * answered card folds to the question and the pick, the assistant says a line
 * between cards. Each answer is saved straight away into this assistant's own
 * SOUL.md 「分工」 (store/bot-intake.ts), before its first message, so its
 * first reply already works that way. 撤销 takes the section out again.
 */

import { useStore } from '@nanostores/react'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from 'react'

import { CLARIFY_TEXTAREA_CLASS, KeyBadge, letterFor } from '@/components/assistant-ui/clarify-tool'
import { NOTED_ACTION_CLASS, NotedLine } from '@/components/assistant-ui/thread/memory-noted-line'
import { Textarea } from '@/components/ui/textarea'
import type { DesktopCreatorPlatform } from '@/global'
import { useI18n } from '@/i18n'
import { useSingleThreadFirstOpenCopy } from '@/i18n/single-thread-first-open'
import { isSubmitEnter } from '@/lib/ime'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import {
  $botIntake,
  botIntakeAnswered,
  type BotIntakeRequest,
  loadBotIntake,
  saveBotIntakeAnswers,
  undoBotIntake
} from '@/store/bot-intake'
import { $creatorProfile, creatorProfileFor, loadCreatorProfile } from '@/store/creator-profile'
import { requestGatewayForProfile } from '@/store/gateway'

import { CREATOR_INTAKE_COPY } from '../business-workspace/creator-intake-copy'

import {
  BOT_INTAKE_ROLES,
  BOT_INTAKE_STEPS,
  BOT_INTAKE_STYLES,
  type BotIntakeCopy,
  type BotIntakeStep,
  useBotIntakeCopy
} from './bot-intake-copy'
import { BOT_ROLE_OTHER_MAX_CHARS, type BotIntakeAnswers, cleanRoleOther } from './bot-intake-soul'
import { botRoleWork } from './bot-intake-status'
import { AnsweredCard, CARD_CLASS, FIRST_OPEN_PLATFORMS, OPTION_CLASS } from './first-open'
import { FIRST_OPEN_BUBBLE_CLASS } from './first-open-ideas'

interface Option {
  id: string
  label: string
  patch: BotIntakeAnswers
}

interface Labels {
  copy: BotIntakeCopy
  /** The account's own platform answer; empty when it has none, and then 「跟 APEX 一样」 is not offered. */
  accountPlatforms: DesktopCreatorPlatform[]
  /** Whether that answer has been read: the platform card waits for it, so no option moves under a finger. */
  accountPlatformsKnown: boolean
  platformLabel: (platforms: readonly DesktopCreatorPlatform[]) => string
}

const samePlatforms = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join()

function optionsFor(step: BotIntakeStep, { accountPlatforms, copy, platformLabel }: Labels): Option[] {
  if (step === 'role') {
    return BOT_INTAKE_ROLES.map(id => ({ id, label: copy.roles[id], patch: { role: id, roleOther: undefined } }))
  }

  if (step === 'style') {
    return BOT_INTAKE_STYLES.map(id => ({ id, label: copy.styles[id], patch: { style: id } }))
  }

  const same: Option[] = accountPlatforms.length
    ? [{ id: 'same', label: copy.sameAsApex(platformLabel(accountPlatforms)), patch: { platform: 'same' } }]
    : []

  return [
    ...same,
    ...FIRST_OPEN_PLATFORMS.filter(({ platforms }) => !samePlatforms(platforms, accountPlatforms)).map(
      ({ id, platforms }) => ({ id, label: platformLabel(platforms), patch: { platform: [...platforms] } })
    )
  ]
}

/** What an answered card shows: the letter of the option it matches (none for a typed role) and its words. */
function pickFor(
  step: BotIntakeStep,
  answers: BotIntakeAnswers,
  labels: Labels
): { char: null | string; label: string } {
  if (step === 'role' && answers.role === 'other') {
    return { char: letterFor(BOT_INTAKE_ROLES.length), label: answers.roleOther ?? '' }
  }

  const options = optionsFor(step, labels)

  const index = options.findIndex(({ patch }) =>
    step === 'role'
      ? patch.role === answers.role
      : step === 'style'
        ? patch.style === answers.style
        : patch.platform === 'same'
          ? answers.platform === 'same'
          : Array.isArray(answers.platform) && samePlatforms(patch.platform ?? [], answers.platform)
  )

  if (index >= 0) {
    return { char: letterFor(index), label: options[index].label }
  }

  // 「跟 APEX 一样」 while the account's answer is not read (or was cleared since).
  return answers.platform === 'same'
    ? { char: null, label: labels.copy.sameAsApex(null) }
    : { char: null, label: labels.platformLabel(Array.isArray(answers.platform) ? answers.platform : []) }
}

/** `profiles.*` go to the engine of the assistant being opened, the one its thread runs on. */
function profileRequest(profile: string): BotIntakeRequest {
  return (method, params) => requestGatewayForProfile(profile, method, params)
}

/**
 * The empty thread of assistant `profile`, called `name`. Nothing but the
 * greeting while its record is being read (or when it cannot be), so no card
 * flashes and a profile the roster does not list is asked nothing.
 */
export function BotIntake({ name, profile }: { name: string; profile: string }) {
  const copy = useBotIntakeCopy()
  const { locale } = useI18n()
  const firstOpen = useSingleThreadFirstOpenCopy()
  const intake = CREATOR_INTAKE_COPY[locale]
  const { accountId, status } = useStore($authState)
  const creatorState = useStore($creatorProfile)
  const creator = creatorProfileFor(creatorState, accountId)
  const state = useStore($botIntake)
  const request = useMemo(() => profileRequest(profile), [profile])
  // The answers as they stood when the third card was answered here; 撤销 clears the record but not this.
  const [finished, setFinished] = useState<BotIntakeAnswers | null>(null)

  useEffect(() => {
    setFinished(null)
    void loadBotIntake(request, profile)
  }, [profile, request])

  useEffect(() => {
    if (status === 'signed-in') {
      void loadCreatorProfile(accountId)
    }
  }, [accountId, status])

  const labels: Labels = {
    accountPlatforms: creator?.answers.platforms ?? [],
    accountPlatformsKnown:
      status === 'signed-in'
        ? creatorState.accountId === accountId && ['ready', 'unavailable'].includes(creatorState.status)
        : status !== 'checking',
    copy,
    platformLabel: platforms =>
      samePlatforms(platforms, ['douyin', 'xiaohongshu'])
        ? firstOpen.douyinAndXiaohongshu
        : platforms.map(id => intake.platforms[id]).join(intake.listSeparator)
  }

  const record = state.profile === profile && state.status === 'ready' ? state.record : undefined

  const save = async (answers: BotIntakeAnswers): Promise<boolean> => {
    const saved = await saveBotIntakeAnswers(request, profile, answers, locale)

    if (saved && BOT_INTAKE_STEPS.every(step => botIntakeAnswered(step, answers))) {
      setFinished(answers)
    }

    return saved
  }

  let turns: ReactNode = null

  if (record?.status === 'undone' && !finished) {
    turns = <p className={FIRST_OPEN_BUBBLE_CLASS}>{copy.closingUndone}</p>
  } else if (record !== undefined) {
    turns = (
      <IntakeTurns
        answers={finished ?? record?.answers ?? {}}
        done={Boolean(finished) || record?.status === 'noted'}
        finishedHere={finished !== null}
        labels={labels}
        name={name}
        onSave={save}
        onUndo={() => undoBotIntake(request, profile)}
      />
    )
  }

  return (
    <>
      <p className={FIRST_OPEN_BUBBLE_CLASS}>{copy.greeting(name)}</p>
      {turns}
    </>
  )
}

function IntakeTurns({
  answers,
  done,
  finishedHere,
  labels,
  name,
  onSave,
  onUndo
}: {
  answers: BotIntakeAnswers
  done: boolean
  finishedHere: boolean
  labels: Labels
  name: string
  onSave: (answers: BotIntakeAnswers) => Promise<boolean>
  onUndo: () => Promise<boolean>
}) {
  const { copy } = labels
  const nextStep = done ? null : (BOT_INTAKE_STEPS.find(step => !botIntakeAnswered(step, answers)) ?? null)
  const turns: ReactNode[] = []

  for (const step of BOT_INTAKE_STEPS) {
    if (step === nextStep ? step === 'platform' && !labels.accountPlatformsKnown : !botIntakeAnswered(step, answers)) {
      break
    }

    if (step === 'style') {
      turns.push(
        <p className={FIRST_OPEN_BUBBLE_CLASS} key="ack">
          {copy.roleAck(pickFor('role', answers, labels).label)}
        </p>
      )
    }

    if (step === 'platform') {
      turns.push(
        <p className={FIRST_OPEN_BUBBLE_CLASS} key="last">
          {copy.lastQuestion}
        </p>
      )
    }

    turns.push(
      step === nextStep ? (
        <IntakeCard answers={answers} key={step} labels={labels} onSave={onSave} step={step} />
      ) : (
        <AnsweredCard key={step} pick={pickFor(step, answers, labels)} title={copy.questions[step]} />
      )
    )
  }

  const work = botRoleWork(answers, copy)

  return (
    <>
      <p className={FIRST_OPEN_BUBBLE_CLASS}>{copy.intro}</p>
      {turns}
      {done &&
        (finishedHere ? (
          <IntakeNoted answers={answers} labels={labels} name={name} onUndo={onUndo} work={work} />
        ) : (
          <p className={FIRST_OPEN_BUBBLE_CLASS} data-bot-intake-closing="">
            {copy.closing(work)}
          </p>
        ))}
    </>
  )
}

function IntakeCard({
  answers,
  labels,
  onSave,
  step
}: {
  answers: BotIntakeAnswers
  labels: Labels
  onSave: (answers: BotIntakeAnswers) => Promise<boolean>
  step: BotIntakeStep
}) {
  const { copy } = labels
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState('')
  const options = optionsFor(step, labels)
  const title = copy.questions[step]

  const submit = async (patch: BotIntakeAnswers) => {
    if (saving) {
      return
    }

    setSaving(true)
    setFailed(false)
    // On success this card folds and the next one (or the noted line) follows.
    const saved = await onSave({ ...answers, ...patch })
    setSaving(false)
    setFailed(!saved)
  }

  const handleOtherKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitEnter(event) && !event.shiftKey) {
      event.preventDefault()
      const text = cleanRoleOther(draft)

      if (text) {
        void submit({ role: 'other', roleOther: text })
      }
    }
  }

  return (
    <section aria-label={title} className={CARD_CLASS} data-first-open-card={step}>
      <h3 className="m-0 px-2 pt-0.5 pb-1.5 text-[0.9375rem] font-semibold text-(--ui-text-primary)">
        {title}
        <span className="ms-1.5 text-xs font-normal text-(--ui-text-tertiary)">
          {copy.progress(BOT_INTAKE_STEPS.indexOf(step) + 1, BOT_INTAKE_STEPS.length)}
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
        {step === 'role' && (
          <label className={OPTION_CLASS}>
            <KeyBadge char={letterFor(options.length)} selected={Boolean(draft.trim())} />
            <Textarea
              aria-label={copy.roleOtherPlaceholder}
              className={CLARIFY_TEXTAREA_CLASS}
              disabled={saving}
              maxLength={BOT_ROLE_OTHER_MAX_CHARS}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={handleOtherKey}
              placeholder={copy.roleOtherPlaceholder}
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

function IntakeNoted({
  answers,
  labels,
  name,
  onUndo,
  work
}: {
  answers: BotIntakeAnswers
  labels: Labels
  name: string
  onUndo: () => Promise<boolean>
  work: string
}) {
  const { copy } = labels
  const [state, setState] = useState<'failed' | 'noted' | 'undoing' | 'undone'>('noted')

  const platforms =
    answers.platform === 'same'
      ? labels.accountPlatforms.length
        ? labels.platformLabel(labels.accountPlatforms)
        : copy.sameAsApex(null)
      : labels.platformLabel(answers.platform ?? [])

  const parts = [copy.notedRole(work), answers.style ? copy.styles[answers.style] : '', platforms].filter(Boolean)

  const undo = async () => {
    setState('undoing')
    setState((await onUndo()) ? 'undone' : 'failed')
  }

  return (
    <>
      <div className="flex flex-col items-center" data-first-open-noted={state}>
        <NotedLine
          action={
            (state === 'noted' || state === 'undoing' || state === 'failed') && (
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
          {state === 'undone' ? copy.undone : copy.noted(name, parts)}
        </NotedLine>
      </div>
      <p className={FIRST_OPEN_BUBBLE_CLASS} data-bot-intake-closing="">
        {state === 'undone' ? copy.closingUndone : copy.closing(work)}
      </p>
    </>
  )
}
