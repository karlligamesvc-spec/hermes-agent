import { useCallback } from 'react'

import { type ComposerTarget, requestComposerInsert } from '@/app/chat/composer/focus'
import { droppedFileInlineRefs } from '@/app/chat/composer/inline-refs'
import { shouldAcceptFileDrops } from '@/app/chat/intro-visibility'

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
  const { businessStartVisible, composerTarget, currentCwd, onAttachDroppedItems } = input

  const onDropFiles = useCallback(
    (candidates: DroppedFile[]) => {
      // The business home owns a separate textarea; the rich composer remains
      // hidden. Route every home drop to the visible attachment draft instead
      // of inserting folder refs into that hidden editor.
      if (businessStartVisible) {
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
    [businessStartVisible, composerTarget, currentCwd, onAttachDroppedItems]
  )

  return useFileDropZone({ enabled: shouldAcceptFileDrops(input), onDropFiles })
}
