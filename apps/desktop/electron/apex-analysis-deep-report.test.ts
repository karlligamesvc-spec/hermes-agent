import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { MAX_REPORT_BYTES } from '../shared/analysis-deep-report'

import { createDeepReportHandlers, readDeepReportFile } from './apex-analysis-deep-report'
import { addLocalNote, createLocalUploadedVideoTranscript, deleteLocalDocument, getLocalDocument, localOverviewRevision, removeLocalDeepReport, saveLocalDeepReport } from './apex-analysis-local'

const roots: string[] = []
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
afterEach(() => { for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })} })

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc884-reports-'))
  roots.push(root)

  const source = createLocalUploadedVideoTranscript(root, owner, {
    filename: 'clip.srt', evidence_origin: 'uploaded_video_audio', srt: '1\n00:00:01,000 --> 00:00:02,000\nEvidence\n',
    anchors: [{ id: 'a1', text: 'Evidence', location: { start_seconds: 1, end_seconds: 2 } }]
  })

  const file = path.join(root, 'ANALYSIS.md')
  fs.writeFileSync(file, '# 实际文件\n<script>unverified report content</script>')
  const revision = localOverviewRevision(source)
  const postJson = vi.fn()

  const context = vi.fn(async () => {
    const item = getLocalDocument(root, owner, source.id)

    if (!item) {throw new Error('source_not_found')}

    return { local: true, item: { ...item, analysis_revision: localOverviewRevision(item) }, context: { root, url: 'https://api.test/documents', bearer: 'owner-token', transport: { postJson } } }
  })

  const deps = { context, currentAccount: () => owner, chooseFile: vi.fn(async () => file), deleteCloud: vi.fn(), error: (e: unknown) => (e as Error).message }

  return { root, source, file, revision, deps, postJson }
}

it('saves a real selected file, merges notes, reopens, deduplicates, and deletes only the owned copy', async () => {
  const { root, source, file, revision, deps } = setup()
  deps.chooseFile.mockImplementationOnce(async () => {
    addLocalNote(root, owner, source.id, 'Added while picker open', 'a1')

    return file
  })
  const handlers = createDeepReportHandlers(deps)
  expect((await handlers.importReport(null, source.id, owner, revision)).ok).toBe(true)
  const saved = getLocalDocument(root, owner, source.id)!
  expect(saved.notes[0].body).toBe('Added while picker open')
  expect(saved.deep_reports).toHaveLength(1)
  expect(saved.deep_reports![0]).toMatchObject({ filename: 'ANALYSIS.md', body: fs.readFileSync(file, 'utf8'), provenance: 'selected_file', revision })
  expect(getLocalDocument(root, other, source.id)).toBeNull()
  expect((await handlers.importReport(null, source.id, owner, revision)).ok).toBe(true)
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toHaveLength(1)
  const reportId = saved.deep_reports![0].id
  expect(removeLocalDeepReport(root, other, source.id, reportId)).toBe(false)
  expect(await handlers.deleteReport(null, source.id, owner, reportId)).toEqual({ ok: true })
  expect(deps.context).toHaveBeenLastCalledWith(source.id, owner, false)
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toEqual([])
  expect(fs.existsSync(file)).toBe(true)
  expect(fs.existsSync(source.sourcePath)).toBe(true)
})

it.each(['account', 'deleted', 'revision', 'cancelled'])('does not save when the picker outlives %s', async change => {
  const { root, source, file, revision, deps } = setup()
  deps.chooseFile.mockImplementationOnce(async () => {
    if (change === 'account') {deps.currentAccount = () => other}

    if (change === 'deleted') {deleteLocalDocument(root, owner, source.id)}

    if (change === 'revision') {
      const changed = getLocalDocument(root, owner, source.id)!
      changed.anchors[0].text = 'Reparsed evidence'
      fs.writeFileSync(path.join(root, 'analysis-documents', owner, `${source.id}.json`), JSON.stringify(changed))
    }

    return change === 'cancelled' ? null as unknown as string : file
  })
  const result = await createDeepReportHandlers(deps).importReport(null, source.id, owner, revision)
  expect(result).toEqual({ ok: false, code: { account: 'analysis_account_changed', deleted: 'source_not_found', revision: 'report_source_changed', cancelled: 'cancelled' }[change] })
  expect(getLocalDocument(root, owner, source.id)?.deep_reports).toBeUndefined()
})

