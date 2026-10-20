import { useAuiState, useComposerRuntime } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'

import { composerFloatingPill } from '@/components/chat/composer-dock'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useComposerSimpleCopy } from '@/i18n/composer-simple'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'

import {
  detectShortVideoLink,
  PASTE_ACTIONS,
  type PasteActionId,
  pasteActionRequest,
  type PasteActionSource,
  pasteActionSource,
  pastedTextFor
} from './paste-actions'
import { useComposerScope } from './scope'

const ICONS: Record<PasteActionId, string> = { breakdown: 'flame', remix: 'pencil', transcribe: 'note' }

/**
 * The three paste-to-act chips. No dismiss control, like the suggestion pills
 * beside them: the chips live exactly as long as their link sits in the draft
 * (or their video among the attachments), and typing past them is the way to
 * ignore them.
 */
export function PasteActionChips({
  disabled,
  onPick,
  source
}: {
  disabled: boolean
  onPick: (action: PasteActionId) => void
  source: null | PasteActionSource
}) {
  const copy = useComposerSimpleCopy().paste

  if (!source) {
    return null
  }

  const video = source.kind === 'link' ? copy.platforms[source.link.platform] : null

  return (
    <div aria-label={copy.group} className="contents" data-slot="composer-paste-actions" role="group">
      {PASTE_ACTIONS.map(action => (
        <Tip key={action} label={video ? copy.linkSentence[action](video) : copy.videoSentence[action]}>
          <button
            className={cn(composerFloatingPill, 'max-w-56 disabled:cursor-not-allowed disabled:opacity-50')}
            data-paste-action={action}
            disabled={disabled}
            onClick={() => {
              triggerHaptic('selection')
              onPick(action)
            }}
            type="button"
          >
            <Codicon className="shrink-0 opacity-70" name={ICONS[action]} size="0.75rem" />
            <span className="truncate">{copy.labels[action]}</span>
          </button>
        </Tip>
      ))}
    </div>
  )
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
  // The link alone reads back as the same link; with none, a video decides.
  const source = pasteActionSource(linkText, attachments)

  return (
    <PasteActionChips
      disabled={disabled}
      onPick={action => {
        if (source) {
          const draft = composer.getState().text

          onSend(pasteActionRequest(action, source, copy, { draft, pasted: pastedTextFor(scope.target) }))
        }
      }}
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
  const source = pasteActionSource(draft, attachments)

  return (
    <PasteActionChips
      disabled={disabled}
      onPick={action => {
        if (source) {
          onSend(pasteActionRequest(action, source, copy, { draft, pasted: pastedTextFor(pasteKey) }))
        }
      }}
      source={source}
    />
  )
}
