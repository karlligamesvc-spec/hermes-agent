/**
 * hc-1146 发消息半天没反应: what the composer shows, right above it, while the
 * conversation of the assistant on screen is opening (several assistants on):
 *
 * - every message sent meanwhile (store/held-sends.ts), as your bubble, dimmed,
 *   with 「X 接上后发送」 under it (「上一条回完再发」 once X is up and still
 *   answering the one before) and 「取消发送」, which puts the words back into
 *   the composer;
 * - a line that stays while it opens: 「正在唤醒 X…现在发的消息会先排着，接上就发。」
 *   It appears only once the opening has taken {@link OPENING_LINE_DELAY_MS}, the
 *   delay the swap overlay waits (hc-1146), so a warm switch shows nothing.
 *
 * It sits inside the composer dock, so the thread's bottom clearance makes room
 * for it. Off (one assistant, developer mode) it renders nothing.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useComposerScope } from '@/app/chat/composer/scope'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useHeldSendsCopy } from '@/i18n/held-sends'
import { $heldSends, heldSendsFor } from '@/store/held-sends'
import { $currentBot, $currentBotProfile, useMultiBotMode } from '@/store/single-thread-bots'

import { $sendPlace, threadOpening } from './composer-middleware'
import { withdrawHeldSend } from './held-send-release'

/** How long an opening runs before its line shows: SWAP_OVERLAY_DELAY (chat-swap-overlay.tsx). */
export const OPENING_LINE_DELAY_MS = 400

/** `on`, but only once it has stayed on for `delayMs`; off at once. */
function useHeldOn(on: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!on) {
      setShown(false)

      return
    }

    const timer = window.setTimeout(() => setShown(true), delayMs)

    return () => window.clearTimeout(timer)
  }, [delayMs, on])

  return on && shown
}

/** Mounted in every composer; only the main one (the conversation on screen) shows anything. */
export function HeldSendsStrip() {
  const mainComposer = useComposerScope().target === 'main'
  const multiBot = useMultiBotMode() && mainComposer
  const copy = useHeldSendsCopy()
  const profile = useStore($currentBotProfile)
  const name = useStore($currentBot)?.name ?? ''
  const allHeld = useStore($heldSends)
  const place = useStore($sendPlace)
  // The thread can take a send: what is still held waits for the reply to the one before.
  const up = !threadOpening(place)
  const opening = multiBot && !up
  const lineShown = useHeldOn(opening, OPENING_LINE_DELAY_MS)
  const held = multiBot ? heldSendsFor(allHeld, profile) : []

  if (held.length === 0 && !lineShown) {
    return null
  }

  return (
    <div className="flex w-full basis-full flex-col gap-1.5" data-held-sends="">
      {held.length > 0 && (
        <ol aria-label={copy.listLabel} className="flex w-full flex-col items-end gap-1.5">
          {held.map(item => (
            <li
              className="flex max-w-[min(500px,85%)] flex-col items-end gap-0.5"
              data-held-send={item.id}
              key={item.id}
            >
              {/* Your bubble as the thread draws it (single-thread-chat.css --st-me-bubble), dimmed until it goes out. */}
              <div
                className="rounded-[18px] bg-[#6a4ceb] px-3.5 py-2 text-[14.5px] leading-[1.6] text-white opacity-60"
                data-held-send-bubble=""
              >
                <span className="line-clamp-4 whitespace-pre-wrap break-words">{item.text}</span>
                {item.attachments.length > 0 && (
                  <span className="mt-0.5 block truncate text-[0.75em] opacity-85">
                    {item.attachments.map(attachment => attachment.label).join(' · ')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
                <span>{up ? copy.waitsForReply : copy.waitsForAssistant(name)}</span>
                <button
                  aria-label={copy.withdrawHint}
                  className="cursor-pointer rounded px-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  data-held-send-withdraw=""
                  onClick={() => withdrawHeldSend(item.id)}
                  title={copy.withdrawHint}
                  type="button"
                >
                  {copy.withdraw}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {lineShown && (
        <div
          className="flex items-center gap-1.5 self-start px-1 text-[0.75rem] text-muted-foreground"
          data-held-sends-opening=""
          role="status"
        >
          <GlyphSpinner className="w-3 justify-start text-(--ui-accent)" spinner="braille" />
          {copy.opening(name)}
        </div>
      )}
    </div>
  )
}
