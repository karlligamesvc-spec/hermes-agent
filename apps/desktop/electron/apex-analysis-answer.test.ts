import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import type { SourceAnswerInput } from '../shared/analysis-answer'

import { createSourceAnswerHandlers } from './apex-analysis-answer'
import { addLocalNote, answerLocalDocument, createLocalDocument, deleteLocalDocument, getLocalDocument, localOverviewRevision, saveLocalSourceAnswer } from './apex-analysis-local'

it('atomically preserves notes, derives citations, rejects wrong owner/revision and never resurrects deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-answer-'))
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  try {
    const source = createLocalDocument(root, owner, Buffer.from('Revenue increased.'), { filename: 'facts.txt', kind: 'text',
      anchors: [{ id: 'a1', text: 'Revenue increased.', location: { paragraph: 2 } }] })

    const input: SourceAnswerInput = { schema: 1, revision: localOverviewRevision(source), locale: 'en',
      question: 'Revenue?', answer: 'Revenue grew.', answer_type: 'semantic_answer', anchor_ids: ['a1'] }

    addLocalNote(root, owner, source.id, 'Concurrent note', 'a1')
    const saved = saveLocalSourceAnswer(root, owner, source.id, input)
    const reopened = getLocalDocument(root, owner, source.id)!
    expect(reopened.questions).toEqual([saved])
    expect(saved.citations).toEqual([{ anchor_id: 'a1', location: { paragraph: 2 } }])
    expect(saved.source_revision).toBe(input.revision)
    expect(reopened.notes[0].body).toBe('Concurrent note')
    expect(() => saveLocalSourceAnswer(root, other, source.id, input)).toThrow('source_not_found')
    expect(() => saveLocalSourceAnswer(root, owner, source.id, { ...input, revision: 'b'.repeat(64) })).toThrow('answer_output_invalid')
    expect(() => saveLocalSourceAnswer(root, owner, source.id, { ...input, anchor_ids: ['fake'] })).toThrow('answer_output_invalid')
    expect(getLocalDocument(root, owner, source.id)!.questions).toEqual([saved])
    expect(answerLocalDocument(root, owner, source.id, 'Revenue')?.source_revision).toBe(input.revision)
    expect(answerLocalDocument(root, owner, source.id, 'Unknown launch')?.source_revision).toBe(input.revision)
    deleteLocalDocument(root, owner, source.id)
    expect(() => saveLocalSourceAnswer(root, owner, source.id, input)).toThrow('source_not_found')
    expect(getLocalDocument(root, owner, source.id)).toBeNull()
  } finally {fs.rmSync(root, { recursive: true, force: true })}
})

it('revalidates cloud account and revision before forwarding, including a sign-out during the save', async () => {
  const input: SourceAnswerInput = { schema: 1, revision: 'a'.repeat(64), locale: 'en', question: 'Revenue?',
    answer_type: 'semantic_answer', answer: 'Revenue grew.', anchor_ids: ['a1'] }

  const postJson = vi.fn().mockResolvedValue({ item: { id: 'q1' } })
  let account = 'owner'

  const context = vi.fn().mockResolvedValue({ local: false,
    context: { root: '', url: 'https://apex.test/documents', transport: { postJson } },
    item: { kind: 'text', status: 'ready', analysis_revision: input.revision, source_answers_supported: true,
      anchors: [{ id: 'a1', text: 'Revenue grew.', location: { paragraph: 2 } }] } })

  const handlers = createSourceAnswerHandlers({ context, currentAccount: () => account, error: error => String(error) })
  expect(await handlers.saveAnswer(null, 'source', account, input)).toEqual({ ok: true, item: { id: 'q1' } })
  expect(postJson).toHaveBeenCalledWith('https://apex.test/documents/source/questions/answers', input)
  postJson.mockClear()
  expect((await handlers.saveAnswer(null, 'source', account, { ...input, revision: 'b'.repeat(64) })).ok).toBe(false)
  account = 'other'
  expect((await handlers.questionContext(null, 'source', 'owner')).ok).toBe(false)
  expect((await handlers.saveAnswer(null, 'source', 'owner', input)).ok).toBe(false)
  expect(postJson).not.toHaveBeenCalled()
  account = 'owner'
  postJson.mockImplementationOnce(async () => { account = 'other';

 return { item: { id: 'q2' } } })
  expect((await handlers.saveAnswer(null, 'source', 'owner', input)).ok).toBe(false)
  account = 'owner'
  const current = await context()
  context.mockResolvedValueOnce({ ...current, item: { ...current.item, source_answers_supported: undefined } })
  expect(await handlers.questionContext(null, 'source', 'owner')).toMatchObject({ ok: false, code: expect.stringContaining('answer_backend_upgrade_required') })
})
