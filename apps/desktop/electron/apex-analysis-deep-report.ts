/** Native report picker and account-bound handoff. No renderer path is accepted. */
import fs from 'node:fs'
import path from 'node:path'

import { type AnalysisChatLink, type AnalysisChatTarget, type AnalysisTurnState, sameAnalysisChatLink } from '../shared/analysis-chat-link'
import { type DeepAnalysisReport, type DeepReportInput, type DeepReportReviewInput, MAX_REPORT_BYTES, validateDeepReport, validateDeepReportReview, validateDeepReportSource } from '../shared/analysis-deep-report'
import type { OverviewSource } from '../shared/analysis-video-overview'

import { readAnalysisChatLink, updateAnalysisChatOutcome, writeAnalysisChatLink } from './apex-analysis-chat-link'
import { removeLocalDeepReport, reviewLocalDeepReport, saveLocalDeepReport } from './apex-analysis-local'
import { analysisWorkspaceReport, hasAnalysisAttempts, prepareAnalysisAttempt } from './apex-analysis-workspace'

interface ReportContext {
  context: { root: string; url: string; bearer: string; transport: { postJson: (url: string, body: unknown) => Promise<unknown> } }
  item: OverviewSource & { analysis_revision?: string; deep_reports?: DeepAnalysisReport[] }
  local: boolean
}
interface Dependencies {
  context: (id: string, scope: string, write?: boolean) => Promise<ReportContext>
  chooseFile: (event: unknown) => Promise<string | null>
  deleteCloud: (context: ReportContext['context'], url: string) => Promise<unknown>
  currentAccount: () => string | null
  error: (error: unknown) => string
}

export function readDeepReportFile(filePath: string, noFollow = false): { filename: string; body: string } {
  let fd: number | undefined

  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (noFollow ? (fs.constants.O_NOFOLLOW ?? 0) : 0))
    const stat = fs.fstatSync(fd)

    if (!stat.isFile()) {throw new Error('report_invalid')}

    if (stat.size > MAX_REPORT_BYTES) {throw new Error('report_too_large')}
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1)
    let count = 0

    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count)

      if (!read) {break}
      count += read
    }

    if (count > MAX_REPORT_BYTES) {throw new Error('report_too_large')}
    const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))

    return { filename: path.basename(filePath), body }
  } catch (error) {
    if (error instanceof Error && ['report_invalid', 'report_too_large'].includes(error.message)) {throw error}
    throw new Error('report_unreadable')
  } finally { if (fd !== undefined) {fs.closeSync(fd)} }
}

