import { useAuiState, useComposerRuntime } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'

import { composerFloatingPill } from '@/components/chat/composer-dock'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useComposerSimpleCopy } from '@/i18n/composer-simple'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'
import { useSingleThreadMode } from '@/store/single-thread'

import {
  detectShortVideoLink,
  PASTE_ACTIONS,
  type PasteActionId,
  pasteActionRequest,
  type PasteActionSource,
  pasteActionSource,
  type PasteActionTarget,
  pastedTextFor,
  TRIM_ACTIONS,
  type TrimActionId,
  trimActionRequest
} from './paste-actions'
import { useComposerScope } from './scope'

const ICONS: Record<PasteActionId, string> = {
  breakdown: 'flame',
  remake: 'device-camera-video',
  remix: 'pencil',
  transcribe: 'note'
}

const TRIM_ICONS: Record<TrimActionId, string> = {
  compare: 'search',
  subtitles: 'text-size',
  trim: 'wand'
}

interface Chip<T extends string> {
  icon: string
  id: T
  label: string
  /** The whole request, for a label the row had to cut short. */
  tip: string
}

function ChipRow<T extends string>({
  chips,
  disabled,
  group,
  onPick
}: {
  chips: readonly Chip<T>[]
  disabled: boolean
  group: string
  onPick: (id: T) => void
}) {
  return (
    <div aria-label={group} className="flex max-w-full min-w-0 gap-1.5" data-slot="composer-paste-actions" role="group">
      {chips.map(chip => (
        <Tip key={chip.id} label={chip.tip}>
          <button
            className={cn(
              composerFloatingPill,
              'max-w-56 min-w-0 shrink disabled:cursor-not-allowed disabled:opacity-50'
            )}
            data-paste-action={chip.id}
            disabled={disabled}
            onClick={() => {
              triggerHaptic('selection')
              onPick(chip.id)
            }}
            type="button"
          >
            <Codicon className="shrink-0 opacity-70" name={chip.icon} size="0.75rem" />
            <span className="truncate">{chip.label}</span>
          </button>
        </Tip>
      ))}
    </div>
  )
}

/**
 * The four paste-to-act chips, on one row: on a narrow window they shrink and
 * cut their labels (the tooltip still says the whole request) instead of
 * wrapping into a second row that would cover more of the thread (hc-1137).
 * No dismiss control, like the suggestion pills
 * beside them: the chips live exactly as long as their link sits in the draft
 * (or their video among the attachments), and typing past them is the way to
 * ignore them. A 视频号 link gets a line saying to save the video and drag it
 * in instead; once that video lands, the chips act on it. A lone video in
 * single-thread product mode gets the three trim chips (hc-1156).
 */
export function PasteActionChips({
  disabled,
  onPick,
  onTrim,
  source
}: {
  disabled: boolean
  onPick: (action: PasteActionId, target: PasteActionTarget) => void
  onTrim: (action: TrimActionId) => void
  source: null | PasteActionSource
}) {
  const copy = useComposerSimpleCopy().paste

  if (!source) {
    return null
  }

  if (source.kind === 'save-first') {
    return (
      <div
        className="inline-flex min-h-(--composer-control-size) max-w-full items-center gap-1.5 rounded-full border border-border/65 bg-(--composer-fill) px-2.5 text-xs text-(--ui-text-secondary) backdrop-blur-[0.75rem]"
        data-slot="composer-paste-hint"
        role="status"
      >
        <Codicon className="shrink-0 opacity-70" name="info" size="0.75rem" />
        <span>{copy.saveFirst}</span>
      </div>
    )
  }

  if (source.kind === 'own-video') {
    const chips = TRIM_ACTIONS.map(id => ({
      icon: TRIM_ICONS[id],
      id,
      label: copy.trimLabels[id],
      tip: copy.trimSentence[id]
    }))

    return <ChipRow chips={chips} disabled={disabled} group={copy.group} onPick={onTrim} />
  }

  const target = source
  const video = target.kind === 'link' ? copy.platforms[target.link.platform] : null

  const chips = PASTE_ACTIONS.map(id => ({
    icon: ICONS[id],
    id,
    label: copy.labels[id],
    tip: video ? copy.linkSentence[id](video) : copy.videoSentence[id]
  }))

  return <ChipRow chips={chips} disabled={disabled} group={copy.group} onPick={action => onPick(action, target)} />
}

/**
 * The chat composer's chips. Its draft lives in the assistant-ui composer state
 * (typing never re-renders the chrome), so this strip subscribes to just the
 * detected link: a keystroke elsewhere in the draft costs one regex test and no
 * render. A pick hands the finished request to `onSend`, which puts it in the
 * composer and sends it through the normal submit path (queue, steer, restore
 * on failure, the attachments riding along).
 */
export function ComposerPasteActions({ disabled, onSend }: { disabled: boolean; onSend: (request: string) => void }) {
  const copy = useComposerSimpleCopy().paste
  const scope = useComposerScope()
  const composer = useComposerRuntime()
  const attachments = useStore(scope.attachments.$attachments)
  const linkText = useAuiState(s => detectShortVideoLink(s.composer.text)?.raw ?? '')
  const trim = useSingleThreadMode()
  // The link alone reads back as the same link; with none, a video decides.
  const source = pasteActionSource(linkText, attachments, { trim })

  return (
    <PasteActionChips
      disabled={disabled}
      onPick={(action, target) =>
        onSend(
          pasteActionRequest(action, target, copy, {
            draft: composer.getState().text,
            pasted: pastedTextFor(scope.target)
          })
        )
      }
      onTrim={action => onSend(trimActionRequest(action, copy, composer.getState().text))}
      source={source}
    />
  )
}

/** For a composer whose draft is plain React state (the Start input). */
export function DraftPasteActions({
  attachments,
  disabled,
  draft,
  onSend,
  pasteKey
}: {
  attachments: readonly ComposerAttachment[]
  disabled: boolean
  draft: string
  onSend: (request: string) => void
  pasteKey: string
}) {
  const copy = useComposerSimpleCopy().paste
  const trim = useSingleThreadMode()

  return (
    <PasteActionChips
      disabled={disabled}
      onPick={(action, target) =>
        onSend(pasteActionRequest(action, target, copy, { draft, pasted: pastedTextFor(pasteKey) }))
      }
      onTrim={action => onSend(trimActionRequest(action, copy, draft))}
      source={pasteActionSource(draft, attachments, { trim })}
    />
  )
}
