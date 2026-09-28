import type { AnalysisAnchor, AnalysisDocument } from './analysis-types'

export interface VideoQuickOverview {
  count: number
  firstSeconds: number
  lastSeconds: number
  samples: AnalysisAnchor[]
}

/** An evidence index, not a semantic summary or a claim about unseen frames. */
export function videoQuickOverview(document: AnalysisDocument | null): VideoQuickOverview | null {
  if (document?.kind !== 'subtitle' || document.status !== 'ready') {return null}

  const fromVideo = Boolean(document.source_url || document.sourceUrl ||
    ['uploaded_video_audio_v1'].includes(document.parse_version ?? document.parseVersion ?? ''))

  if (!fromVideo) {return null}

  const timed = (document.anchors ?? []).filter(anchor => {
    const start = anchor.location.start_seconds
    const end = anchor.location.end_seconds

    return typeof start === 'number' && Number.isFinite(start) && start >= 0 &&
      typeof end === 'number' && Number.isFinite(end) && end > start && Boolean(anchor.text.trim())
  }).sort((a, b) => Number(a.location.start_seconds) - Number(b.location.start_seconds))

  if (timed.length === 0) {return null}

  const positions = [...new Set([0, Math.floor((timed.length - 1) / 2), timed.length - 1])]

  return {
    count: timed.length,
    firstSeconds: Number(timed[0].location.start_seconds),
    lastSeconds: Math.max(...timed.map(anchor => Number(anchor.location.end_seconds))),
    samples: positions.map(index => timed[index])
  }
}
