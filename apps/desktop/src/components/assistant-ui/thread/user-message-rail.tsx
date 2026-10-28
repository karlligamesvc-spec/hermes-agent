/**
 * hc-1101: copying what you sent, in single-thread product mode.
 *
 * Your message copies the way APEX's replies do. 「复制」 sits in the hover rail
 * beside the bubble, next to stop / restore, and copies the whole message. A plain
 * right-click on the bubble opens the app menu with that same 「复制」. Selecting
 * part of it works too: single-thread-chat.css makes the bubble's text selectable,
 * and the app menu and ⌘C already copy a selection.
 *
 * Both copy the bubble's own `messageText`, so anything the bubble leaves out
 * never reaches the clipboard either, and both copy it as the bubble shows it
 * ({@link copyableMessageText}).
 *
 * Anywhere else (switch off, developer mode) the rail is the stop / restore button
 * it always was, and a right-click does what it always did
 * (user-message-identity.test.tsx).
 */

import { type MouseEvent, type ReactNode, useCallback } from 'react'

import { openDomContextMenu } from '@/app/context-menu/store'
import { resolveDomTarget } from '@/app/context-menu/target'
import { referenceRe } from '@/components/assistant-ui/reference-kinds'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { useSingleThreadMode } from '@/store/single-thread'

// A fenced block renders as code, references and all (user-message-text.tsx), so it copies verbatim.
const FENCE_OR_REFERENCE_RE = new RegExp(`(\`\`\`[^\\n\`]*\\n[\\s\\S]*?\`\`\`)|${referenceRe().source}`, 'g')

function unquoted(value: string): string {
  const quote = value[0]

  return value.length > 1 && '`"\''.includes(quote) && value.endsWith(quote) ? value.slice(1, -1) : value
}

/**
 * Your message as the bubble shows it: a reference the composer wrote as
 * `@file:`… syntax renders as a chip naming the file or link, so it copies as
 * that path or link, not as the syntax nobody typed.
 */
export function copyableMessageText(text: string): string {
  return text
    .trim()
    .replace(FENCE_OR_REFERENCE_RE, (match, fence: string | undefined, _kind: string, value: string) =>
      fence ? match : unquoted(value)
    )
}

/** The hover rail beside your bubble: the stop / restore button it is given, with 「复制」 in front in single-thread mode. */
export function UserMessageRail({ children, copyText }: { children: ReactNode; copyText: string }) {
  const { t } = useI18n()
  const text = copyableMessageText(copyText)
  const showCopy = useSingleThreadMode() && text.length > 0

  if (!showCopy && !children) {
    return null
  }

  return (
    <div className="pointer-events-none absolute right-2 bottom-2 z-10 flex items-center justify-center opacity-0 transition-opacity group-hover/user-message:opacity-100 group-focus-within/user-message:opacity-100">
      {showCopy && (
        <CopyButton
          appearance="icon"
          buttonSize="icon-xs"
          className="pointer-events-auto"
          label={t.assistant.thread.copy}
          stopPropagation
          text={text}
        />
      )}
      {children}
    </div>
  )
}

/** A plain right-click on your bubble in single-thread mode: the app menu, whose 「复制」 copies the whole message. */
export function useUserBubbleCopyMenu(copyText: string): ((event: MouseEvent<HTMLElement>) => void) | undefined {
  const singleThread = useSingleThreadMode()
  const text = copyableMessageText(copyText)

  const open = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault()
      // The app menu copies a selection; the whole message stands in for one,
      // so the menu's one 「复制」 row copies it. A live selection never gets
      // here: the app menu's own listener claims that right-click first.
      const target = resolveDomTarget(event.target instanceof Element ? event.target : null)

      openDomContextMenu(event.clientX, event.clientY, { ...target, selectionText: text })
    },
    [text]
  )

  return singleThread && text ? open : undefined
}
