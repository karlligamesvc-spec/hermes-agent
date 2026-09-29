import type { OverviewSource } from '../shared/analysis-video-overview'

interface TranscriptSource extends OverviewSource {
  id: string
  analysis_scope?: string
  analysis_revision?: string
}

/** Export every stored timed anchor, or refuse the whole export. Never silently sample it. */
export function fullVideoTranscript(source: TranscriptSource, scope: string, revision: string): string {
  if (!scope || source.analysis_scope !== scope) {throw new Error('analysis_account_changed')}

  if (!revision || source.analysis_revision !== revision) {throw new Error('transcript_source_changed')}
  const anchors = source.anchors ?? []
  const origin = source.evidence_origin ?? source.evidenceOrigin

  if (source.kind !== 'subtitle' || source.status !== 'ready' ||
    !['linked_video_audio', 'uploaded_video_audio'].includes(origin ?? '') || !anchors.length ||
    new Set(anchors.map(anchor => anchor.id)).size !== anchors.length || anchors.some(anchor => {
      const { start_seconds: start, end_seconds: end } = anchor.location

      return !anchor.id || !anchor.text.trim() || typeof start !== 'number' || !Number.isFinite(start) || start < 0 ||
        typeof end !== 'number' || !Number.isFinite(end) || end <= start
    })) {throw new Error('transcript_evidence_invalid')}

  if (anchors.length > 20000) {throw new Error('transcript_too_large')}

  const text = JSON.stringify({
    schema: 1, source_id: source.id, source_revision: revision, evidence_origin: origin,
    // This is the complete stored ASR transcript, not proof that ASR captured every spoken word.
    evidence_kind: 'stored_audio_transcript',
    anchors: anchors.map(anchor => ({ id: anchor.id, start_seconds: anchor.location.start_seconds,
      end_seconds: anchor.location.end_seconds, text: anchor.text }))
  }, null, 2)

  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {throw new Error('transcript_too_large')}

  return text
}
