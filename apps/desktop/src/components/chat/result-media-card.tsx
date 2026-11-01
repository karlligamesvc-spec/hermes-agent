import { useEffect, useState } from 'react'

import { useResultCopy } from '@/i18n/single-thread-results'
import { mediaKind, mediaShortTitle, resolveMediaPlaybackSrc } from '@/lib/media'

import { ResultActions, useResultDownload } from './result-actions'
import { TranscriptVideo } from './transcript-video'
import { ZoomableImage } from './zoomable-image'

// hc-1130: the native player's ⋮ is drawn by Chromium in the language the app
// started in, not the one chosen in Settings, and its Download starts from a
// name built out of the stream URL. With the action row under the card it adds
// only that, so the native item goes. Its speed and picture-in-picture stay.
const NO_NATIVE_DOWNLOAD = 'nodownload'

/**
 * hc-1130 拿到结果: a video, audio clip or image in single-thread product mode.
 * It reads as the result it is, the same as a document's card: a short title,
 * the thing itself, and the actions to take it away. The path never shows.
 */
export function ResultMediaCard({ path }: { path: string }) {
  const copy = useResultCopy()
  const kind = mediaKind(path)
  const title = mediaShortTitle(path) || copy.kinds[kind]
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const { download } = useResultDownload(path, kind)

  useEffect(() => {
    let cancelled = false

    setFailed(false)
    setSrc('')

    void resolveMediaPlaybackSrc(path)
      .then(value => !cancelled && setSrc(value))
      .catch(() => !cancelled && setFailed(true))

    return () => {
      cancelled = true
    }
  }, [path])

  const playerFailed = () => setFailed(true)

  return (
    <span
      className="my-3 block max-w-2xl rounded-xl border border-(--ui-stroke-tertiary) bg-muted/35 p-3"
      data-kind={kind}
      data-slot="aui_result-media"
    >
      <span className="mb-2 block truncate text-xs font-medium text-muted-foreground">{title}</span>
      {!failed && !src && <span className="block text-sm text-muted-foreground">{copy.loading}</span>}
      {src && !failed && kind === 'audio' && (
        <audio
          className="block w-full"
          controls
          controlsList={NO_NATIVE_DOWNLOAD}
          onError={playerFailed}
          preload="metadata"
          src={src}
        />
      )}
      {src && !failed && kind === 'video' && (
        <TranscriptVideo
          className="m-0! block max-h-112 w-full rounded-lg bg-black"
          controls
          controlsList={NO_NATIVE_DOWNLOAD}
          onError={playerFailed}
          src={src}
        />
      )}
      {src && !failed && kind === 'image' && (
        <ZoomableImage
          alt={title}
          className="m-0! block h-auto w-auto max-h-(--image-preview-height) max-w-full rounded-lg object-contain"
          containerClassName="block w-fit max-w-[min(100%,var(--image-preview-max-width))]"
          onDownload={() => void download()}
          onError={playerFailed}
          slot="aui_markdown-image"
          src={src}
        />
      )}
      {failed && <span className="block text-sm text-muted-foreground">{copy.unplayable}</span>}
      <ResultActions kind={kind} path={path} />
    </span>
  )
}
