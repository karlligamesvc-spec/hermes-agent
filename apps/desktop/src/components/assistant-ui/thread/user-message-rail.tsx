/**
 * hc-1101: what you can do with your own message, in single-thread product mode.
 *
 * - The bubble is just your words ({@link UserBubbleEdit}): a click no longer
 *   opens the editor, so the text can be selected and its links followed.
 * - The hover rail beside it ({@link UserMessageRail}) holds 「复制」 and
 *   「改一下」, then 「从这条重来」 (or stop while its turn runs).
 * - A plain right-click opens the app menu: the message's time on top, then
 *   「复制」 for the whole message ({@link useUserBubbleCopyMenu},
 *   {@link useMessageMenuTime}).
 * - Selecting part of it works too: the app menu and ⌘C already copy a
 *   selection.
 *
 * Everything copies the bubble's own `messageText`, so anything the bubble
 * leaves out never reaches the clipboard. It copies the way the bubble shows it
 * ({@link copyableMessageText}).
 *
 * Anywhere else (switch off, developer mode) the bubble is the click-to-edit
 * button, the rail is the stop / restore button it always was, and a
 * right-click does what it always did (user-message-identity.test.tsx).
 */

import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react'
import { type ComponentProps, type MouseEvent, type ReactElement, useCallback } from 'react'

import { openDomContextMenu } from '@/app/context-menu/store'
import { resolveDomTarget } from '@/app/context-menu/target'
import { referenceRe } from '@/components/assistant-ui/reference-kinds'
import { useThreadCopy } from '@/components/assistant-ui/thread/thread-copy'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { triggerHaptic } from '@/lib/haptics'
import { StopFilled } from '@/lib/icons'
import { menuCaptionFor } from '@/lib/message-menu-time'
import { cn } from '@/lib/utils'
import { useSingleThreadMode } from '@/store/single-thread'
import { notifyThreadEditOpen } from '@/store/thread-scroll'

export const USER_ACTION_ICON_BUTTON_CLASS =
  'grid place-items-center rounded-md bg-transparent text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground disabled:cursor-default disabled:text-(--ui-text-quaternary) disabled:opacity-70'

export const USER_ACTION_ICON_SIZE = '0.6875rem'
export const StopGlyph = <StopFilled aria-hidden className="size-3.5 -translate-y-px" />

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

/**
 * The bubble's click-to-edit. In single-thread mode the bubble is your words in
 * a plain block (same classes, `data-user-bubble`): no click handler, so text
 * selects and links open; editing is 「改一下」 in the rail.
 */
export function UserBubbleEdit({ children }: { children: ReactElement<ComponentProps<'button'>> }) {
  if (!useSingleThreadMode()) {
    return <ActionBarPrimitive.Edit asChild>{children}</ActionBarPrimitive.Edit>
  }

  return (
    <div className={children.props.className} data-user-bubble="">
      {children.props.children}
    </div>
  )
}

interface UserMessageRailProps {
  /** The bubble's text; nothing to copy or edit when it has none. */
  copyText: string
  /** False in a watch window, where nothing can be changed. */
  editable: boolean
  onRestore: () => void
  onStop: () => void
  /** Stop while this ask's turn runs, restore otherwise, or neither. */
  primary: 'restore' | 'stop' | null
}

/** The hover rail beside your bubble: 「复制」 and 「改一下」 in single-thread mode, then stop or restore. */
export function UserMessageRail({ copyText, editable, onRestore, onStop, primary }: UserMessageRailProps) {
  const copy = useThreadCopy()
  const singleThread = useSingleThreadMode()
  const text = copyableMessageText(copyText)
  const showCopy = singleThread && text.length > 0
  const showEdit = showCopy && editable

  if (!showCopy && !primary) {
    return null
  }

  return (
    <div className="pointer-events-none absolute right-2 bottom-2 z-10 flex items-center justify-center opacity-0 transition-opacity group-hover/user-message:opacity-100 group-focus-within/user-message:opacity-100">
      {showCopy && (
        <CopyButton
          appearance="icon"
          buttonSize="icon-xs"
          className="pointer-events-auto"
          label={copy.copy}
          stopPropagation
          text={text}
        />
      )}
      {showEdit && (
        <ActionBarPrimitive.Edit asChild>
          <button
            aria-label={copy.editMessage}
            className={cn('pointer-events-auto size-6', USER_ACTION_ICON_BUTTON_CLASS)}
            onClick={() => triggerHaptic('selection')}
            onPointerDown={() => notifyThreadEditOpen()}
            title={copy.editMessage}
            type="button"
          >
            <Codicon name="edit" size="0.875rem" />
          </button>
        </ActionBarPrimitive.Edit>
      )}
      {primary === 'stop' && (
        <button
          aria-label={copy.stop}
          className={cn('pointer-events-auto size-5', USER_ACTION_ICON_BUTTON_CLASS)}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            onStop()
          }}
          title={copy.stop}
          type="button"
        >
          {StopGlyph}
        </button>
      )}
      {primary === 'restore' && (
        <button
          aria-label={singleThread ? copy.restoreFromHere : copy.restoreCheckpoint}
          className={cn('pointer-events-auto size-6', USER_ACTION_ICON_BUTTON_CLASS)}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            triggerHaptic('selection')
            onRestore()
          }}
          onPointerDown={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          title={copy.restoreFromHere}
          type="button"
        >
          <Codicon name="discard" size="0.875rem" />
        </button>
      )}
    </div>
  )
}

/** When this message was sent (epoch ms) in single-thread mode, for the top of its right-click menu; undefined anywhere else. */
export function useMessageMenuTime(): number | undefined {
  const singleThread = useSingleThreadMode()
  const at = useAuiState(s => (s.message.createdAt instanceof Date ? s.message.createdAt.getTime() : NaN))

  return singleThread && Number.isFinite(at) ? at : undefined
}

/** A plain right-click on your bubble in single-thread mode: the app menu, its time on top, its 「复制」 copying the whole message. */
export function useUserBubbleCopyMenu(copyText: string): ((event: MouseEvent<HTMLElement>) => void) | undefined {
  const singleThread = useSingleThreadMode()
  const text = copyableMessageText(copyText)

  const open = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault()
      // The app menu copies a selection; the whole message stands in for one,
      // so the menu's one 「复制」 row copies it. A live selection never gets
      // here: the app menu's own listener claims that right-click first.
      const element = event.target instanceof Element ? event.target : null
      const target = resolveDomTarget(element)

      openDomContextMenu(event.clientX, event.clientY, { ...target, selectionText: text }, menuCaptionFor(element))
    },
    [text]
  )

  return singleThread && text ? open : undefined
}
