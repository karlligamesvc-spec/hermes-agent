/**
 * The 「下一步」 buttons under a creator skill's result (apex-next/1, lib/next-steps).
 *
 * The skill ends its reply with a block of 2–3 options; the Markdown never shows it
 * (preprocessMarkdown strips it) and this row draws it instead. A click sends the option's
 * sentence as a visible user message, exactly as if the user had typed it. A failed result
 * (`failed=X`) gets hc-973's three buttons (FailureActions) with the same sentences — unless
 * the turn's process block already offers them for a failed step.
 *
 * Only the newest finished turn has buttons: a reply still streaming has none, and the next
 * user message (a click or anything typed) moves the conversation on and the row goes away.
 */

import { useAuiState, useMessagePartText } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { useSessionView } from '@/app/chat/session-view'
import { FailureActions } from '@/components/assistant-ui/process/process-block'
import { useTurnView } from '@/components/assistant-ui/process/turn-state'
import { useNextStepsCopy } from '@/i18n/next-steps'
import { type NextStepsBlock, parseNextSteps } from '@/lib/next-steps'
import { $gatewayState } from '@/store/session'

// Rows already used, module-scoped: transcript virtualization remounts the row with fresh
// state, which would otherwise offer the same click twice before the user message lands.
const used = new Set<string>()

const OPTION_CLASS =
  'max-w-full shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-left text-[12px] whitespace-normal wrap-anywhere transition-colors hover:border-primary/50 hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-50'

interface ThreadSlice {
  message: { id: string }
  thread: { messages: readonly { id: string }[] }
}

/** Every assistant text part mounts this; only a settled part that carries a block goes further. */
export function NextStepButtons() {
  const { status, text } = useMessagePartText()
  const block = useMemo(() => parseNextSteps(text).block, [text])

  if (!block || status.type === 'running') {
    return null
  }

  return <NextStepRow block={block} />
}

function NextStepRow({ block }: { block: NextStepsBlock }) {
  const view = useTurnView()
  const session = useSessionView()
  const storedId = useStore(session.$storedId)
  const runtimeId = useStore(session.$runtimeId)
  const messageId = useAuiState((state: ThreadSlice) => state.message.id)
  // The turn's last bubble: a live turn spreads over several, only the final answer has buttons.
  const isLastMessage = useAuiState((state: ThreadSlice) => state.thread.messages.at(-1)?.id === state.message.id)
  const gatewayState = useStore($gatewayState)
  const copy = useNextStepsCopy()
  const identity = JSON.stringify([storedId ?? runtimeId, messageId, block])
  const [sent, setSent] = useState(() => used.has(identity))

  if (!view || view.live || !view.isLastTurn || !isLastMessage) {
    return null
  }

  // hc-973's process block already shows the same three buttons for the step that failed.
  if (block.failed !== null && view.process.failed !== null) {
    return null
  }

  const target = session.kind === 'tile' ? `tile:${storedId}` : 'main'
  const disabled = sent || gatewayState !== 'open'

  const ask = (message: string) => {
    if (disabled) {
      return
    }

    if (requestComposerSubmit(message, { target })) {
      used.add(identity)
      setSent(true)
    }
  }

  if (block.failed !== null) {
    return (
      <div aria-label={copy.group} className="mt-2" data-next-steps="failed" role="group">
        <FailureActions disabled={disabled} onAsk={ask} title={block.failed} />
      </div>
    )
  }

  return (
    <div
      aria-label={copy.group}
      className="mt-2 flex min-w-0 max-w-full flex-wrap gap-2"
      data-next-steps=""
      role="group"
    >
      {block.options.map(option => (
        <button
          className={OPTION_CLASS}
          disabled={disabled}
          key={option.label}
          onClick={() => ask(option.message)}
          title={copy.sends(option.message)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
