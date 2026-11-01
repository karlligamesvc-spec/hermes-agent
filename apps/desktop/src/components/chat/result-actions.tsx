import { useCallback, useEffect, useRef, useState } from 'react'

import { pickRevealLabel } from '@/app/right-sidebar/file-actions'
import { useI18n } from '@/i18n'
import { useResultCopy } from '@/i18n/single-thread-results'
import { openExternalLink } from '@/lib/external-link'
import { Download, FolderOpen } from '@/lib/icons'
import {
  downloadGatewayMediaFile,
  filePathFromMediaPath,
  isFileMediaPath,
  isRemoteGateway,
  type MediaKind,
  mediaSaveName
} from '@/lib/media'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

export const RESULT_ACTION_CLASS =
  'flex shrink-0 items-center gap-1 rounded-md border border-(--ui-stroke-tertiary) bg-background/40 px-2 py-1 text-[0.7rem] font-medium text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground disabled:opacity-50'

/**
 * Save a result under its short title. A file goes through the same bridge the
 * document card uses (it reads the file, not the bytes on screen, and works for
 * a remote gateway); a link has no file here, so the browser takes it.
 */
export function useResultDownload(path: string, kind: MediaKind) {
  const { t } = useI18n()
  const copy = useResultCopy()
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const mounted = useRef(false)
  const failedTitle = t.fileMenu.downloadFailed
  const fallbackTitle = copy.kinds[kind]

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write, as in PreviewAttachment
  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const download = useCallback(async () => {
    if (!path || downloading) {
      return
    }

    if (!isFileMediaPath(path)) {
      openExternalLink(path)

      return
    }

    setDownloading(true)

    try {
      const result = await downloadGatewayMediaFile(path, undefined, mediaSaveName(path, fallbackTitle))

      if (mounted.current && result.saved) {
        setDownloaded(true)
        setTimeout(() => mounted.current && setDownloaded(false), 2000)
      }
    } catch (error) {
      notifyError(error, failedTitle)
    } finally {
      if (mounted.current) {
        setDownloading(false)
      }
    }
  }, [downloading, failedTitle, fallbackTitle, path])

  return { download, downloaded, downloading }
}

/** Only a file on this computer can be shown in the file manager. */
function canReveal(path: string): boolean {
  return Boolean(window.hermesDesktop?.revealPath) && !isRemoteGateway() && isFileMediaPath(path)
}

export function RevealResultButton({ path }: { path: string }) {
  const { t } = useI18n()
  const copy = useResultCopy()
  const label = pickRevealLabel(t.fileMenu.revealFinder, t.fileMenu.revealExplorer, t.fileMenu.revealFileManager)

  if (!canReveal(path)) {
    return null
  }

  const reveal = async () => {
    const shown = await window.hermesDesktop?.revealPath?.(filePathFromMediaPath(path)).catch(() => false)

    if (!shown) {
      notify({ kind: 'warning', message: copy.missing })
    }
  }

  return (
    <button className={RESULT_ACTION_CLASS} onClick={() => void reveal()} type="button">
      <FolderOpen className="size-3" />
      {label}
    </button>
  )
}

/** The actions under a result card. The native player's own download is off in
 *  product mode, so this row is the one way to save a result. */
export function ResultActions({ className, kind, path }: { className?: string; kind: MediaKind; path: string }) {
  const { t } = useI18n()
  const { download, downloaded, downloading } = useResultDownload(path, kind)

  return (
    <span className={cn('mt-2 flex flex-wrap items-center gap-2', className)} data-slot="aui_result-actions">
      <button className={RESULT_ACTION_CLASS} disabled={downloading} onClick={() => void download()} type="button">
        <Download className="size-3" />
        {downloaded ? t.fileMenu.downloadSaved : t.fileMenu.download}
      </button>
      <RevealResultButton path={path} />
    </span>
  )
}
