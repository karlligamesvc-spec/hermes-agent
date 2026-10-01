import type { ComposerAttachment } from '@/store/composer'

import { type VideoBreakdownLocale, videoFrameDisclosure } from './video-deep-breakdown-draft'

export interface VideoFrameDraftHandoff {
  locale: VideoBreakdownLocale
  sourceId: string
  attemptedFrames: number
  frames: Array<{ id: string; occurrenceId: string; seconds: number }>
}

export function isVideoFrameDraftHandoff(value: unknown): value is VideoFrameDraftHandoff {
  if (!value || typeof value !== 'object') {return false}

  const item = value as Partial<VideoFrameDraftHandoff>

  return ['zh', 'zh-hant', 'en', 'ja', 'ar'].includes(item.locale ?? '') &&
    typeof item.sourceId === 'string' && item.sourceId.length > 0 &&
    typeof item.attemptedFrames === 'number' && Number.isInteger(item.attemptedFrames) &&
    item.attemptedFrames >= 0 && item.attemptedFrames <= 3 &&
    Array.isArray(item.frames) && item.frames.length <= item.attemptedFrames &&
    item.frames.every(frame => typeof frame.id === 'string' && Boolean(frame.id) &&
      typeof frame.occurrenceId === 'string' && Boolean(frame.occurrenceId) &&
      typeof frame.seconds === 'number' && Number.isFinite(frame.seconds) && frame.seconds >= 0)
}

/** Keep the evidence claim aligned with image chips the user actually retains. */
export function draftAfterVideoFrameRemoval(
  draft: string,
  handoff: VideoFrameDraftHandoff,
  attachments: readonly ComposerAttachment[],
  removedId: string
): string {
  const present = handoff.frames.filter(frame => attachments.some(item =>
    item.id === frame.id && item.occurrenceId === frame.occurrenceId &&
    item.analysisFrameSourceId === handoff.sourceId
  ))

  if (!present.some(frame => frame.id === removedId)) {return draft}

  const remaining = present.filter(frame => frame.id !== removedId)
  const failed = handoff.attemptedFrames - handoff.frames.length
  const before = videoFrameDisclosure(handoff.locale, present.map(frame => frame.seconds), failed, handoff.frames.length - present.length)
  const after = videoFrameDisclosure(handoff.locale, remaining.map(frame => frame.seconds), failed, handoff.frames.length - remaining.length)
  const originalBlock = `\n\n${before}`
  const blockStart = draft.lastIndexOf(originalBlock)
  const transcriptEnd = draft.indexOf('</source-transcript>')

  // User edits outside the generated evidence block survive. If the block
  // itself was edited, preserve their text; the prompt still instructs the
  // Agent to verify attachments that are present at send time.
  if (transcriptEnd < 0 || blockStart < transcriptEnd) {return draft}

  return draft.slice(0, blockStart) + `\n\n${after}` + draft.slice(blockStart + originalBlock.length)
}
