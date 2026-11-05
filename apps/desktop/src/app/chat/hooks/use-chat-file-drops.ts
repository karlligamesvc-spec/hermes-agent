import { useCallback, useEffect } from 'react'

import { BUSINESS_GOAL_INPUT_ID } from '@/app/business-workspace/goal-launcher'
import { type ComposerTarget, getActiveComposer, requestComposerInsert } from '@/app/chat/composer/focus'
import { droppedFileInlineRefs } from '@/app/chat/composer/inline-refs'
import { copiedEntriesInClipboard } from '@/app/chat/composer/paste-files'
import { shouldAcceptFileDrops } from '@/app/chat/intro-visibility'
import { isElementInHiddenPane } from '@/components/pane-shell/pane-visibility'
import { isEditableTarget } from '@/lib/keybinds/combo'
import { composerFocusBlockedBySurface } from '@/lib/keybinds/composer-focus-keys'

import { type DroppedFile, partitionDroppedFiles } from './use-composer-actions'
import { useFileDropZone } from './use-file-drop-zone'

/**
 * Drop files anywhere in the conversation area, not just on the composer
 * input. In-app drags (project tree / gutter) carry workspace-relative paths
 * the gateway resolves directly, so they stay inline `@file:` refs. OS/Finder
 * drops carry absolute local paths that don't exist on a remote gateway (and
 * images need byte upload for vision), so route them through the attachment
 * pipeline — otherwise the local path leaks into the prompt verbatim.
 *
 * Session drags are POINTER drags (session-drag.ts) — never native DnD.
 * The drop zone only handles files; session drops commit through the drag
 * session itself, which routes a center/link drop to this surface's composer
 * via `data-composer-target`.
 *
 * On the business Start page, ⌘V of files copied in Finder takes the same
 * route as a drop there (hc-1159, below).
 */
export function useChatFileDrops(input: {
  busy: boolean
  businessStartVisible: boolean
  chatBarVisible: boolean
  composerTarget: ComposerTarget
  currentCwd: null | string | undefined
  gatewayOpen: boolean
  onAttachDroppedItems: (candidates: DroppedFile[]) => Promise<boolean | void> | boolean | void
}) {
  const { businessStartVisible, chatBarVisible, composerTarget, currentCwd, onAttachDroppedItems } = input
  const accepted = shouldAcceptFileDrops(input)

  const onDropFiles = useCallback(
    (candidates: DroppedFile[]) => {
      // The business home owns a separate textarea; the rich composer remains
      // hidden. Route every home drop to the visible attachment draft instead
      // of inserting folder refs into that hidden editor. A drawer over Start
      // brings the composer back, and with it the routing below.
      if (businessStartVisible && !chatBarVisible) {
        void onAttachDroppedItems(candidates)

        return
      }

      const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)
      const refs = droppedFileInlineRefs(inAppRefs, currentCwd)

      if (refs.length) {
        requestComposerInsert(refs.join(' '), { mode: 'inline', target: composerTarget })
      }

      if (osDrops.length) {
        void onAttachDroppedItems(osDrops)
      }
    },
    [businessStartVisible, chatBarVisible, composerTarget, currentCwd, onAttachDroppedItems]
  )

  // ⌘V of files copied in Finder while Start owns the draft (hc-1159): the
  // copied entries take the Start drop's route above, with the launcher input
  // focused or with the paste landing on the page around it. The chat
  // composer's paste paths can't take them here: ChatBar is not mounted behind
  // Start on first launch, and once mounted it stays hidden, where a folder
  // would become an @folder: ref in an editor nobody sees. This listener runs
  // in the capture phase on window, ahead of paste-to-focus (bubble phase), and
  // the event it consumes never reaches the composer bus, so a paste attaches
  // once whether or not ChatBar is mounted.
  const startTakesPaste = businessStartVisible && !chatBarVisible && accepted

  useEffect(() => {
    if (!startTakesPaste) {
      return undefined
    }

    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) {
        return
      }

      const launcher = window.document.getElementById(BUSINESS_GOAL_INPUT_ID)

      if (!launcher || isElementInHiddenPane(launcher)) {
        return
      }

      // Off the launcher, paste-to-focus's rules hold: other inputs keep their
      // own paste, blocking surfaces keep theirs, and Start takes the paste
      // only while its surface is the active composer.
      if (
        event.target !== launcher &&
        (isEditableTarget(event.target) || composerFocusBlockedBySurface() || getActiveComposer() !== composerTarget)
      ) {
        return
      }

      const entries = copiedEntriesInClipboard(event.clipboardData)

      if (entries.length === 0) {
        return
      }

      event.preventDefault()
      void onAttachDroppedItems(entries)
      launcher.focus()
    }

    window.addEventListener('paste', onPaste, true)

    return () => window.removeEventListener('paste', onPaste, true)
  }, [composerTarget, onAttachDroppedItems, startTakesPaste])

  return useFileDropZone({ enabled: accepted, onDropFiles })
}
