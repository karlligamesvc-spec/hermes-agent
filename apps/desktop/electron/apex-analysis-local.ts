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
  status: 'processing' | 'ready' | 'failed'
  error_code?: string | null
  parseAttempt?: string
  updatedAt?: string
  storageMode: 'local'
  anchors: AnalysisAnchor[]
  notes: Array<{ id: string; body: string; anchor_id: string | null }>
  questions: Array<{ id: string; question: string; answer: string; citations: Array<{ anchor_id: string; location: Record<string, number | string> }>; answer_type: 'source_excerpts' | 'no_evidence' }>
  createdAt: string
  sourcePath: string
  sourceUrl?: string
  evidenceOrigin?: 'linked_video_audio' | 'uploaded_video_audio'
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

    if (item.id !== id || item.storageMode !== 'local' || (item.kind !== 'feishu' && !['.pdf', '.docx', '.xlsx', '.txt', '.md', '.srt', '.vtt'].includes(ext))) {
      return null
    }

    if (!Array.isArray(item.anchors) || (item.kind === 'feishu'
      ? item.sourcePath !== '' || !item.sourceUrl || !/^https:\/\/(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com)\/(?:docx|wiki)\/[A-Za-z0-9_-]{8,128}$/i.test(item.sourceUrl)
      : item.sourcePath !== path.join(directory, `${id}${ext}`))) {
      return null
    }

    if (item.status === 'processing' && item.updatedAt && Date.now() - Date.parse(item.updatedAt) > 10 * 60_000) {
      item.status = 'failed'
      item.error_code = 'parse_interrupted'
      save(root, userId, item)
    }

    return item
  } catch {
    return null
  }
}

export function readLocalPdfPreview(root: string, userId: string, id: string): Buffer | null {
  const item = getLocalDocument(root, userId, id)

  if (!item || item.kind !== 'pdf' || item.status !== 'ready') {return null}

  try {
    const stat = fs.lstatSync(item.sourcePath)

    if (!stat.isFile() || !stat.size || stat.size > 15 * 1024 * 1024) {return null}

    const bytes = fs.readFileSync(item.sourcePath)

    return bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ? bytes : null
  } catch {return null}
}

export function createLocalPendingDocument(root: string, userId: string, filename: string, sourceBytes: Buffer): LocalDocument {
  const ext = path.extname(filename).toLowerCase()
  const kind = ({ '.pdf': 'pdf', '.docx': 'word', '.xlsx': 'excel', '.txt': 'text', '.md': 'text', '.srt': 'subtitle', '.vtt': 'subtitle' } as Record<string, string>)[ext]

  if (!kind) {throw new Error('unsupported_format')}

  if (!sourceBytes.length) {throw new Error('empty_file')}

  if (sourceBytes.length > 15 * 1024 * 1024) {throw new Error('file_too_large')}

  const id = `local-${crypto.randomUUID()}`
  const storedSource = path.join(accountDirectory(root, userId), `${id}${ext}`)
  fs.writeFileSync(storedSource, sourceBytes, { flag: 'wx', mode: 0o600 })

  try {
    const now = new Date().toISOString()

    const document: LocalDocument = {
      id, filename: path.basename(filename), kind, status: 'processing', storageMode: 'local',
      anchors: [], notes: [], questions: [], createdAt: now, updatedAt: now,
      sourcePath: storedSource, parseAttempt: crypto.randomUUID()
    }

    save(root, userId, document)

    return document
  } catch (error) {
    fs.rmSync(storedSource, { force: true })
    throw error
  }
}

export function completeLocalDocument(root: string, userId: string, id: string, attempt: string, parsed: { kind: string; anchors: AnalysisAnchor[] } | null, errorCode?: string): boolean {
  const document = getLocalDocument(root, userId, id)

  if (!document || document.status !== 'processing' || document.parseAttempt !== attempt) {return false}

  if (parsed && parsed.kind === document.kind && Array.isArray(parsed.anchors) && parsed.anchors.length > 0) {
    document.status = 'ready'
    document.anchors = parsed.anchors
    document.error_code = null
  } else {
    document.status = 'failed'
    document.anchors = []
    document.error_code = errorCode || 'parse_failed'
  }

  document.updatedAt = new Date().toISOString()
  delete document.parseAttempt
  save(root, userId, document)

  return true
}

