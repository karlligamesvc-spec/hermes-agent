/**
 * ⌘V of files copied in Finder (hc-1158): a paste that carries copied files
 * attaches them the way a drop does.
 *
 * Chromium hands such a paste over like a drop: `types` is `['Files']`, each
 * copied item is a `kind: 'file'` entry whose File resolves through
 * `getPathForFile`, and the text payload is empty. Measured on Electron 40 /
 * Chrome 144 (macOS, Finder-style pasteboard): a video, a PNG and a folder
 * each arrived that way (the folder with `isDirectory`), and of several
 * copied files only the first came through.
 *
 * The composer's paste path only knew images and text, so a copied video
 * attached nothing and the paste-to-act chips never showed. Here copied
 * entries take the composer drop handler's steps: folders become inline
 * `@folder:` refs, files go through `onAttachDroppedItems`. Image files stay
 * with the image-blob path (`extractClipboardImageBlobs` takes the same
 * `image/*` items), and a File without a path (a screenshot, a browser's
 * Copy Image) is not a copied file.
 */

import { type ClipboardEvent, useEffect } from 'react'

import { triggerHaptic } from '@/lib/haptics'

import { type DroppedFile, extractDroppedFiles, partitionDroppedFiles } from '../hooks/use-composer-actions'

import { type ComposerTarget, getActiveComposer } from './focus'
import { droppedFileInlineRefs, type InlineRefInput } from './inline-refs'
import type { ChatBarProps } from './types'

/** What a composer needs to take copied files: the same handles its drop handler uses. */
export interface CopiedFilesSink {
  cwd: ChatBarProps['cwd']
  insertInlineRefs: (refs: InlineRefInput[]) => boolean
  onAttachDroppedItems: ChatBarProps['onAttachDroppedItems']
  requestMainFocus: () => void
}

/**
 * Every copied entry in a paste: the files and folders with a path on disk,
 * pictures included. The business Start page takes them all the way its drop
 * does (hc-1159): it has no image-blob paste of its own.
 */
export function copiedEntriesInClipboard(clipboard: DataTransfer): DroppedFile[] {
  return extractDroppedFiles(clipboard).filter(entry => entry.path)
}

/** The copied files and folders in a paste: entries with a path, image files left out. */
export function copiedFilesInClipboard(clipboard: DataTransfer): DroppedFile[] {
  return copiedEntriesInClipboard(clipboard).filter(entry => !entry.file?.type.startsWith('image/'))
}

/** Attach copied entries with the steps of the composer's drop handler (`useComposerDrop`). */
export function attachCopiedFiles(
  entries: DroppedFile[],
  { cwd, insertInlineRefs, onAttachDroppedItems, requestMainFocus }: CopiedFilesSink
) {
  const { inAppRefs, osDrops } = partitionDroppedFiles(entries)
  const refs = droppedFileInlineRefs(inAppRefs, cwd)

  if (refs.length && insertInlineRefs(refs)) {
    triggerHaptic('selection')
  }

  if (osDrops.length && onAttachDroppedItems) {
    void Promise.resolve(onAttachDroppedItems(osDrops)).then(attached => {
      if (attached) {
        triggerHaptic('selection')
        requestMainFocus()
      }
    })
  }
}

/**
 * The focused composer's paste. True when the clipboard carried copied files:
 * they are attaching and the event is consumed. The caller stops there: there
 * is no text to insert, and the clipboard-image read it would fall back to
 * returns the file's icon when one is on the pasteboard.
 */
export function pasteCopiedFiles(event: ClipboardEvent<HTMLElement>, sink: CopiedFilesSink): boolean {
  if (!sink.onAttachDroppedItems) {
    return false
  }

  const entries = copiedFilesInClipboard(event.clipboardData)

  if (entries.length === 0) {
    return false
  }

  event.preventDefault()
  attachCopiedFiles(entries, sink)

  return true
}

// ⌘V on the transcript or the window body (paste-to-focus) has no handle on a
// composer, so its copied files ride this event to the active one, the way
// its clipboard images ride `requestComposerAttachImages`.
const ATTACH_COPIED_FILES_EVENT = 'hermes:composer-attach-copied-files'

interface AttachCopiedFilesDetail {
  entries: DroppedFile[]
  target: ComposerTarget
}

/** Hand copied entries to the active composer (deferred a macrotask, like the other composer-bus requests). */
export function requestComposerAttachCopiedFiles(entries: DroppedFile[]) {
  if (entries.length === 0 || typeof window === 'undefined') {
    return
  }

  const detail: AttachCopiedFilesDetail = { entries, target: getActiveComposer() }

  window.setTimeout(() => window.dispatchEvent(new CustomEvent(ATTACH_COPIED_FILES_EVENT, { detail })), 0)
}

/** A composer takes the copied files addressed to it. */
export function useCopiedFilesRequests({
  cwd,
  insertInlineRefs,
  onAttachDroppedItems,
  requestMainFocus,
  target
}: CopiedFilesSink & { target: ComposerTarget }) {
  useEffect(() => {
    if (!onAttachDroppedItems) {
      return undefined
    }

    const listener = (event: Event) => {
      const detail = (event as CustomEvent<AttachCopiedFilesDetail>).detail

      if (detail?.target === target) {
        attachCopiedFiles(detail.entries, { cwd, insertInlineRefs, onAttachDroppedItems, requestMainFocus })
      }
    }

    window.addEventListener(ATTACH_COPIED_FILES_EVENT, listener)

    return () => window.removeEventListener(ATTACH_COPIED_FILES_EVENT, listener)
  }, [cwd, insertInlineRefs, onAttachDroppedItems, requestMainFocus, target])
}
