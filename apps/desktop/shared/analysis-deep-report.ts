import { type AnalysisTurnState, validAnalysisTurnState, validAnalysisWorkspaceId } from './analysis-chat-link'
import type { OverviewSource } from './analysis-video-overview'

export const MAX_REPORT_BYTES = 64 * 1024
export const MAX_DEEP_REPORTS = 5
export interface ReportCollection {
  workspace_id: string
  submitted_at: string
  turn_id?: string
  observed_status?: AnalysisTurnState
}
export interface DeepReportReviewInput {
  revision: string
  sha256: string
  decision: 'accepted' | 'changes_requested' | 'unreviewed'
  note: string
}
export interface DeepReportInput { filename: string; body: string; revision: string; collection?: ReportCollection }
export interface DeepAnalysisReport extends DeepReportInput {
  id: string
  sha256: string
  created_at: string
  provenance: 'selected_file'
  review?: { decision: 'accepted' | 'changes_requested'; note: string; reviewed_at: string }
}

export function validateDeepReportSource(source: OverviewSource, requestedRevision: string, revision: string): void {
  if (source.status !== 'ready' || source.kind !== 'subtitle' ||
    !['linked_video_audio', 'uploaded_video_audio'].includes(source.evidence_origin ?? source.evidenceOrigin ?? '') ||
    !source.anchors?.length) {throw new Error('report_source_unavailable')}

  if (!revision || requestedRevision !== revision) {throw new Error('report_source_changed')}
}

/** Report imports are user-selected evidence, never proof that Hypit ran or verified its claims. */
export function validateDeepReport(input: DeepReportInput, source: OverviewSource, revision: string): DeepReportInput {
  validateDeepReportSource(source, input?.revision, revision)

  if (typeof input.filename !== 'string' || input.filename.length > 255 ||
    /[\\/]/.test(input.filename) || [...input.filename].some(char => char.charCodeAt(0) < 32) || !/\.(md|txt)$/i.test(input.filename) ||
    typeof input.body !== 'string' || !input.body.trim() || input.body.includes('\0')) {throw new Error('report_invalid')}

  if (new TextEncoder().encode(input.body).length > MAX_REPORT_BYTES) {throw new Error('report_too_large')}

  return { filename: input.filename, body: input.body, revision,
    ...(input.collection !== undefined ? { collection: validateReportCollection(input.collection) } : {}) }
}


/** Only minimal client-reported identity is portable; no local path/session/connection is serialized. */
export function validateReportCollection(value: ReportCollection): ReportCollection {
  if (!value || !validAnalysisWorkspaceId(value.workspace_id) || typeof value.submitted_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.submitted_at) ||
    !Number.isFinite(Date.parse(value.submitted_at)) || new Date(value.submitted_at).toISOString() !== value.submitted_at ||
    (value.turn_id !== undefined && !validAnalysisWorkspaceId(value.turn_id)) ||
    (value.observed_status !== undefined && (!value.turn_id || !validAnalysisTurnState(value.observed_status))) ||
    Object.keys(value).some(key => !['workspace_id', 'submitted_at', 'turn_id', 'observed_status'].includes(key))) {throw new Error('report_invalid')}

  return { workspace_id: value.workspace_id, submitted_at: value.submitted_at,
    ...(value.turn_id ? { turn_id: value.turn_id } : {}), ...(value.observed_status ? { observed_status: value.observed_status } : {}) }
}

export function sameReportCollection(a?: ReportCollection, b?: ReportCollection): boolean {
  return a?.workspace_id === b?.workspace_id && a?.submitted_at === b?.submitted_at && a?.turn_id === b?.turn_id
}

export function validateDeepReportReview(input: DeepReportReviewInput, report: DeepAnalysisReport | undefined,
  source: OverviewSource, revision: string): void {
  validateDeepReportSource(source, input?.revision, revision)

  if (!report) {throw new Error('report_not_found')}

  if (input.sha256 !== report.sha256 || input.revision !== report.revision) {throw new Error('report_source_changed')}

  if (!['accepted', 'changes_requested', 'unreviewed'].includes(input.decision) || typeof input.note !== 'string' ||
    input.note.includes('\0') || new TextEncoder().encode(input.note).length > 2000) {throw new Error('report_invalid')}
}
