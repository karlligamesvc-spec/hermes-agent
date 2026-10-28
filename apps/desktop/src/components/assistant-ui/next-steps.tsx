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
 *
 * hc-1089: a 「交给」 option (`@助手名字 | 按钮字 | 要它做什么`) is drawn as 「交给 X：按钮字」 and a
 * click proposes handing its sentence, with this reply as the carried result, to that assistant
 * (hc-1087 `proposeHandoff`: a confirmation card in this thread, which starts the hc-1086 relay
 * on 「交给它」) instead of saying it here. The row is used up only once the relay started. It shows only while the relay
 * can take it: relay mode on (`multi_bot_handoff`, several assistants, product mode — never in
 * developer mode), the name is another assistant on the roster, and the assistant on screen is
 * not itself working on a relay (接手的不能再往外交). Otherwise the option is left out and the
 * rest of the row is exactly what it was without it. When the relay is off by the time of the
 * click (the switch changed under the row), one plain line under the row says so and the row
 * stays usable; a refusal after 「交给它」 is the confirmation card's to explain.
 */

import { useAuiState, useMessagePartText } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { useSessionView } from '@/app/chat/session-view'
import { handoffReplyAttachments } from '@/app/single-thread/handoff-text'
import { FailureActions } from '@/components/assistant-ui/process/process-block'
import { useTurnView } from '@/components/assistant-ui/process/turn-state'
import { useNextStepsCopy } from '@/i18n/next-steps'
import { isHandoff, type NextStepOption, type NextStepsBlock, parseNextSteps } from '@/lib/next-steps'
import { $gatewayState } from '@/store/session'
import { cleanBotName } from '@/store/single-thread-bot-ops'
import { $botRoster, $currentBotProfile, type ApexBot } from '@/store/single-thread-bots'
import {
  $handoffMode,
  $handoffs,
  handoffsTo,
  isHandoffActive,
  type StartHandoffRefusal
} from '@/store/single-thread-handoff'
import { proposeHandoff } from '@/store/single-thread-handoff-confirm'

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
  const { block, visible } = useMemo(() => parseNextSteps(text), [text])

  if (!block || status.type === 'running') {
    return null
  }

  return <NextStepRow block={block} visible={visible} />
}

/** hc-1089: the roster row a 「交给」 option names (as shown and stored, any case), never the assistant on screen. */
function handoffTarget(name: string, roster: readonly ApexBot[], current: string): ApexBot | null {
  const wanted = cleanBotName(name).toLocaleLowerCase()

  return roster.find(bot => bot.profile !== current && cleanBotName(bot.name).toLocaleLowerCase() === wanted) ?? null
}

interface ShownOption {
  bot: ApexBot | null
  option: NextStepOption
}

function NextStepRow({ block, visible }: { block: NextStepsBlock; visible: string }) {
  const view = useTurnView()
  const session = useSessionView()
  const storedId = useStore(session.$storedId)
  const runtimeId = useStore(session.$runtimeId)
  const messageId = useAuiState((state: ThreadSlice) => state.message.id)
  // The turn's last bubble: a live turn spreads over several, only the final answer has buttons.
  const isLastMessage = useAuiState((state: ThreadSlice) => state.thread.messages.at(-1)?.id === state.message.id)
  const gatewayState = useStore($gatewayState)
  const handoffMode = useStore($handoffMode)
  const roster = useStore($botRoster)
  const currentProfile = useStore($currentBotProfile)
  const handoffs = useStore($handoffs)
  const copy = useNextStepsCopy()
  const identity = JSON.stringify([storedId ?? runtimeId, messageId, block])
  const [sent, setSent] = useState(() => used.has(identity))
  const [refused, setRefused] = useState<null | { name: string; reason: StartHandoffRefusal }>(null)

  if (!view || view.live || !view.isLastTurn || !isLastMessage) {
    return null
  }

  // hc-973's process block already shows the same three buttons for the step that failed.
  if (block.failed !== null && view.process.failed !== null) {
    return null
  }

  const target = session.kind === 'tile' ? `tile:${storedId}` : 'main'
  const disabled = sent || gatewayState !== 'open'
  const canHandOff = handoffMode && !handoffsTo(currentProfile, handoffs).some(isHandoffActive)

  const options: readonly NextStepOption[] = block.options

  const shown = options.flatMap((option): ShownOption[] => {
    if (!isHandoff(option)) {
      return [{ bot: null, option }]
    }

    const bot = canHandOff ? handoffTarget(option.to, roster, currentProfile) : null

    return bot ? [{ bot, option }] : []
  })

  const ask = (message: string) => {
    if (disabled) {
      return
    }

    if (requestComposerSubmit(message, { target })) {
      used.add(identity)
      setSent(true)
    }
  }

  const handOff = (bot: ApexBot, option: NextStepOption) => {
    if (disabled) {
      return
    }

    const proposed = proposeHandoff(
      {
        ask: option.message,
        from: { messageId, profile: currentProfile, storedSessionId: storedId ?? null },
        previous: { text: visible, ...handoffReplyAttachments(visible) },
        to: bot.profile
      },
      {
        onStarted: () => {
          used.add(identity)
          setSent(true)
        },
        origin: 'next_step'
      }
    )

    setRefused(proposed ? null : { name: bot.name, reason: 'off' })
  }

  if (block.failed !== null) {
    return (
      <div aria-label={copy.group} className="mt-2" data-next-steps="failed" role="group">
        <FailureActions disabled={disabled} onAsk={ask} title={block.failed} />
      </div>
    )
  }

  if (shown.length === 0) {
    return null
  }

  const row = (
    <div
      aria-label={copy.group}
      className="mt-2 flex min-w-0 max-w-full flex-wrap gap-2"
      data-next-steps=""
      role="group"
    >
      {shown.map(({ bot, option }) =>
        bot ? (
          <button
            className={OPTION_CLASS}
            data-next-step-handoff={bot.profile}
            disabled={disabled}
            key={`${option.label}\n${bot.profile}`}
            onClick={() => handOff(bot, option)}
            title={copy.handsOff(bot.name, option.message)}
            type="button"
          >
            {copy.handoff(bot.name, option.label)}
          </button>
        ) : (
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
        )
      )}
    </div>
  )

  if (!refused) {
    return row
  }

  return (
    <>
      {row}
      <p
        className="mt-1 text-[12px] text-muted-foreground"
        data-next-step-handoff-refused={refused.reason}
        role="status"
      >
        {copy.refused[refused.reason](refused.name)}
      </p>
    </>
  )
}
