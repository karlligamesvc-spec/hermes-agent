import type { RefObject } from 'react'

import { Button } from '@/components/ui/button'

import { ANALYSIS_PAGE_COPY } from '../analysis-page-copy'
import type { AnalysisVideoPlayback } from '../analysis-types'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'

import { VIDEO_SOURCE_CHAT_COPY } from './video-source-chat-copy'

export interface AnalysisPlayerFrame {
  id: number
  videoUrl: string
  seconds: number
  dataUrl: string
}

function frameTimestamp(seconds: number): string {
  const tenths = Math.floor(seconds * 10 + 1e-6)
  const total = Math.floor(tenths / 10)
  const minutes = Math.floor(total / 60)

  const hours = Math.floor(total / 3600)

  const time = hours
    ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    : `${minutes}:${String(total % 60).padStart(2, '0')}`

  return `${time}.${tenths % 10}`
}

export function AnalysisVideoPlayer({
  activeVideo,
  loading,
  linked,
  locale,
  frames,
  videoRef,
  videoError,
  setVideoError,
  onAttach,
  onCapture,
  onRetry
}: {
  activeVideo: AnalysisVideoPlayback | null
  loading: boolean
  linked: boolean
  locale: VideoBreakdownLocale
  frames: AnalysisPlayerFrame[]
  videoRef: RefObject<HTMLVideoElement | null>
  videoError: string
  setVideoError: (error: string) => void
  onAttach: (playback: AnalysisVideoPlayback) => void
  onCapture: () => void
  onRetry: () => void
}) {
  const copy = ANALYSIS_PAGE_COPY[locale]
  const videoCopy = VIDEO_SOURCE_CHAT_COPY[locale]

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h3 className="font-medium">{copy.videoPlayer}</h3>
      {!activeVideo && !loading && <p className="text-xs text-(--ui-text-secondary)">{copy.videoPairing}</p>}
      {loading && <p role="status">{videoCopy.preparing}</p>}
      <label className="inline-block cursor-pointer rounded-lg border px-3 py-2 text-sm">
        {copy.attachVideo}
        <input
          accept="video/*"
          aria-label={copy.attachVideo}
          className="sr-only"
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''

            if (!file) {
              return
            }

            if (!file.type.startsWith('video/') && !(!file.type && /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(file.name))) {
              setVideoError(copy.videoUnsupported)

              return
            }

            onAttach({ name: file.name, url: URL.createObjectURL(file) })
          }}
          type="file"
        />
      </label>
      {activeVideo && (
        <video
          aria-label={`${copy.videoPlayer}: ${activeVideo.name}`}
          className="w-full rounded-lg bg-black"
          controls
          crossOrigin="anonymous"
          onError={() => setVideoError(copy.videoPlaybackFailed)}
          preload="metadata"
          ref={videoRef}
          src={activeVideo.url}
        />
      )}
      {activeVideo && (
        <button className="rounded-lg border px-3 py-2 text-sm" onClick={onCapture} type="button">
          {copy.frameCapture}
        </button>
      )}
      {activeVideo && frames.some(frame => frame.videoUrl === activeVideo.url) && (
        <div aria-label={copy.frameEvidence} className="space-y-2" role="region">
          <p className="text-xs text-(--ui-text-tertiary)">{copy.frameBoundary}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {frames
              .filter(frame => frame.videoUrl === activeVideo.url)
              .map(frame => (
                <figure className="rounded-lg border p-2" key={frame.id}>
                  <img
                    alt={`${copy.frameEvidence} · ${frameTimestamp(frame.seconds)}`}
                    className="w-full rounded bg-black"
                    src={frame.dataUrl}
                  />
                  <figcaption className="mt-1 text-xs text-(--ui-text-secondary)">
                    {frameTimestamp(frame.seconds)}
                  </figcaption>
                </figure>
              ))}
          </div>
        </div>
      )}
      {videoError && (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            {videoError === 'video_playback_unavailable' ? videoCopy.unavailable : videoError}
          </p>
          {linked && (
            <Button onClick={onRetry} size="sm" variant="outline">
              {videoCopy.retry}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
