import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { attachmentId } from '@/lib/chat-runtime'
import { $composerAttachments, type ComposerAttachment, createComposerAttachmentOccurrenceId, mainComposerScope } from '@/store/composer'

import type { WiringActions } from '../contrib/types'

import type { AnalysisDocument } from './analysis-types'
import type { VideoBreakdownLocale } from './video-deep-breakdown-draft'
import { type CapturedVideoFrame, prepareVideoBreakdownHandoff } from './video-deep-breakdown-handoff'
import { VIDEO_TRANSCRIPT_COPY, type VideoTranscriptDraftHandoff } from './video-transcript-draft'
import { videoWorkspaceDraft } from './video-workspace-draft'

/** Prepare owned evidence for explicit user submission; roll back only this attempt on a scope change. */
export async function stageVideoAnalysisDraft(document: AnalysisDocument, locale: VideoBreakdownLocale,
  frames: readonly CapturedVideoFrame[], actions: WiringActions, isCurrent: () => boolean) {
  const accepted: ComposerAttachment[] = []
  const routedFrames: Array<{ id: string; occurrenceId: string; seconds: number }> = []
  let transcript: VideoTranscriptDraftHandoff | undefined
  const read = window.hermesDesktop?.analysisDocuments?.transcriptForDraft

  const readTranscript = async () => {
    if (!isCurrent()) {throw new Error('analysis_context_changed')}

    if (!read) {return undefined} // Older native bridges retain an explicitly excerpt-only draft.
    const result = await read(document.id, document.analysis_scope ?? '', document.analysis_revision ?? '')

    if (!isCurrent()) {throw new Error('analysis_context_changed')}

    if (!result.ok && result.code !== 'transcript_too_large') {throw new Error(result.code ?? 'transcript_unavailable')}

    return result.ok ? result.text : undefined
  }

  // Discover the exact newly created chip, never another file with the same label.
  const attach = async (kind: 'file' | 'image', run: () => Promise<boolean | void> | boolean | void,
    patch: Partial<ComposerAttachment>) => {
    if (!isCurrent()) {throw new Error('analysis_context_changed')}
    const before = new Set($composerAttachments.get().map(item => item.occurrenceId))
    const result = await run()

    const added = $composerAttachments.get().find(item =>
      item.kind === kind && item.occurrenceId && !before.has(item.occurrenceId))

    if (result === true && added) {accepted.push(added)}

    if (!isCurrent()) {throw new Error('analysis_context_changed')}

    if (result !== true || !added || !mainComposerScope.updateIfCurrent(added, patch)) {return undefined}
    accepted[accepted.length - 1] = { ...added, ...patch }

    return added
  }

  try {
    const text = await readTranscript()

    mainComposerScope.removeOccurrences($composerAttachments.get().filter(item =>
      item.analysisFrameSourceId || item.analysisTranscriptSourceId))

    if (text && window.hermesDesktop?.savePastedText) {
      // Native paste storage owns the path; only add a chip after the context check.
      const path = await window.hermesDesktop.savePastedText(text).catch(() => '')

      if (!isCurrent()) {throw new Error('analysis_context_changed')}

      if (path) {
        const item: ComposerAttachment = {
          id: attachmentId('file', path), occurrenceId: createComposerAttachmentOccurrenceId(), kind: 'file',
          label: VIDEO_TRANSCRIPT_COPY[locale].label, path, refText: `@file:${formatRefValue(path)}`,
          analysisTranscriptSourceId: document.id
        }

        mainComposerScope.add(item)
        accepted.push(item)
        transcript = { locale, sourceId: document.id, id: item.id, occurrenceId: item.occurrenceId! }
      }
    }

    const prepareWorkspace = window.hermesDesktop?.analysisDocuments?.prepareDeepWorkspace
    let workspaceNote = ''

    if (prepareWorkspace) {
      if (!isCurrent()) {throw new Error('analysis_context_changed')}
      const result = await prepareWorkspace(document.id, document.analysis_scope ?? '', document.analysis_revision ?? '')

      if (!isCurrent()) {throw new Error('analysis_context_changed')}

      if (!result.ok || !result.directory) {throw new Error(result.code ?? 'workspace_invalid')}
      workspaceNote = videoWorkspaceDraft(locale, result.directory)
    }

    const draft = await prepareVideoBreakdownHandoff(document, locale, frames, async (blob, seconds) => {
      const added = await attach('image', () => actions.onAttachImageBlob(blob), { analysisFrameSourceId: document.id })

      if (!added) {return false}
      routedFrames.push({ id: added.id, occurrenceId: added.occurrenceId!, seconds })

      return true
    }, VIDEO_TRANSCRIPT_COPY[locale][transcript ? 'attached' : 'unavailable'] + workspaceNote)

    // File writes and frame staging can outlive a sign-out, source deletion, or retry.
    await readTranscript()

    if (!draft) {throw new Error('transcript_evidence_invalid')}

    return { draft, attachments: accepted, frames: routedFrames, transcript }
  } catch (error) {
    mainComposerScope.removeOccurrences(accepted)
    throw error
  }
}
