import { useCallback, useEffect, useRef, useState } from 'react'

import type { AnalysisDocument, AnalysisDocumentsBridge, AnalysisVideoPlayback } from './analysis-types'

interface Video extends AnalysisVideoPlayback {
  documentId: string
  scope?: string
  revision?: string
}

export function useAnalysisVideo(source: AnalysisDocument | null, bridge: AnalysisDocumentsBridge | null) {
  const [video, setVideo] = useState<Video | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const id = source?.id
  const scope = source?.analysis_scope
  const revision = source?.analysis_revision

  const linked =
    source?.kind === 'subtitle' &&
    source.status === 'ready' &&
    (source.evidence_origin ?? source.evidenceOrigin) === 'linked_video_audio'

  const release = useCallback(
    (url: string) => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url)
      } else {
        void bridge?.releaseVideo?.(url).catch(() => {})
      }
    },
    [bridge]
  )

  useEffect(
    () => () => {
      if (video) {
        release(video.url)
      }
    },
    [video, release]
  )

  // Request ownership only; no reactive atom is mirrored into a ref.

  useEffect(() => {
    let active = true
    const request = ++generation.current
    setVideo(current =>
      current && current.documentId === id && current.scope === scope && current.revision === revision ? current : null
    )
    setError('')
    setLoading(false)

    if (!linked || !id || !scope || !revision || !bridge?.previewVideo) {
      return
    }

    setLoading(true)
    void bridge
      .previewVideo(id, scope, revision)
      .then(result => {
        if (!active || generation.current !== request) {
          if (result.playback) {
            release(result.playback.url)
          }

          return
        }

        if (!result.ok || !result.playback) {
          setError('video_playback_unavailable')

          return
        }

        setVideo({ ...result.playback, documentId: id, scope, revision })
      })
      .catch(() => {
        if (active && generation.current === request) {
          setError('video_playback_unavailable')
        }
      })
      .finally(() => {
        if (active && generation.current === request) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [id, scope, revision, linked, bridge, attempt, release])

  const attach = (
    document: Pick<AnalysisDocument, 'id' | 'analysis_scope' | 'analysis_revision'>,
    playback: AnalysisVideoPlayback
  ) => {
    generation.current += 1
    setLoading(false)
    setError('')
    setVideo({
      ...playback,
      documentId: document.id,
      scope: document.analysis_scope,
      revision: document.analysis_revision
    })
  }

  const clear = useCallback(() => {
    generation.current += 1
    setVideo(null)
  }, [])

  return {
    video: video && video.documentId === id && video.scope === scope && video.revision === revision ? video : null,
    attach,
    error,
    setError,
    clear,
    loading,
    retry: () => setAttempt(value => value + 1)
  }
}
