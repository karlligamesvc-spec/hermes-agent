/**
 * hc-1101: a message's right-click menu in single-thread product mode: when it
 * was sent on top (「今天 09:05」), then 「复制」 for the whole message.
 *
 * Both your bubble (user-message-rail.tsx) and APEX's reply
 * (assistant-message.tsx) open it. Each carries the app menu's skip marker, so
 * a plain right-click on it is theirs. A link, an image or a selection inside
 * still gets the app's own menu, with the time on top too
 * (`data-message-at`, lib/message-menu-time.ts). The shell menu (new chat,
 * status bar…) stays on the transcript's blank space.
 *
 * Anywhere else none of this is wired, and a right-click does what it always
 * did, except on your own bubble: since hc-1105 it opens the same 「复制」 there,
 * with no time on top (no `data-message-at`).
 */

import { useAuiState } from '@assistant-ui/react'
import { type MouseEvent, useCallback } from 'react'

import { openDomContextMenu } from '@/app/context-menu/store'
import { resolveDomTarget } from '@/app/context-menu/target'
import { menuCaptionFor } from '@/lib/message-menu-time'
import { useSingleThreadMode } from '@/store/single-thread'

/** Open the app menu at a right-click with `text` as what its one 「复制」 copies, and the message's time on top. */
export function openMessageCopyMenu(event: MouseEvent<HTMLElement>, text: string): void {
  event.preventDefault()
  // The app menu copies a selection; the whole message stands in for one, so
  // the menu's one 「复制」 row copies it. A live selection never gets here: the
  // app menu's own listener claims that right-click first.
  const element = event.target instanceof Element ? event.target : null

  openDomContextMenu(
    event.clientX,
    event.clientY,
    { ...resolveDomTarget(element), selectionText: text },
    menuCaptionFor(element)
  )
}

/** When this message was sent (epoch ms) in single-thread mode, for the top of its right-click menu; undefined anywhere else. */
export function useMessageMenuTime(): number | undefined {
  const singleThread = useSingleThreadMode()
  const at = useAuiState(s => (s.message.createdAt instanceof Date ? s.message.createdAt.getTime() : NaN))

  return singleThread && Number.isFinite(at) ? at : undefined
}

/**
 * A right-click on APEX's reply in single-thread mode. The text is read at the
 * click, the way its copy button reads it (`getText`), so the menu never
 * re-renders the reply as it streams.
 */
export function useReplyCopyMenu(getText: () => string): ((event: MouseEvent<HTMLElement>) => void) | undefined {
  const singleThread = useSingleThreadMode()

  const open = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const text = getText().trim()

      if (text) {
        openMessageCopyMenu(event, text)
      }
    },
    [getText]
  )

  return singleThread ? open : undefined
}