export function retryLocalDocument(root: string, userId: string, id: string): { document: LocalDocument; bytes: Buffer; attempt: string } | null {
  const document = getLocalDocument(root, userId, id)

  if (!document || document.kind === 'feishu' || document.status !== 'failed') {return null}
  const bytes = fs.readFileSync(document.sourcePath)
  document.status = 'processing'
  document.error_code = null
  document.updatedAt = new Date().toISOString()
  document.parseAttempt = crypto.randomUUID()
  save(root, userId, document)

  return { document, bytes, attempt: document.parseAttempt }
}

export function createLocalFeishuDocument(root: string, userId: string, parsed: { filename: string; kind: string; source_url: string; anchors: AnalysisAnchor[] }): LocalDocument {
  if (parsed.kind !== 'feishu' || !Array.isArray(parsed.anchors) || parsed.anchors.length === 0) {throw new Error('No readable Feishu body')}

  const item: LocalDocument = {
    id: `local-${crypto.randomUUID()}`, filename: parsed.filename, kind: 'feishu', status: 'ready',
    storageMode: 'local', anchors: parsed.anchors, notes: [], questions: [],
    createdAt: new Date().toISOString(), sourcePath: '', sourceUrl: parsed.source_url
  }

  save(root, userId, item)

  return item
}

export function createLocalDocument(
  root: string,
  userId: string,
  sourceBytes: Buffer,
  parsed: { filename: string; kind: string; anchors: AnalysisAnchor[]; sourceUrl?: string; evidenceOrigin?: 'linked_video_audio' | 'uploaded_video_audio' }
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
      sourceUrl: parsed.sourceUrl,
      evidenceOrigin: parsed.evidenceOrigin,
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

/** Persist only the bounded transcript produced by the account-owned ASR path. */
export function createLocalVideoTranscript(
  root: string,
  userId: string,
  parsed: { filename: string; evidence_origin: string; source_url: string; srt: string; anchors: AnalysisAnchor[] }
): LocalDocument {
  if (parsed.evidence_origin !== 'linked_video_audio') {throw new Error('timed_evidence_invalid')}

  const url = new URL(parsed.source_url)
  const allowed = new Set(['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com', 'xhslink.com', 'xhslink.cn', 'www.xiaohongshu.com', 'b23.tv', 'www.bilibili.com'])

  if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.username || url.password || url.port) {throw new Error('unsupported_video_link')}

  if (!parsed.filename.endsWith('.srt') || !parsed.srt || !Array.isArray(parsed.anchors) || !parsed.anchors.length) {throw new Error('timed_evidence_invalid')}

  const item = createLocalDocument(root, userId, Buffer.from(parsed.srt, 'utf8'), {
    filename: parsed.filename, kind: 'subtitle', anchors: parsed.anchors, sourceUrl: parsed.source_url,
    evidenceOrigin: 'linked_video_audio'
  })

  return item
}

/** An uploaded video is transient on the server; only its verified SRT stays here. */
export function createLocalUploadedVideoTranscript(
  root: string,
  userId: string,
  parsed: { filename: string; evidence_origin: string; srt: string; anchors: AnalysisAnchor[] }
): LocalDocument {
  if (!parsed || parsed.evidence_origin !== 'uploaded_video_audio' || typeof parsed.filename !== 'string' || !parsed.filename.endsWith('.srt')
    || !parsed.srt || !Array.isArray(parsed.anchors) || !parsed.anchors.length
    || !parsed.anchors.every(anchor => typeof anchor.text === 'string' && !!anchor.text.trim()
      && typeof anchor.location?.start_seconds === 'number' && Number.isFinite(anchor.location.start_seconds)
      && anchor.location.start_seconds >= 0
      && typeof anchor.location?.end_seconds === 'number' && Number.isFinite(anchor.location.end_seconds)
      && anchor.location.end_seconds > anchor.location.start_seconds)) {
    throw new Error('timed_evidence_invalid')
  }

  return createLocalDocument(root, userId, Buffer.from(parsed.srt, 'utf8'), {
    filename: parsed.filename, kind: 'subtitle', anchors: parsed.anchors,
    evidenceOrigin: 'uploaded_video_audio'
  })
}

export function deleteLocalDocument(root: string, userId: string, id: string): boolean {
  const document = getLocalDocument(root, userId, id)

  if (!document) {return false}
  const directory = accountDirectory(root, userId)

  if (document.kind !== 'feishu') {
    const storedSource = path.resolve(document.sourcePath)

    if (!storedSource.startsWith(`${directory}${path.sep}`)) {throw new Error('Invalid source path')}
    fs.rmSync(storedSource, { force: true })
  }

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

  if (!document || document.status !== 'ready') {return null}
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
