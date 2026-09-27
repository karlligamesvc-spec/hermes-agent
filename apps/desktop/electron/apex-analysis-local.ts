/** Account-scoped local source store. Native paths never cross the preload bridge. */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface AnalysisAnchor {
  id: string
  location: Record<string, number | string>
  text: string
}

export interface LocalDocument {
  id: string
  filename: string
  kind: string
  status: 'ready'
  storageMode: 'local'
  anchors: AnalysisAnchor[]
  notes: Array<{ id: string; body: string; anchor_id: string | null }>
  questions: Array<{ id: string; question: string; answer: string; citations: Array<{ anchor_id: string; location: Record<string, number | string> }>; answer_type: 'source_excerpts' | 'no_evidence' }>
  createdAt: string
  sourcePath: string
}

function accountDirectory(root: string, userId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new Error('Invalid analysis account')
  }

  const directory = path.join(root, 'analysis-documents', userId.toLowerCase())
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

  return directory
}

function documentPath(root: string, userId: string, id: string): string {
  if (!/^local-[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('Invalid local analysis document')
  }

  return path.join(accountDirectory(root, userId), `${id}.json`)
}

function save(root: string, userId: string, document: LocalDocument): void {
  const target = documentPath(root, userId, document.id)
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(document), { mode: 0o600 })
  fs.renameSync(temporary, target)
}

export function listLocalDocuments(root: string, userId: string): LocalDocument[] {
  return fs.readdirSync(accountDirectory(root, userId))
    .filter(name => /^local-[0-9a-f-]{36}\.json$/i.test(name))
    .flatMap(name => {
      const item = getLocalDocument(root, userId, name.slice(0, -5))

      return item ? [item] : []
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function getLocalDocument(root: string, userId: string, id: string): LocalDocument | null {
  try {
    const item = JSON.parse(fs.readFileSync(documentPath(root, userId, id), 'utf8')) as LocalDocument
    const directory = accountDirectory(root, userId)
    const ext = path.extname(item.filename).toLowerCase()

    if (item.id !== id || item.storageMode !== 'local' || !['.pdf', '.docx', '.xlsx', '.txt', '.md'].includes(ext)) {
      return null
    }

    if (item.sourcePath !== path.join(directory, `${id}${ext}`) || !Array.isArray(item.anchors)) {
      return null
    }

    return item
  } catch {
    return null
  }
}

export function createLocalDocument(
  root: string,
  userId: string,
  sourceBytes: Buffer,
  parsed: { filename: string; kind: string; anchors: AnalysisAnchor[] }
): LocalDocument {
  const id = `local-${crypto.randomUUID()}`
  const directory = accountDirectory(root, userId)
  const ext = path.extname(parsed.filename).toLowerCase()
  const storedSource = path.join(directory, `${id}${ext}`)
  fs.writeFileSync(storedSource, sourceBytes, { flag: 'wx', mode: 0o600 })

  try {
    const document: LocalDocument = {
      id,
      filename: path.basename(parsed.filename),
      kind: parsed.kind,
      status: 'ready',
      storageMode: 'local',
      anchors: parsed.anchors,
      notes: [],
      questions: [],
      createdAt: new Date().toISOString(),
      sourcePath: storedSource
    }

    save(root, userId, document)

    return document
  } catch (error) {
    fs.rmSync(storedSource, { force: true })
    throw error
  }
}

export function deleteLocalDocument(root: string, userId: string, id: string): boolean {
  const document = getLocalDocument(root, userId, id)

  if (!document) {return false}
  const directory = accountDirectory(root, userId)
  const storedSource = path.resolve(document.sourcePath)

  if (!storedSource.startsWith(`${directory}${path.sep}`)) {throw new Error('Invalid source path')}
  fs.rmSync(storedSource, { force: true })
  fs.rmSync(documentPath(root, userId, id), { force: true })

  return true
}

export function addLocalNote(root: string, userId: string, id: string, body: string, anchorId: string | null) {
  const document = getLocalDocument(root, userId, id)

  if (!document) {return null}

  if (anchorId && !document.anchors.some(anchor => anchor.id === anchorId)) {throw new Error('Invalid anchor')}
  const note = { id: crypto.randomUUID(), body, anchor_id: anchorId }
  document.notes.push(note)
  save(root, userId, document)

  return note
}

export function removeLocalNote(root: string, userId: string, id: string, noteId: string): boolean {
  const document = getLocalDocument(root, userId, id)

  if (!document) {return false}
  const before = document.notes.length
  document.notes = document.notes.filter(note => note.id !== noteId)

  if (document.notes.length === before) {return false}
  save(root, userId, document)

  return true
}

export function answerLocalDocument(root: string, userId: string, id: string, question: string) {
  const document = getLocalDocument(root, userId, id)

  if (!document) {return null}
  const lowered = question.toLowerCase()
  const terms = new Set(lowered.match(/[a-z0-9_]{2,}/g) ?? [])
  const stopwords = new Set(['about', 'an', 'are', 'at', 'does', 'for', 'from', 'have', 'how', 'in', 'is', 'it', 'of', 'on', 'please', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'with', '什么', '如何', '多少', '请问', '关于', '是否', '能否', '这份', '文档', '资料', '内容'])

  for (const match of lowered.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < match.length; index += 1) {terms.add(match.slice(index, index + 2))}
  }

  for (const word of stopwords) {terms.delete(word)}

  if (!terms.size) {
    const item = { id: crypto.randomUUID(), question, answer: '', citations: [], answer_type: 'no_evidence' as const }
    document.questions.push(item)
    save(root, userId, document)

    return item
  }

  const cited = document.anchors
    .map(anchor => ({ anchor, score: [...terms].reduce((score, term) => score + anchor.text.toLowerCase().split(term).length - 1, 0) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(item => item.anchor)

  const item = {
    id: crypto.randomUUID(),
    question,
    answer: cited.map(anchor => anchor.text.slice(0, 600)).join('\n\n'),
    citations: cited.map(anchor => ({ anchor_id: anchor.id, location: anchor.location })),
    answer_type: cited.length ? 'source_excerpts' as const : 'no_evidence' as const
  }

  document.questions.push(item)
  save(root, userId, document)

  return item
}
