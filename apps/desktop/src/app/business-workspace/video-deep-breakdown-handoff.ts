import { dataUrlToBlob } from '@/lib/embedded-images'

import type { AnalysisDocument } from './analysis-types'
import { type VideoBreakdownLocale, videoDeepBreakdownDraft } from './video-deep-breakdown-draft'

export interface CapturedVideoFrame {
  seconds: number
  dataUrl: string
}

/** Stage only screenshots the local composer actually accepted, then name that evidence in the draft. */
export async function prepareVideoBreakdownHandoff(
  document: AnalysisDocument,
  locale: VideoBreakdownLocale,
  frames: ReadonlyArray<CapturedVideoFrame>,
  attachImageBlob: (blob: Blob) => Promise<boolean | void> | boolean | void
): Promise<string | null> {
  if (!videoDeepBreakdownDraft(document, locale)) {return null}

  const attachedSeconds: number[] = []
  const attemptedFrames = Math.min(3, frames.length)

  for (const frame of frames.slice(0, 3)) {
    if (!Number.isFinite(frame.seconds) || frame.seconds < 0 ||
        !frame.dataUrl.startsWith('data:image/jpeg;base64,')) {continue}

    const blob = dataUrlToBlob(frame.dataUrl)

    if (!blob || blob.type !== 'image/jpeg' || blob.size === 0) {continue}

    const name = `apex-frame-${frame.seconds.toFixed(1).replace('.', '-')}s.jpg`

    try {
      if (await attachImageBlob(new File([blob], name, { type: 'image/jpeg' })) === true) {
        attachedSeconds.push(frame.seconds)
      }
    } catch {
      // The draft records this screenshot as unavailable. Earlier accepted
      // attachments remain visible in the composer for review or removal.
    }
  }

  return videoDeepBreakdownDraft(document, locale, attachedSeconds, attemptedFrames)
}
