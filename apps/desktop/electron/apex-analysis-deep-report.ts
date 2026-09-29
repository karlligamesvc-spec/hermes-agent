/** Native report picker and account-bound handoff. No renderer path is accepted. */
import fs from 'node:fs'
import path from 'node:path'

import { type DeepReportInput, MAX_REPORT_BYTES, validateDeepReport } from '../shared/analysis-deep-report'
import type { OverviewSource } from '../shared/analysis-video-overview'

import { removeLocalDeepReport, saveLocalDeepReport } from './apex-analysis-local'

interface ReportContext {
  context: { root: string; url: string; bearer: string; transport: { postJson: (url: string, body: unknown) => Promise<unknown> } }
  item: OverviewSource & { analysis_revision?: string }
  local: boolean
}
interface Dependencies {
  context: (id: string, scope: string, write?: boolean) => Promise<ReportContext>
  chooseFile: (event: unknown) => Promise<string | null>
  deleteCloud: (context: ReportContext['context'], url: string) => Promise<unknown>
  currentAccount: () => string | null
  error: (error: unknown) => string
}

export function readDeepReportFile(filePath: string): { filename: string; body: string } {
  let fd: number | undefined

  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
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
  return {
    importReport: async (event: unknown, id: string, scope: string, revision: string) => {
      try {
        const before = await deps.context(id, scope)

        if (before.item.analysis_revision !== revision) {throw new Error('report_source_changed')}
        const filePath = await deps.chooseFile(event)

        if (!filePath) {return { ok: false, code: 'cancelled' }}
        const current = await deps.context(id, scope)

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}
        const input: DeepReportInput = { ...readDeepReportFile(filePath), revision }
        validateDeepReport(input, current.item, current.item.analysis_revision ?? '')

        const item = current.local
          ? saveLocalDeepReport(current.context.root, scope, id, input)
          : (await current.context.transport.postJson(`${current.context.url}/${encodeURIComponent(id)}/deep-reports`, input) as { item: unknown }).item

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