it('enforces UTF-8 byte and count limits without truncating or replacing older reports', () => {
  const { root, source, file, revision } = setup()
  const body = '中'.repeat(21845) + 'a'
  fs.writeFileSync(file, body)
  expect(Buffer.byteLength(readDeepReportFile(file).body)).toBe(MAX_REPORT_BYTES)

  for (let i = 0; i < 5; i++) {saveLocalDeepReport(root, owner, source.id, { filename: 'ANALYSIS.md', revision, body: body.slice(0, -1) + i })}
  const fifth = saveLocalDeepReport(root, owner, source.id, { filename: 'TIMELINE.md', revision, body: body.slice(0, -1) + '4' })
  expect(fifth.filename).toBe('ANALYSIS.md')
  expect(() => saveLocalDeepReport(root, owner, source.id, { filename: 'sixth.md', revision, body: 'sixth' })).toThrow('report_limit')
  fs.appendFileSync(file, 'a')
  expect(() => readDeepReportFile(file)).toThrow('report_too_large')
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe]))
  expect(() => readDeepReportFile(file)).toThrow('report_unreadable')
  expect(() => readDeepReportFile(root)).toThrow('report_invalid')
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toHaveLength(5)
})

it.each([{ filename: '../leak.md', body: 'content' }, { filename: 'report.html', body: 'content' }, { filename: 'report.md', body: ' \n' }, { filename: 'report.md', body: 'a\0b' }])('rejects invalid report input $filename', input => {
  const { root, source, revision } = setup()
  expect(() => saveLocalDeepReport(root, owner, source.id, { ...input, revision })).toThrow('report_invalid')
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toBeUndefined()
})

it('routes cloud operations through the captured owner context and discards late account results', async () => {
  const { source, revision, deps, postJson } = setup()
  const context = await deps.context()
  deps.context.mockResolvedValue({ ...context, local: false })
  postJson.mockResolvedValue({ item: { id: 'saved-report' } })
  const handlers = createDeepReportHandlers(deps)
  expect(await handlers.importReport(null, 'cloud-source', owner, revision)).toEqual({ ok: true, item: { id: 'saved-report' } })
  expect(postJson).toHaveBeenCalledWith('https://api.test/documents/cloud-source/deep-reports', expect.objectContaining({ revision, filename: 'ANALYSIS.md' }))
  await handlers.deleteReport(null, 'cloud-source', owner, 'saved-report')
  expect(deps.deleteCloud).toHaveBeenCalledWith(context.context, 'https://api.test/documents/cloud-source/deep-reports/saved-report')
  postJson.mockImplementationOnce(async () => { deps.currentAccount = () => other;

 return { item: { body: 'old account content' } } })
  expect(await handlers.importReport(null, source.id, owner, revision)).toEqual({ ok: false, code: 'analysis_account_changed' })
})

