import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { addLocalNote, answerLocalDocument, createLocalDocument, deleteLocalDocument, getLocalDocument, listLocalDocuments, removeLocalNote } from './apex-analysis-local'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}
})

describe('account-scoped local analysis', () => {
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
