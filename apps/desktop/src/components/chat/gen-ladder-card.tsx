'use client'

import { type FC, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import {
  type GenLadderAction,
  type GenLadderCallback,
  genLadderCallback,
  type GenLadderCard as GenLadderCardModel,
  genLadderLocale,
  type GenLadderMedia,
  genLadderSetLanguageCallback,
  type GenLadderStep
} from '@/lib/gen-ladder'
import { AlertTriangle, Check, Globe, ImageIcon, Play, Sparkles } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type GenLadderCopy, genLadderCopy } from './gen-ladder-copy'

// One tap on a card control resolves to the structured callback the agent
// replays plus the human-readable turn shown in the transcript. Kept as a pair
// so the ladder stays deterministic (callback) while reading naturally (message).
export interface GenLadderEvent {
  callback: GenLadderCallback
  message: string
}

export interface GenLadderCardProps {
  card: GenLadderCardModel
  onEvent: (event: GenLadderEvent) => void
  // Externally lock the card (e.g. gateway offline). The card also self-locks
  // after its first action so a priced button can't double-fire.
  disabled?: boolean
}

// A card control → its structured callback + localized transcript message. Pure
// over (action, copy, model) so it is unit-testable without rendering.
export function genLadderEvent(action: GenLadderAction, copy: GenLadderCopy, model?: string): GenLadderEvent {
  const callback = genLadderCallback(action, model ? { model } : {})
  const label = actionLabel(action, copy)
  let message: string

  switch (callback.action) {
    case 'confirm':
      message = copy.confirmMessage(label)

      break

    case 'select':
      message = copy.selectMessage(typeof action.index === 'number' ? action.index : 0)

      break

    case 'start':
      message = copy.startMessage(label)

      break

    case 'acknowledge_rights':
      message = copy.acknowledgeMessage

      break

    case 'restart':
      message = copy.restartMessage

      break

    default:
      message = copy.freeMessage(label)
  }

  return { callback, message }
}

// Localize by stable id, falling back to the server's zh reference text.
function actionLabel(action: GenLadderAction, copy: GenLadderCopy): string {
  return copy.actions[action.id] ?? action.label
}

function stepLabel(step: GenLadderStep, copy: GenLadderCopy): string {
  return copy.steps[step.key] ?? step.label
}

function cardTitle(card: GenLadderCardModel, copy: GenLadderCopy): string | undefined {
  if (card.type && copy.titles[card.type]) {
    return copy.titles[card.type]
  }

  return card.title
}

function cardBody(card: GenLadderCardModel, copy: GenLadderCopy): string | undefined {
  if (card.type && copy.bodies[card.type]) {
    return copy.bodies[card.type]
  }

  return card.body
}

const CARD_SHELL =
  'mt-2 mb-1 max-w-[40rem] rounded-[0.625rem] border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)/40 p-3 text-[length:var(--conversation-tool-font-size)]'

export const GenLadderCard: FC<GenLadderCardProps> = ({ card, onEvent, disabled }) => {
  const copy = useMemo(() => genLadderCopy(genLadderLocale(card.language)), [card.language])
  const [acted, setActed] = useState(false)
  const locked = acted || Boolean(disabled)

  const emit = (event: GenLadderEvent) => {
    if (locked) {
      return
    }

    setActed(true)
    onEvent(event)
  }

  const generating = card.status === 'generating' || card.status === 'reversing'
  const title = cardTitle(card, copy)
  const body = cardBody(card, copy)

  // Forward-compat floor: a card type this build doesn't recognize (a future
  // `gen-ladder/N` shape) still renders its stepper/title/actions generically,
  // but a card with no renderable content at all gets a plain note instead of a
  // blank frame.
  const hasContent = Boolean(
    title ||
      body ||
      card.fields?.length ||
      card.media?.length ||
      card.selected ||
      card.bill ||
      card.gate?.status === 'blocked' ||
      card.type === 'reference_gate' ||
      card.actions?.length
  )

  return (
    <section aria-label={copy.region} className={CARD_SHELL} data-card-type={card.type} data-slot="gen-ladder-card">
      {card.ladder && card.ladder.length > 0 && <Stepper copy={copy} steps={card.ladder} />}

      {title && (
        <h4 className="mt-1.5 flex items-center gap-2 font-medium text-(--ui-text-primary)">
          {generating ? (
            <GlyphSpinner ariaLabel={copy.generating} className="size-3.5 text-(--ui-text-tertiary)" spinner="breathe" />
          ) : (
            <Sparkles className="size-3.5 shrink-0 text-primary" />
          )}
          <span className="min-w-0">{generating ? copy.generating : title}</span>
        </h4>
      )}

      {body && <p className="mt-1.5 text-(--ui-text-tertiary)">{body}</p>}

      {!hasContent && <p className="mt-1.5 text-(--ui-text-tertiary)">{copy.unsupported}</p>}

      {card.fields && card.fields.length > 0 && <PromptFields fields={card.fields} />}

      {card.reference?.more_like_original?.available && (
        <ReferenceFlag copy={copy} on={Boolean(card.reference.more_like_original.value)} />
      )}

      {(card.gate?.status === 'blocked' || card.type === 'reference_gate') && (
        <GateNotice copy={copy} guidance={card.guidance ?? card.gate?.guidance} />
      )}

      <CardMedia card={card} copy={copy} locked={locked} onEvent={emit} />

      {card.bill && <Bill bill={card.bill} copy={copy} />}

      <Actions acted={acted} card={card} copy={copy} locked={locked} onEvent={emit} />

      {card.language_override?.supported && (
        <LanguageSwitch
          copy={copy}
          current={card.language_override.current ?? card.language}
          disabled={locked}
          onPick={language => emit({ callback: genLadderSetLanguageCallback(language), message: copy.setLanguageMessage(language) })}
          options={card.language_override.options}
        />
      )}
    </section>
  )
}