it('keeps collection identity and explicit review across reopen, retries and regeneration', async () => {
  const { root, source, revision, deps } = setup()

  const collection = { workspace_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', submitted_at: '2026-09-29T16:00:00.000Z',
    turn_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', observed_status: 'running' as const }

  const input = { filename: 'ANALYSIS.md', body: 'Selected report', revision, collection }
  const report = saveLocalDeepReport(root, owner, source.id, input)
  const handlers = createDeepReportHandlers(deps)
  expect(report.collection).toEqual(collection)
  expect(report.review).toBeUndefined()
  const review = { revision, sha256: report.sha256, decision: 'accepted' as const, note: '  Checked references  ' }
  const accepted = await handlers.reviewReport(null, source.id, owner, report.id, review)
  expect(accepted.ok).toBe(true)
  expect(accepted.item!.review).toMatchObject({ decision: 'accepted', note: 'Checked references' })
  expect(accepted.item!.provenance).toBe('selected_file')
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toEqual([accepted.item])
  expect(saveLocalDeepReport(root, owner, source.id, { ...input, collection: { ...collection, observed_status: 'complete' } })).toEqual(accepted.item)
  const changed = saveLocalDeepReport(root, owner, source.id, { ...input, body: 'Revised findings' })
  const next = saveLocalDeepReport(root, owner, source.id, { ...input, collection: { ...collection, workspace_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } })
  expect(new Set([report.id, changed.id, next.id]).size).toBe(3)
  expect(changed.review).toBeUndefined(); expect(next.review).toBeUndefined()
  expect((await handlers.reviewReport(null, source.id, owner, report.id, { ...review, decision: 'changes_requested', note: '<script>inert</script>' })).item!.review?.decision).toBe('changes_requested')
  expect((await handlers.reviewReport(null, source.id, owner, report.id, { ...review, decision: 'unreviewed' })).item!.review).toBeUndefined()
  expect(getLocalDocument(root, owner, source.id)!.deep_reports![0].collection).toEqual(collection)
})

it.each(['account', 'deleted', 'revision', 'hash', 'missing', 'note', 'decision'] as const)('refuses review after %s changes without changing saved reports', async mode => {
  const { root, source, revision, deps } = setup()
  const report = saveLocalDeepReport(root, owner, source.id, { filename: 'ANALYSIS.md', body: 'Report', revision })
  const input = { revision, sha256: report.sha256, decision: 'accepted' as const, note: '' }
  let id = report.id

  if (mode === 'account') {deps.currentAccount = () => other}

  if (mode === 'deleted') {deleteLocalDocument(root, owner, source.id)}

  if (mode === 'revision') {input.revision = 'stale'}

  if (mode === 'hash') {input.sha256 = 'wrong'}

  if (mode === 'missing') {id = 'missing'}

  if (mode === 'note') {input.note = '中'.repeat(667)}

  if (mode === 'decision') {Object.assign(input, { decision: 'verified' })}
  expect((await createDeepReportHandlers(deps).reviewReport(null, source.id, owner, id, input)).ok).toBe(false)

  if (mode !== 'deleted') {expect(getLocalDocument(root, owner, source.id)!.deep_reports).toEqual([report])}
})

it('uses the cloud review route with bounded fields and discards late account results', async () => {
  const { root, source, revision, deps, postJson } = setup()
  const report = saveLocalDeepReport(root, owner, source.id, { filename: 'ANALYSIS.md', body: 'Report', revision })
  const current = await deps.context()
  deps.context.mockResolvedValue({ ...current, local: false })
  const input = { revision, sha256: report.sha256, decision: 'accepted' as const, note: 'Review' }
  postJson.mockResolvedValue({ item: { ...report, review: { decision: 'accepted', note: 'Review', reviewed_at: '2026-09-29T16:00:00Z' } } })
  const handlers = createDeepReportHandlers(deps)
  expect((await handlers.reviewReport(null, source.id, owner, report.id, { ...input, private_path: '/do-not-send' } as typeof input)).ok).toBe(true)
  expect(postJson).toHaveBeenCalledExactlyOnceWith(`https://api.test/documents/${source.id}/deep-reports/${report.id}/review`, input)
  postJson.mockImplementationOnce(async () => {deps.currentAccount = () => other;

 return { item: report }})
  expect(await handlers.reviewReport(null, source.id, owner, report.id, input)).toEqual({ ok: false, code: 'analysis_account_changed' })
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toEqual([report])
})

it.each([{ workspace_id: '../escape' }, { submitted_at: '2026-02-30T16:00:00.000Z' }, { path: '/private' }, { observed_status: 'complete' }])('rejects invalid or private collection metadata', extra => {
  const { root, source, revision } = setup()
  const collection = { workspace_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', submitted_at: '2026-09-29T16:00:00.000Z', ...extra }
  expect(() => saveLocalDeepReport(root, owner, source.id, { filename: 'ANALYSIS.md', body: 'Report', revision, collection } as Parameters<typeof saveLocalDeepReport>[3])).toThrow('report_invalid')
  expect(getLocalDocument(root, owner, source.id)!.deep_reports).toBeUndefined()
})
