import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { createDeepReportHandlers } from './apex-analysis-deep-report'
import { createLocalUploadedVideoTranscript, deleteLocalDocument, getLocalDocument, localOverviewRevision } from './apex-analysis-local'
import { analysisWorkspaceReport, deleteAnalysisWorkspace, prepareAnalysisWorkspace } from './apex-analysis-workspace'

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const roots: string[] = []
afterEach(() => {for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc887-workspace-'))
  roots.push(root)

  const source = createLocalUploadedVideoTranscript(root, owner, { filename: 'video.srt', srt: 'speech fixture',
    evidence_origin: 'uploaded_video_audio', anchors: [{ id: 'a1', text: 'spoken words', location: { start_seconds: 0, end_seconds: 2 } }] })

  const revision = localOverviewRevision(source)
  const postJson = vi.fn().mockResolvedValue({ item: { id: 'cloud-report' } })

  const context = vi.fn(async (id: string, scope: string) => {
    const item = getLocalDocument(root, scope, id)

    if (!item) {throw new Error('source_not_found')}

    return { context: { root, url: 'https://api.test/documents', bearer: 'owner-token', transport: { postJson } },
      item: { ...item, analysis_revision: localOverviewRevision(item) }, local: true }
  })

  const deps = { context, currentAccount: () => owner, chooseFile: vi.fn(), deleteCloud: vi.fn(), error: (error: unknown) => (error as Error).message }

  return { root, source, revision, deps, postJson, handlers: createDeepReportHandlers(deps) }
}

it('binds a real output folder, collects only explicitly selected outputs, preserves files on retry and routes both storage modes', async () => {
  const { root, source, revision, deps, postJson, handlers } = setup()
  expect(await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).toEqual({ ok: false, code: 'workspace_missing' })
  const prepared = await handlers.prepareWorkspace(null, source.id, owner, revision)
  expect(prepared.ok).toBe(true)
  const directory = prepared.directory!
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'apex-source.json'), 'utf8'))
  expect(receipt).toEqual({ schema: 1, scope: owner, source_id: source.id, revision })
  expect(await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).toEqual({ ok: false, code: 'workspace_report_missing' })
  fs.writeFileSync(path.join(root, 'ANALYSIS.md'), 'Wrong project')
  fs.writeFileSync(path.join(directory, 'ANALYSIS.md'), '# Actual output\n<script>unverified</script>')
  fs.writeFileSync(path.join(directory, 'TIMELINE.md'), '0:00 — spoken words')
  expect((await handlers.prepareWorkspace(null, source.id, owner, revision)).directory).toBe(directory)
  expect((await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).ok).toBe(true)
  expect((await handlers.collectReport(null, source.id, owner, revision, 'TIMELINE.md')).ok).toBe(true)
  expect((await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).ok).toBe(true)
  expect(deps.chooseFile).not.toHaveBeenCalled()
  const reports = getLocalDocument(root, owner, source.id)!.deep_reports!
  expect(reports).toHaveLength(2)
  expect(reports.map(report => [report.filename, report.body, report.provenance, report.revision])).toEqual([
    ['ANALYSIS.md', '# Actual output\n<script>unverified</script>', 'selected_file', revision],
    ['TIMELINE.md', '0:00 — spoken words', 'selected_file', revision]
  ])
  const owned = await deps.context(source.id, owner)
  deps.context.mockResolvedValue({ ...owned, local: false })
  expect(await handlers.collectReport(null, source.id, owner, revision, 'TIMELINE.md')).toEqual({ ok: true, item: { id: 'cloud-report' } })
  expect(postJson).toHaveBeenCalledExactlyOnceWith(`https://api.test/documents/${source.id}/deep-reports`, { filename: 'TIMELINE.md', body: '0:00 — spoken words', revision })
  postJson.mockImplementationOnce(async () => {deps.currentAccount = () => other;

 return { item: { id: 'late-report' } }})
  expect(await handlers.collectReport(null, source.id, owner, revision, 'TIMELINE.md')).toEqual({ ok: false, code: 'analysis_account_changed' })
  deleteAnalysisWorkspace(root, other, source.id)
  expect(fs.existsSync(directory)).toBe(true)
  deleteAnalysisWorkspace(root, owner, source.id)
  expect(fs.existsSync(directory)).toBe(false)
  expect(fs.readFileSync(path.join(root, 'ANALYSIS.md'), 'utf8')).toBe('Wrong project')
})

it('rejects substituted paths, receipts, revisions, oversized files and context changes before saving', async () => {
  for (const failure of ['scope', 'deleted', 'revision', 'receipt', 'filename', 'file_link', 'directory_link', 'parent_link', 'oversize', 'utf8', 'account_after_read'] as const) {
    const { root, source, revision, deps, handlers } = setup()
    const directory = prepareAnalysisWorkspace(root, owner, source.id, revision)
    const output = path.join(directory, 'ANALYSIS.md')
    fs.writeFileSync(output, 'Valid output')
    let scope = owner
    let filename = 'ANALYSIS.md'
    let expected = 'workspace_invalid'

    if (failure === 'scope') {scope = other; expected = 'source_not_found'}

    if (failure === 'deleted') {deleteLocalDocument(root, owner, source.id); expected = 'source_not_found'}

    if (failure === 'revision') {
      const current = await deps.context(source.id, owner)
      deps.context.mockResolvedValueOnce(current).mockResolvedValue({ ...current, item: { ...current.item, analysis_revision: 'b'.repeat(64) } })
      expected = 'report_source_changed'
    }

    if (failure === 'receipt') {fs.writeFileSync(path.join(directory, 'apex-source.json'), JSON.stringify({ schema: 1, scope: other, source_id: source.id, revision }))}

    if (failure === 'filename') {filename = '../ANALYSIS.md'; expected = 'report_invalid'}

    if (failure === 'file_link') {fs.renameSync(output, path.join(root, 'outside.md')); fs.symlinkSync(path.join(root, 'outside.md'), output)}

    if (failure === 'directory_link' || failure === 'parent_link') {
      const target = failure === 'directory_link' ? directory : path.dirname(directory)
      fs.renameSync(target, path.join(root, 'outside'))
      fs.symlinkSync(path.join(root, 'outside'), target, 'junction')
    }

    if (failure === 'oversize') {fs.writeFileSync(output, '中'.repeat(22000)); expected = 'report_too_large'}

    if (failure === 'utf8') {fs.writeFileSync(output, Buffer.from([0xff])); expected = 'report_unreadable'}

    if (failure === 'account_after_read') {deps.currentAccount = () => other; expected = 'analysis_account_changed'}
    expect(await handlers.collectReport(null, source.id, scope, revision, filename), failure).toEqual({ ok: false, code: expected })
    expect(getLocalDocument(root, owner, source.id)?.deep_reports, failure).toBeUndefined()
    expect(deps.chooseFile, failure).not.toHaveBeenCalled()
  }

  const { root, source, revision } = setup()
  expect(() => analysisWorkspaceReport(root, owner, source.id, revision, '/etc/passwd')).toThrow('report_invalid')
})
