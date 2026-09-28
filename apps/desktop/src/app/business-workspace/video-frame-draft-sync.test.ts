import { describe, expect, it } from 'vitest'

import type { ComposerAttachment } from '@/store/composer'

import type { AnalysisDocument } from './analysis-types'
import { videoDeepBreakdownDraft } from './video-deep-breakdown-draft'
import { draftAfterVideoFrameRemoval, isVideoFrameDraftHandoff } from './video-frame-draft-sync'

const source: AnalysisDocument = {
  id: 'owned-video', filename: 'clip.srt', kind: 'subtitle', status: 'ready', storageMode: 'local',
  parseVersion: 'uploaded_video_audio_v1',
  anchors: [{ id: 'a1', location: { start_seconds: 2, end_seconds: 5 }, text: 'Verified speech' }]
}

const frame = (id: string, occurrenceId: string): ComposerAttachment => ({
  id, occurrenceId, kind: 'image', label: `${id}.jpg`, analysisFrameSourceId: source.id
})

describe('video frame draft evidence after removal', () => {
  it('removes only the deleted frame claim while preserving transcript, user edits and unrelated chips', () => {
    const first = frame('image:first', 'first-1')
    const second = frame('image:second', 'second-1')
    const ownImage = { id: 'user-image', occurrenceId: 'own-1', kind: 'image' as const, label: 'own.jpg' }
    const handoff = {
      locale: 'en' as const, sourceId: source.id, attemptedFrames: 3,
      frames: [
        { id: first.id, occurrenceId: first.occurrenceId!, seconds: 12.5 },
        { id: second.id, occurrenceId: second.occurrenceId!, seconds: 32.2 }
      ]
    }
    const original = `${videoDeepBreakdownDraft(source, 'en', [12.5, 32.2], 3)!}\nMy own question`

    expect(isVideoFrameDraftHandoff(handoff)).toBe(true)
    expect(draftAfterVideoFrameRemoval(original, handoff, [first, second, ownImage], ownImage.id)).toBe(original)

    const afterFirst = draftAfterVideoFrameRemoval(original, handoff, [first, second, ownImage], first.id)

    expect(afterFirst).toContain('[0:02–0:05] "Verified speech"')
    expect(afterFirst).toContain('0:32.2')
    expect(afterFirst).not.toContain('0:12.5')
    expect(afterFirst).toContain('1 captured frame(s) could not be attached')
    expect(afterFirst).toContain('1 frame(s) were removed from this draft')
    expect(afterFirst).toContain('My own question')

    const afterSecond = draftAfterVideoFrameRemoval(afterFirst, handoff, [second, ownImage], second.id)

    expect(afterSecond).not.toContain('Attached frames (')
    expect(afterSecond).not.toContain('0:32.2')
    expect(afterSecond).toContain('2 frame(s) were removed from this draft')
    expect(afterSecond).toContain('1 captured frame(s) could not be attached')
    expect(afterSecond).toContain('My own question')
  })

  it('rejects malformed route metadata and keeps user-edited evidence text intact', () => {
    const attachment = frame('image:first', 'first-1')
    const handoff = { locale: 'en' as const, sourceId: source.id, attemptedFrames: 1,
      frames: [{ id: attachment.id, occurrenceId: attachment.occurrenceId!, seconds: 12.5 }] }
    const draft = videoDeepBreakdownDraft(source, 'en', [12.5], 1)!

    expect(isVideoFrameDraftHandoff({ ...handoff, frames: [{ ...handoff.frames[0], seconds: Infinity }] })).toBe(false)
    expect(isVideoFrameDraftHandoff({ ...handoff, attemptedFrames: 0 })).toBe(false)
    expect(draftAfterVideoFrameRemoval(draft.replace('Attached frames (', 'My edited frames ('), handoff, [attachment], attachment.id))
      .toContain('My edited frames (')
  })
})