export function createDeepReportHandlers(deps: Dependencies) {
  const saveSelected = async (id: string, scope: string, revision: string,
    choose: (before: ReportContext) => Promise<string | null>, workspaceFilename?: string) => {
    try {
      const before = await deps.context(id, scope)

      if (before.item.analysis_revision !== revision) {throw new Error('report_source_changed')}
      const submitted = workspaceFilename ? readAnalysisChatLink(before.context.root, scope, id, revision) : null

      if (workspaceFilename && !submitted && hasAnalysisAttempts(before.context.root, scope, id, revision)) {throw new Error('workspace_submission_missing')}

      const filePath = workspaceFilename
        ? analysisWorkspaceReport(before.context.root, scope, id, revision, workspaceFilename, submitted?.workspaceId)
        : await choose(before)

      if (!filePath) {return { ok: false, code: 'cancelled' }}
      const current = await deps.context(id, scope)

      if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

      if (workspaceFilename) {
        const latest = readAnalysisChatLink(current.context.root, scope, id, revision)

        if (submitted ? !sameAnalysisChatLink(latest, submitted) : latest !== null) {throw new Error('analysis_context_changed')}
      }

      // Recheck the confined path after awaits and after reading. A project/file symlink is never an output.
      const ownedPath = () => analysisWorkspaceReport(current.context.root, scope, id, revision, workspaceFilename!, submitted?.workspaceId)

      if (workspaceFilename && ownedPath() !== filePath) {throw new Error('workspace_invalid')}

      const input: DeepReportInput = { ...readDeepReportFile(filePath, Boolean(workspaceFilename)), revision,
        ...(submitted?.workspaceId ? { collection: { workspace_id: submitted.workspaceId, submitted_at: submitted.submittedAt,
          ...(submitted.turn ? { turn_id: submitted.turn.id } : {}),
          ...(submitted.outcome ? { observed_status: submitted.outcome.status } : {}) } } : {}) }

      if (workspaceFilename && ownedPath() !== filePath) {throw new Error('workspace_invalid')}
      validateDeepReport(input, current.item, current.item.analysis_revision ?? '')

      const item = current.local
        ? saveLocalDeepReport(current.context.root, scope, id, input)
        : (await current.context.transport.postJson(`${current.context.url}/${encodeURIComponent(id)}/deep-reports`, input) as { item: unknown }).item

      if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

      return { ok: true, item }
    } catch (error) {return { ok: false, code: deps.error(error) }}
  }

  return {
    importReport: (event: unknown, id: string, scope: string, revision: string) =>
      saveSelected(id, scope, revision, () => deps.chooseFile(event)),
    collectReport: (_event: unknown, id: string, scope: string, revision: string, filename: string) =>
      saveSelected(id, scope, revision, async () => null, filename),
    prepareWorkspace: async (_event: unknown, id: string, scope: string, revision: string): Promise<{ ok: boolean; code?: string; directory?: string; workspaceId?: string }> => {
      try {
        const { context, item } = await deps.context(id, scope)
        validateDeepReportSource(item, revision, item.analysis_revision ?? '')

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        return { ok: true, ...prepareAnalysisAttempt(context.root, scope, id, revision) }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    },
    recordChat: async (_event: unknown, id: string, scope: string, revision: string, target: AnalysisChatTarget) => {
      try {
        const { context, item } = await deps.context(id, scope)
        validateDeepReportSource(item, revision, item.analysis_revision ?? '')

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        return { ok: true, item: writeAnalysisChatLink(context.root, scope, id, revision, target) }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    },
    updateChatOutcome: async (_event: unknown, id: string, scope: string, revision: string, expected: AnalysisChatLink, status: AnalysisTurnState) => {
      try {
        const { context, item } = await deps.context(id, scope)
        validateDeepReportSource(item, revision, item.analysis_revision ?? '')

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        return { ok: true, item: updateAnalysisChatOutcome(context.root, scope, id, revision, expected, status) }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    },
    readChat: async (_event: unknown, id: string, scope: string, revision: string) => {
      try {
        const { context, item } = await deps.context(id, scope, false)
        validateDeepReportSource(item, revision, item.analysis_revision ?? '')

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        return { ok: true, item: readAnalysisChatLink(context.root, scope, id, revision) }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    },
    reviewReport: async (_event: unknown, id: string, scope: string, reportId: string, input: DeepReportReviewInput) => {
      try {
        const { context, item: source, local } = await deps.context(id, scope)

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}
        validateDeepReportReview(input, source.deep_reports?.find(report => report.id === reportId), source, source.analysis_revision ?? '')
        // Only these fields may cross the cloud boundary; the native/HTTP authority stamps time.
        const value: DeepReportReviewInput = { revision: input.revision, sha256: input.sha256, decision: input.decision, note: input.note }

        const item = local ? reviewLocalDeepReport(context.root, scope, id, reportId, value)
          : (await context.transport.postJson(`${context.url}/${encodeURIComponent(id)}/deep-reports/${encodeURIComponent(reportId)}/review`, value) as { item: DeepAnalysisReport }).item

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        return { ok: true, item }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    },
    deleteReport: async (_event: unknown, id: string, scope: string, reportId: string) => {
      try {
        const { context, local } = await deps.context(id, scope, false)

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        if (local) {
          if (!removeLocalDeepReport(context.root, scope, id, reportId)) {throw new Error('report_not_found')}
        } else {await deps.deleteCloud(context, `${context.url}/${encodeURIComponent(id)}/deep-reports/${encodeURIComponent(reportId)}`)}

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        return { ok: true }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    }
  }
}
