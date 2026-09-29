import type { OverviewSource } from './analysis-video-overview'

export const MAX_REPORT_BYTES = 64 * 1024
export const MAX_DEEP_REPORTS = 5
export interface DeepReportInput { filename: string; body: string; revision: string }
export interface DeepAnalysisReport extends DeepReportInput {
  id: string
  sha256: string
  created_at: string
  provenance: 'selected_file'
}

/** Report imports are user-selected evidence, never proof that Hypit ran or verified its claims. */
export function validateDeepReport(input: DeepReportInput, source: OverviewSource, revision: string): DeepReportInput {
  if (source.status !== 'ready' || source.kind !== 'subtitle' ||
    !['linked_video_audio', 'uploaded_video_audio'].includes(source.evidence_origin ?? source.evidenceOrigin ?? '') ||
    !source.anchors?.length) {throw new Error('report_source_unavailable')}

  if (!revision || input?.revision !== revision) {throw new Error('report_source_changed')}

  if (typeof input.filename !== 'string' || input.filename.length > 255 ||
    /[\\/]/.test(input.filename) || [...input.filename].some(char => char.charCodeAt(0) < 32) || !/\.(md|txt)$/i.test(input.filename) ||
    typeof input.body !== 'string' || !input.body.trim() || input.body.includes('\0')) {throw new Error('report_invalid')}

  if (new TextEncoder().encode(input.body).length > MAX_REPORT_BYTES) {throw new Error('report_too_large')}

  return { filename: input.filename, body: input.body, revision }
}
