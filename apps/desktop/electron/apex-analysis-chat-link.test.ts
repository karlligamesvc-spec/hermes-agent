import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { readAnalysisChatLink, updateAnalysisChatOutcome, writeAnalysisChatLink } from './apex-analysis-chat-link'
import { createDeepReportHandlers } from './apex-analysis-deep-report'
import { createLocalUploadedVideoTranscript, deleteLocalDocument, getLocalDocument, localOverviewRevision } from './apex-analysis-local'
import { deleteAnalysisWorkspace, prepareAnalysisWorkspace } from './apex-analysis-workspace'

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const roots: string[] = []
afterEach(() => {for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}})
const target = { sessionId: 'stored-real-session', connectionId: 'local-connection', profile: 'worker' }

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc890-chat-'))
  roots.push(root)

  const source = createLocalUploadedVideoTranscript(root, owner, { filename: 'source.srt', srt: 'speech fixture', evidence_origin: 'uploaded_video_audio',
    anchors: [{ id: 'a1', text: 'spoken words', location: { start_seconds: 0, end_seconds: 2 } }] })

  const revision = localOverviewRevision(source)
  const directory = prepareAnalysisWorkspace(root, owner, source.id, revision)

  const context = vi.fn(async (id: string, scope: string) => {
    const item = getLocalDocument(root, scope, id)

    if (!item) {throw new Error('source_not_found')}

    return { context: { root, url: 'https://fixture.invalid', bearer: '', transport: { postJson: vi.fn() } },
      item: { ...item, analysis_revision: localOverviewRevision(item) }, local: true }
  })

  const deps = { context, currentAccount: () => owner as string, chooseFile: vi.fn(), deleteCloud: vi.fn(), error: (e: unknown) => (e as Error).message }

  return { root, source, revision, directory, deps, handlers: createDeepReportHandlers(deps) }
}

it('stores only the latest accepted target in an owned revision and retains no completion or report claim', async () => {
  const { root, source, revision, directory, handlers, deps } = setup()
  expect(await handlers.readChat(null, source.id, owner, revision)).toEqual({ ok: true, item: null })
  expect(fs.existsSync(path.join(directory, 'apex-chat.json'))).toBe(false)
  const first = await handlers.recordChat(null, source.id, owner, revision, target)
  expect(first).toEqual({ ok: true, item: { ...target, submittedAt: expect.any(String) } })
  const disk = JSON.parse(fs.readFileSync(path.join(directory, 'apex-chat.json'), 'utf8'))
  expect(disk).toEqual({ schema: 1, scope: owner, sourceId: source.id, revision, item: first.item })
  expect(deps.context.mock.calls.at(-1)).toEqual([source.id, owner])
  const second = await handlers.recordChat(null, source.id, owner, revision, { ...target, sessionId: 'next-stored-session' })
  expect(readAnalysisChatLink(root, owner, source.id, revision)).toEqual(second.item)
  expect(getLocalDocument(root, owner, source.id)?.deep_reports).toBeUndefined()
  expect(fs.existsSync(path.join(directory, 'ANALYSIS.md'))).toBe(false)
  deleteAnalysisWorkspace(root, owner, source.id)
  expect(await handlers.readChat(null, source.id, owner, revision)).toEqual({ ok: true, item: null })
})

it.each(['account', 'foreign_source', 'revision', 'deleted', 'receipt_owner', 'link', 'oversize', 'corrupt', 'invalid_target'] as const)('refuses an invalid or stale chat binding: %s', async failure => {
  const { root, source, revision, directory, deps, handlers } = setup()
  await handlers.recordChat(null, source.id, owner, revision, target)
  let scope = owner
  let rev = revision
  let expected = 'workspace_invalid'

  if (failure === 'account') {deps.currentAccount = () => other; expected = 'analysis_account_changed'}

  if (failure === 'foreign_source') {scope = other; expected = 'source_not_found'}

  if (failure === 'revision') {rev = '0'.repeat(64); expected = 'report_source_changed'}

  if (failure === 'deleted') {deleteLocalDocument(root, owner, source.id); expected = 'source_not_found'}

  if (failure === 'receipt_owner') {
    const file = path.join(directory, 'apex-source.json')
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8')); receipt.scope = other
    fs.writeFileSync(file, JSON.stringify(receipt))
  }

  const file = path.join(directory, 'apex-chat.json')

  if (failure === 'link') {const outside = path.join(root, 'outside.json'); fs.renameSync(file, outside); fs.symlinkSync(outside, file)}

  if (failure === 'oversize') {fs.writeFileSync(file, ' '.repeat(4097))}

  if (failure === 'corrupt') {const item = JSON.parse(fs.readFileSync(file, 'utf8')); item.scope = other; fs.writeFileSync(file, JSON.stringify(item))}

  if (failure === 'invalid_target') {
    expect(() => writeAnalysisChatLink(root, owner, source.id, revision, { ...target, sessionId: '' })).toThrow('workspace_invalid')
    expect(readAnalysisChatLink(root, owner, source.id, revision)?.sessionId).toBe(target.sessionId)

    return
  }

  expect(await handlers.readChat(null, source.id, scope, rev)).toEqual({ ok: false, code: expected })

  if (['account', 'foreign_source', 'revision', 'deleted', 'receipt_owner'].includes(failure)) {
    expect(await handlers.recordChat(null, source.id, scope, rev, target)).toEqual({ ok: false, code: expected })
  }
})


it('keeps a terminal outcome on its exact native receipt, never on the next accepted attempt', async () => {
  const { root, source, revision, directory, handlers, deps } = setup()
  const turn = { id: 'backend-turn', runtimeSessionId: 'runtime-not-stored' }
  const receipt = (await handlers.recordChat(null, source.id, owner, revision, { ...target, turn })).item!
  expect(receipt.turn).toEqual(turn)
  const running = await handlers.updateChatOutcome(null, source.id, owner, revision, receipt, 'running')
  expect(running.item?.outcome?.status).toBe('running')
  deps.currentAccount = () => other
  expect(await handlers.updateChatOutcome(null, source.id, owner, revision, receipt, 'complete')).toEqual({ ok: false, code: 'analysis_account_changed' })
  deps.currentAccount = () => owner
  const complete = await handlers.updateChatOutcome(null, source.id, owner, revision, receipt, 'complete')
  expect(complete.item?.outcome).toEqual({ status: 'complete', observedAt: expect.any(String) })
  expect(updateAnalysisChatOutcome(root, owner, source.id, revision, receipt, 'interrupted')).toEqual(complete.item)
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'apex-chat.json'), 'utf8')).item).toEqual(complete.item)
  const next = (await handlers.recordChat(null, source.id, owner, revision, { ...target, turn: { ...turn, id: 'next-turn' } })).item!
  expect(await handlers.updateChatOutcome(null, source.id, owner, revision, receipt, 'error')).toEqual({ ok: false, code: 'analysis_context_changed' })
  expect(readAnalysisChatLink(root, owner, source.id, revision)).toEqual(next)
  expect(next.outcome).toBeUndefined()
  expect(getLocalDocument(root, owner, source.id)?.deep_reports).toBeUndefined()
})
