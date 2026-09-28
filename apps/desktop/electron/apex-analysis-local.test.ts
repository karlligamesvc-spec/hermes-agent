import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { addLocalNote, answerLocalDocument, completeLocalDocument, createLocalDocument, createLocalFeishuDocument, createLocalPendingDocument, deleteLocalDocument, getLocalDocument, listLocalDocuments, removeLocalNote, retryLocalDocument } from './apex-analysis-local'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}
})

describe('account-scoped local analysis', () => {
  it('retains subtitle bytes and cited timecodes under only the importing account', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-subtitle-test-'))
    roots.push(root)
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const bytes = Buffer.from('1\n00:01:02,500 --> 00:01:05,000\nRevenue rose\n')
    const pending = createLocalPendingDocument(root, owner, 'clip.srt', bytes)
    const location = { start_seconds: 62.5, end_seconds: 65 }

    expect(pending.kind).toBe('subtitle')
    expect(getLocalDocument(root, other, pending.id)).toBeNull()
    expect(completeLocalDocument(root, owner, pending.id, pending.parseAttempt!, {
      kind: 'subtitle', anchors: [{ id: 'a1', location, text: 'Revenue rose' }]
    })).toBe(true)
    expect(answerLocalDocument(root, owner, pending.id, 'Revenue')?.citations).toEqual([{ anchor_id: 'a1', location }])
    expect(fs.readFileSync(pending.sourcePath)).toEqual(bytes)
    expect(deleteLocalDocument(root, owner, pending.id)).toBe(true)
    expect(fs.existsSync(pending.sourcePath)).toBe(false)
  })

  it('records an asynchronous parse failure, retries stored bytes, and only answers ready text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-pending-test-'))
    roots.push(root)
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const pending = createLocalPendingDocument(root, owner, 'report.txt', Buffer.from('Revenue 423 units'))
    const firstAttempt = pending.parseAttempt!

    expect(pending.status).toBe('processing')
    expect(listLocalDocuments(root, other)).toEqual([])
    expect(answerLocalDocument(root, owner, pending.id, 'Revenue')).toBeNull()
    expect(completeLocalDocument(root, owner, pending.id, firstAttempt, null, 'parse_failed')).toBe(true)
    expect(getLocalDocument(root, owner, pending.id)?.error_code).toBe('parse_failed')

    const retry = retryLocalDocument(root, owner, pending.id)!
    expect(retry.bytes.toString('utf8')).toBe('Revenue 423 units')
    expect(retry.document.status).toBe('processing')
    expect(completeLocalDocument(root, owner, pending.id, firstAttempt, { kind: 'text', anchors: [{ id: 'a1', location: { paragraph: 1 }, text: 'stale' }] })).toBe(false)
    expect(completeLocalDocument(root, owner, pending.id, retry.attempt, { kind: 'text', anchors: [{ id: 'a1', location: { paragraph: 1 }, text: 'Revenue 423 units' }] })).toBe(true)
    expect(answerLocalDocument(root, owner, pending.id, 'Revenue')?.citations[0].anchor_id).toBe('a1')
    expect(retryLocalDocument(root, owner, pending.id)).toBeNull()
    expect(deleteLocalDocument(root, owner, pending.id)).toBe(true)
    expect(fs.existsSync(pending.sourcePath)).toBe(false)
  })

  it('turns an interrupted local parse into a retryable failure and cannot resurrect a deleted source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-interrupted-test-'))
    roots.push(root)
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const pending = createLocalPendingDocument(root, owner, 'report.txt', Buffer.from('Evidence'))
    const metadata = path.join(root, 'analysis-documents', owner, `${pending.id}.json`)
    fs.writeFileSync(metadata, JSON.stringify({ ...pending, updatedAt: '2000-01-01T00:00:00.000Z' }))

    expect(getLocalDocument(root, owner, pending.id)?.status).toBe('failed')
    expect(getLocalDocument(root, owner, pending.id)?.error_code).toBe('parse_interrupted')
    const retry = retryLocalDocument(root, owner, pending.id)!
    expect(deleteLocalDocument(root, owner, pending.id)).toBe(true)
    expect(completeLocalDocument(root, owner, pending.id, retry.attempt, { kind: 'text', anchors: [{ id: 'a1', location: { paragraph: 1 }, text: 'Evidence' }] })).toBe(false)
    expect(getLocalDocument(root, owner, pending.id)).toBeNull()
  })

  it('stores a Feishu source snapshot for one account without a fake local file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-feishu-test-'))
    roots.push(root)
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    const item = createLocalFeishuDocument(root, owner, {
      filename: 'Quarterly report', kind: 'feishu', source_url: 'https://team.feishu.cn/docx/docxtoken123',
      anchors: [{ id: 'block12345', location: { block: 'block12345', paragraph: 1 }, text: 'Revenue grew' }]
    })

    expect(item.sourcePath).toBe('')
    expect(getLocalDocument(root, owner, item.id)?.anchors[0].id).toBe('block12345')
    expect(getLocalDocument(root, other, item.id)).toBeNull()
    expect(answerLocalDocument(root, owner, item.id, 'Revenue')?.citations[0].anchor_id).toBe('block12345')
    expect(deleteLocalDocument(root, owner, item.id)).toBe(true)
    expect(getLocalDocument(root, owner, item.id)).toBeNull()

    const rootDomain = createLocalFeishuDocument(root, owner, {
      filename: 'Root-domain document', kind: 'feishu', source_url: 'https://feishu.cn/docx/docxtoken456',
      anchors: [{ id: 'block67890', location: { block: 'block67890', paragraph: 1 }, text: 'Evidence' }]
    })

    expect(getLocalDocument(root, owner, rootDomain.id)?.sourceUrl).toBe('https://feishu.cn/docx/docxtoken456')
  })

  it('persists original bytes, cited questions and notes only for the owner, then deletes both', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-test-'))
    roots.push(root)
    const source = path.join(root, 'report.txt')
    fs.writeFileSync(source, 'Revenue grew in the northern region.')
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    const item = createLocalDocument(root, owner, fs.readFileSync(source), {
      filename: 'report.txt',
      kind: 'text',
      anchors: [{ id: 'a1', location: { paragraph: 1 }, text: 'Revenue grew in the northern region.' }]
    })

    expect(getLocalDocument(root, other, item.id)).toBeNull()
    expect(listLocalDocuments(root, other)).toEqual([])
    expect(fs.readFileSync(item.sourcePath, 'utf8')).toContain('Revenue')

    const answered = answerLocalDocument(root, owner, item.id, 'Revenue in northern region')
    expect(answered?.citations).toEqual([{ anchor_id: 'a1', location: { paragraph: 1 } }])
    expect(answerLocalDocument(root, owner, item.id, 'unrelated forecast')?.answer_type).toBe('no_evidence')

    const note = addLocalNote(root, owner, item.id, 'Check this claim', 'a1')
    expect(note?.anchor_id).toBe('a1')
    expect(getLocalDocument(root, owner, item.id)?.notes).toHaveLength(1)
    expect(removeLocalNote(root, owner, item.id, note!.id)).toBe(true)
    expect(deleteLocalDocument(root, other, item.id)).toBe(false)
    expect(deleteLocalDocument(root, owner, item.id)).toBe(true)
    expect(fs.existsSync(item.sourcePath)).toBe(false)
    expect(getLocalDocument(root, owner, item.id)).toBeNull()
  })
})
