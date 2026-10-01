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
  expect(receipt).toEqual({ schema: 1, scope: owner, source_id: source.id, revision, workspace_id: prepared.workspaceId })
  expect(await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).toEqual({ ok: false, code: 'workspace_submission_missing' })
  expect((await handlers.recordChat(null, source.id, owner, revision, { sessionId: 'accepted', connectionId: null, profile: 'default', workspaceId: prepared.workspaceId })).ok).toBe(true)
  expect(await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).toEqual({ ok: false, code: 'workspace_report_missing' })
  fs.writeFileSync(path.join(root, 'ANALYSIS.md'), 'Wrong project')
  fs.writeFileSync(path.join(directory, 'ANALYSIS.md'), '# Actual output\n<script>unverified</script>')
  fs.writeFileSync(path.join(directory, 'TIMELINE.md'), '0:00 — spoken words')
  const unsent = await handlers.prepareWorkspace(null, source.id, owner, revision)
  expect(unsent.directory).not.toBe(directory)
  fs.writeFileSync(path.join(unsent.directory!, 'ANALYSIS.md'), 'Never sent')
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
  expect(postJson).toHaveBeenCalledExactlyOnceWith(`https://api.test/documents/${source.id}/deep-reports`, { filename: 'TIMELINE.md', body: '0:00 — spoken words', revision, collection: reports[1].collection })
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

it('gives each preparation a fresh output directory without consuming a previous report', async () => {
  const { source, revision, handlers } = setup()
  const first = await handlers.prepareWorkspace(null, source.id, owner, revision)
  expect(first.ok).toBe(true)
  fs.writeFileSync(path.join(first.directory!, 'ANALYSIS.md'), 'Old attempt output')
  const second = await handlers.prepareWorkspace(null, source.id, owner, revision)
  expect(second.ok).toBe(true)
  expect(second.directory).not.toBe(first.directory)
  expect(fs.existsSync(path.join(second.directory!, 'ANALYSIS.md'))).toBe(false)
  expect(fs.readFileSync(path.join(first.directory!, 'ANALYSIS.md'), 'utf8')).toBe('Old attempt output')
})


it('uses only the latest accepted output, keeps unsent drafts inert, and never falls back to old or legacy files', async () => {
  const { root, source, revision, handlers } = setup()
  const first = await handlers.prepareWorkspace(null, source.id, owner, revision)
  const target = { sessionId: 'same-chat', connectionId: null, profile: 'default' }
  await handlers.recordChat(null, source.id, owner, revision, { ...target, workspaceId: first.workspaceId })
  fs.writeFileSync(path.join(first.directory!, 'ANALYSIS.md'), 'First accepted')
  fs.writeFileSync(path.join(prepareAnalysisWorkspace(root, owner, source.id, revision), 'ANALYSIS.md'), 'Legacy stale')
  const second = await handlers.prepareWorkspace(null, source.id, owner, revision)
  expect((await handlers.readChat(null, source.id, owner, revision)).item?.workspaceId).toBe(first.workspaceId)
  expect((await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).ok).toBe(true)
  expect(getLocalDocument(root, owner, source.id)!.deep_reports!.map(report => report.body)).toEqual(['First accepted'])
  expect((await handlers.recordChat(null, source.id, owner, revision, { ...target, workspaceId: second.workspaceId })).ok).toBe(true)
  expect(await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).toEqual({ ok: false, code: 'workspace_report_missing' })
  fs.writeFileSync(path.join(second.directory!, 'ANALYSIS.md'), 'Second accepted')
  expect((await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).ok).toBe(true)
  expect(getLocalDocument(root, owner, source.id)!.deep_reports!.map(report => report.body)).toEqual(['First accepted', 'Second accepted'])
  expect(fs.readFileSync(path.join(first.directory!, 'ANALYSIS.md'), 'utf8')).toBe('First accepted')
})

it('rejects a different workspace binding while collection is awaiting context, even in the same chat and timestamp', async () => {
  const { root, source, revision, deps, handlers } = setup()
  const first = await handlers.prepareWorkspace(null, source.id, owner, revision)
  const second = await handlers.prepareWorkspace(null, source.id, owner, revision)
  const target = { sessionId: 'same-chat', connectionId: null, profile: 'default', workspaceId: first.workspaceId }
  await handlers.recordChat(null, source.id, owner, revision, target)
  fs.writeFileSync(path.join(first.directory!, 'ANALYSIS.md'), 'Do not save the stale selection')
  const current = await deps.context(source.id, owner)
  deps.context.mockResolvedValueOnce(current).mockImplementationOnce(async () => {
    const receipt = path.join(prepareAnalysisWorkspace(root, owner, source.id, revision), 'apex-chat.json')
    const binding = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    binding.item.workspaceId = second.workspaceId
    fs.writeFileSync(receipt, JSON.stringify(binding))

    return current
  })
  expect(await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).toEqual({ ok: false, code: 'analysis_context_changed' })
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toBeUndefined()
})

it.each(['id', 'scope', 'revision', 'receipt', 'attempt_link', 'parent_link'] as const)('refuses a substituted %s before associating or collecting an attempt', async failure => {
  const { root, source, revision, handlers } = setup()
  const first = await handlers.prepareWorkspace(null, source.id, owner, revision)
  const directory = first.directory!
  fs.writeFileSync(path.join(directory, 'ANALYSIS.md'), 'Must not save')
  const target = { sessionId: 'chat', connectionId: null, profile: 'default', workspaceId: first.workspaceId }
  expect((await handlers.recordChat(null, source.id, owner, revision, target)).ok).toBe(true)
  let changedId = target.workspaceId

  if (failure === 'id') {changedId = '../../other'}

  if (['scope', 'revision', 'receipt'].includes(failure)) {
    const file = path.join(directory, 'apex-source.json')
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))

    if (failure === 'scope') {receipt.scope = other}

    if (failure === 'revision') {receipt.revision = 'c'.repeat(64)}

    if (failure === 'receipt') {receipt.workspace_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}
    fs.writeFileSync(file, JSON.stringify(receipt))
  }

  if (failure === 'attempt_link' || failure === 'parent_link') {
    const replaced = failure === 'attempt_link' ? directory : path.dirname(directory)
    const outside = path.join(root, 'outside')
    fs.renameSync(replaced, outside)
    fs.symlinkSync(outside, replaced, 'junction')
  }

  expect(await handlers.recordChat(null, source.id, owner, revision, { ...target, workspaceId: changedId })).toEqual({ ok: false, code: 'workspace_invalid' })

  if (failure !== 'id') {expect(await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).toEqual({ ok: false, code: 'workspace_invalid' })}
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toBeUndefined()
})

it('keeps previously submitted legacy folders readable while a new draft is still unsent', async () => {
  const { root, source, revision, handlers } = setup()
  const legacy = prepareAnalysisWorkspace(root, owner, source.id, revision)
  fs.writeFileSync(path.join(legacy, 'ANALYSIS.md'), 'Legacy selected file')
  expect((await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).ok).toBe(true)
  await handlers.recordChat(null, source.id, owner, revision, { sessionId: 'legacy-chat', connectionId: null, profile: 'default' })
  await handlers.prepareWorkspace(null, source.id, owner, revision)
  expect((await handlers.collectReport(null, source.id, owner, revision, 'ANALYSIS.md')).ok).toBe(true)
  expect(getLocalDocument(root, owner, source.id)!.deep_reports!.map(report => report.body)).toEqual(['Legacy selected file'])
})