function Stepper({ copy, steps }: { copy: GenLadderCopy; steps: GenLadderStep[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[0.6875rem] text-(--ui-text-tertiary)" data-slot="gen-ladder-stepper">
      {steps.map((step, index) => (
        <li className="flex items-center gap-1" key={step.key}>
          {index > 0 && <span aria-hidden className="text-(--ui-text-tertiary)/60">›</span>}
          <span
            className={cn(
              'rounded-full border border-(--ui-stroke-tertiary) px-2 py-0.5',
              step.status === 'done' && 'text-emerald-600 dark:text-emerald-400',
              step.status === 'current' && 'bg-(--ui-bg-quaternary) font-medium text-(--ui-text-primary)'
            )}
          >
            {step.status === 'done' ? '✓ ' : ''}
            {stepLabel(step, copy)}
          </span>
        </li>
      ))}
    </ol>
  )
}

function PromptFields({ fields }: { fields: NonNullable<GenLadderCardModel['fields']> }) {
  return (
    <dl className="mt-2 grid gap-1" data-slot="gen-ladder-fields">
      {fields.map(field => (
        <div className="flex gap-2" key={field.id}>
          <dt className="w-11 shrink-0 pt-0.5 text-[0.6875rem] text-(--ui-text-tertiary)">{field.label}</dt>
          <dd
            className={cn(
              'min-w-0 flex-1 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)/60 px-2 py-1 text-(--ui-text-secondary)',
              field.highlight && 'border-emerald-500/40 text-(--ui-text-primary)'
            )}
          >
            {String(field.value ?? '')}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ReferenceFlag({ copy, on }: { copy: GenLadderCopy; on: boolean }) {
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-(--ui-text-tertiary)" data-slot="gen-ladder-reference">
      <span
        aria-hidden
        className={cn('inline-block size-2 rounded-full', on ? 'bg-primary' : 'bg-(--ui-stroke-secondary)')}
      />
      <span className="sr-only">{copy.referenceLabel}: </span>
      {copy.moreLikeOriginal}
    </p>
  )
}

function GateNotice({ copy, guidance }: { copy: GenLadderCopy; guidance?: string }) {
  return (
    <p
      className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300"
      data-slot="gen-ladder-gate"
      role="note"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{guidance || copy.gateBlocked}</span>
    </p>
  )
}

// Media dispatch: entry cards get a choice grid (built from their select
// actions), draft-select cards make each thumbnail the select-by-index control,
// every other card just shows its media read-only.
function CardMedia({
  card,
  copy,
  locked,
  onEvent
}: {
  card: GenLadderCardModel
  copy: GenLadderCopy
  locked: boolean
  onEvent: (event: GenLadderEvent) => void
}) {
  if (card.type === 'entry') {
    return <EntryChoices actions={card.actions ?? []} copy={copy} locked={locked} onEvent={onEvent} />
  }

  const media = card.media ?? []

  if (card.type === 'draft_select') {
    const selectActions = (card.actions ?? []).filter(a => a.kind === 'select')

    return (
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-slot="gen-ladder-drafts">
        {media.map((item, index) => {
          const action = selectActions.find(a => a.index === index) ?? selectActions[index]

          return (
            <MediaThumb
              key={item.ref ?? item.url ?? index}
              label={item.label}
              media={item}
              onClick={action && !locked ? () => onEvent(genLadderEvent(action, copy)) : undefined}
              pickLabel={action ? actionLabel(action, copy) : undefined}
            />
          )
        })}
      </div>
    )
  }

  if (card.selected) {
    return (
      <div className="mt-2 max-w-56" data-slot="gen-ladder-selected">
        <MediaThumb label={card.selected.label} media={card.selected} />
      </div>
    )
  }

  if (media.length > 0) {
    return (
      <div className="mt-2 max-w-72" data-slot="gen-ladder-media">
        {media.map((item, index) => (
          <MediaThumb key={item.ref ?? item.url ?? index} label={item.label} media={item} />
        ))}
      </div>
    )
  }

  return null
}

function EntryChoices({
  actions,
  copy,
  locked,
  onEvent
}: {
  actions: GenLadderAction[]
  copy: GenLadderCopy
  locked: boolean
  onEvent: (event: GenLadderEvent) => void
}) {
  if (actions.length === 0) {
    return null
  }

  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-3" data-slot="gen-ladder-entry">
      {actions.map(action => (
        <button
          className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)/60 px-2.5 py-2 text-left transition-colors hover:bg-(--chrome-action-hover) disabled:cursor-not-allowed disabled:opacity-55"
          disabled={locked}
          key={action.id}
          onClick={() => onEvent(genLadderEvent(action, copy))}
          type="button"
        >
          <span className="block text-[0.8125rem] font-medium text-(--ui-text-primary)">{actionLabel(action, copy)}</span>
          {copy.entryDesc[action.id] ?? action.desc ? (
            <span className="mt-0.5 block text-[0.6875rem] text-(--ui-text-tertiary)">
              {copy.entryDesc[action.id] ?? action.desc}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

function MediaThumb({
  label,
  media,
  onClick,
  pickLabel
}: {
  label?: string
  media: GenLadderMedia
  onClick?: () => void
  pickLabel?: string
}) {
  const isVideo = media.kind === 'video'

  const inner = (
    <span className="relative block aspect-video w-full overflow-hidden rounded-md bg-(--ui-bg-quaternary)">
      {media.url && !isVideo ? (
        <img alt={label ?? ''} className="absolute inset-0 size-full object-cover" draggable={false} src={media.url} />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-(--ui-text-tertiary)">
          {isVideo ? <Play className="size-5" /> : <ImageIcon className="size-5" />}
        </span>
      )}
      {label && (
        <span className="absolute inset-x-0 bottom-0 truncate bg-black/45 px-1.5 py-0.5 text-[0.625rem] text-white">
          {label}
        </span>
      )}
    </span>
  )

  if (!onClick) {
    return (
      <span className="block" data-slot="gen-ladder-thumb">
        {inner}
      </span>
    )
  }

  return (
    <button
      aria-label={pickLabel ? `${pickLabel}${label ? ` · ${label}` : ''}` : label}
      className="group block rounded-md text-left ring-primary/40 transition-shadow hover:ring-2 focus-visible:ring-2 focus-visible:outline-none"
      data-slot="gen-ladder-thumb"
      onClick={onClick}
      type="button"
    >
      {inner}
      {pickLabel && <span className="mt-1 block text-[0.6875rem] text-(--ui-text-tertiary)">{pickLabel}</span>}
    </button>
  )
}

function Bill({ bill, copy }: { bill: NonNullable<GenLadderCardModel['bill']>; copy: GenLadderCopy }) {
  return (
    <div className="mt-2.5 grid gap-2 sm:grid-cols-2" data-slot="gen-ladder-bill">
      <div className="rounded-md border border-emerald-500/30 px-2.5 py-1.5">
        <span className="block text-[0.6875rem] text-(--ui-text-tertiary)">{copy.billLadder}</span>
        <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{bill.ladder_total_display}</span>
      </div>
      <div className="rounded-md border border-(--ui-stroke-tertiary) px-2.5 py-1.5">
        <span className="block text-[0.6875rem] text-(--ui-text-tertiary)">{copy.billDirect}</span>
        <span className="text-sm font-medium text-(--ui-text-secondary)">{bill.naive_total_display}</span>
      </div>
      <p className="text-[0.625rem] text-(--ui-text-tertiary) sm:col-span-2">
        {typeof bill.attempts === 'number' ? `${copy.attempts(bill.attempts)} · ` : ''}
        {copy.billNote}
      </p>
    </div>
  )
}

// Priced/free/consent action row. Draft-select `select` actions are rendered by
// the thumbnails, so they are skipped here; everything else lays out as buttons.
function Actions({
  acted,
  card,
  copy,
  locked,
  onEvent
}: {
  acted: boolean
  card: GenLadderCardModel
  copy: GenLadderCopy
  locked: boolean
  onEvent: (event: GenLadderEvent) => void
}) {
  const actions = (card.actions ?? []).filter(action => {
    if (card.type === 'entry') {
      return false
    }

    // Draft thumbnails already carry the per-index select control.
    return !(action.kind === 'select' && typeof action.index === 'number')
  })

  const spendWithModels = actions.find(a => a.kind === 'spend' && a.model_options && a.model_options.length > 0)
  const modelOptions = spendWithModels?.model_options ?? []
  const [model, setModel] = useState<string | undefined>(modelOptions[0])

  if (actions.length === 0) {
    return null
  }

  return (
    <div className="mt-2.5 grid gap-2" data-slot="gen-ladder-actions">
      {modelOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-slot="gen-ladder-models" role="group">
          {modelOptions.map(option => (
            <button
              aria-pressed={model === option}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[0.6875rem] transition-colors',
                model === option
                  ? 'border-primary/40 bg-(--ui-bg-quaternary) font-medium text-(--ui-text-primary)'
                  : 'border-(--ui-stroke-tertiary) text-(--ui-text-tertiary) hover:text-(--ui-text-primary)'
              )}
              disabled={locked}
              key={option}
              onClick={() => setModel(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {actions.map(action => (
          <ActionButton
            action={action}
            copy={copy}
            key={action.id}
            locked={locked}
            model={action === spendWithModels ? model : undefined}
            onEvent={onEvent}
          />
        ))}
        {acted && <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.sending}</span>}
      </div>
    </div>
  )
}

function ActionButton({
  action,
  copy,
  locked,
  model,
  onEvent
}: {
  action: GenLadderAction
  copy: GenLadderCopy
  locked: boolean
  model?: string
  onEvent: (event: GenLadderEvent) => void
}) {
  const label = actionLabel(action, copy)
  const fire = () => onEvent(genLadderEvent(action, copy, model))

  if (action.kind === 'spend') {
    const price = action.price

    return (
      <Button className="gap-1.5" disabled={locked} onClick={fire} size="sm" type="button">
        <span>{label}</span>
        {price?.display && (
          <span className="inline-flex items-center gap-1 text-[0.6875rem] opacity-85" data-slot="gen-ladder-price">
            {price.display}
            {price.estimated && (
              <span
                aria-label={copy.estimatedAria}
                className="rounded-sm bg-white/20 px-1 text-[0.5625rem] uppercase tracking-wide"
                data-estimated="true"
              >
                {copy.estimated}
              </span>
            )}
          </span>
        )}
      </Button>
    )
  }

  if (action.kind === 'confirm_sensitive') {
    return (
      <Button
        className="border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
        disabled={locked}
        onClick={fire}
        size="sm"
        type="button"
        variant="outline"
      >
        <Check className="size-3.5" />
        {label}
      </Button>
    )
  }

  // free (edit / back / restart)
  return (
    <Button disabled={locked} onClick={fire} size="sm" type="button" variant="ghost">
      {label}
    </Button>
  )
}

function LanguageSwitch({
  copy,
  current,
  disabled,
  onPick,
  options
}: {
  copy: GenLadderCopy
  current?: string
  disabled: boolean
  onPick: (language: string) => void
  options?: string[]
}) {
  const langs = options ?? []

  if (langs.length === 0) {
    return null
  }

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-(--ui-stroke-tertiary) pt-2" data-slot="gen-ladder-language">
      <Globe aria-hidden className="size-3 text-(--ui-text-tertiary)" />
      <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.languageLabel}</span>
      {langs.map(lang => (
        <button
          aria-pressed={current === lang}
          className={cn(
            'rounded-full px-2 py-0.5 text-[0.6875rem] transition-colors',
            current === lang
              ? 'bg-(--ui-bg-quaternary) font-medium text-(--ui-text-primary)'
              : 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary) disabled:opacity-55'
          )}
          disabled={disabled || current === lang}
          key={lang}
          onClick={() => onPick(lang)}
          type="button"
        >
          {copy.languageNames[lang] ?? lang}
        </button>
      ))}
    </div>
  )
}
