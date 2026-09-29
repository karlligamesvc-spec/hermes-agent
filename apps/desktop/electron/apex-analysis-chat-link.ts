import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { type AnalysisChatLink, type AnalysisChatTarget, validAnalysisChatTarget } from '../shared/analysis-chat-link'

import { ownedAnalysisWorkspace } from './apex-analysis-workspace'

/** Only the latest accepted submission is retained, on this Desktop, inside its source workspace. */
export function writeAnalysisChatLink(root: string, scope: string, id: string, revision: string, target: AnalysisChatTarget): AnalysisChatLink {
  if (!validAnalysisChatTarget(target)) {throw new Error('workspace_invalid')}
  const directory = ownedAnalysisWorkspace(root, scope, id, revision)
  const filename = path.join(directory, 'apex-chat.json')
  const temp = path.join(directory, `.chat-${crypto.randomUUID()}.tmp`)

  const item: AnalysisChatLink = { sessionId: target.sessionId, connectionId: target.connectionId,
    profile: target.profile, submittedAt: new Date().toISOString() }

  try {
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, scope, sourceId: id, revision, item }), { flag: 'wx', mode: 0o600 })
    // rename replaces the directory entry, never follows an existing link.
    fs.renameSync(temp, filename)
  } finally {fs.rmSync(temp, { force: true })}

  return item
}

export function readAnalysisChatLink(root: string, scope: string, id: string, revision: string): AnalysisChatLink | null {
  let directory: string

  try {directory = ownedAnalysisWorkspace(root, scope, id, revision)} catch (error) {
    if (error instanceof Error && error.message === 'workspace_missing') {return null}
    throw error
  }

  const filename = path.join(directory, 'apex-chat.json')
  let fd: number | undefined

  try {
    let stat: fs.Stats

    try {stat = fs.lstatSync(filename)} catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return null}
      throw error
    }

    if (!stat.isFile() || stat.isSymbolicLink()) {throw new Error('workspace_invalid')}
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    stat = fs.fstatSync(fd)

    if (!stat.isFile() || stat.size > 4096) {throw new Error('workspace_invalid')}
    const buffer = Buffer.alloc(4097)
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0)

    if (count > 4096) {throw new Error('workspace_invalid')}
    const record = JSON.parse(buffer.subarray(0, count).toString('utf8'))

    if (record.schema !== 1 || record.scope !== scope || record.sourceId !== id || record.revision !== revision ||
      !validAnalysisChatTarget(record.item) || typeof record.item.submittedAt !== 'string' || !Number.isFinite(Date.parse(record.item.submittedAt))) {
      throw new Error('workspace_invalid')
    }

    return { sessionId: record.item.sessionId, connectionId: record.item.connectionId,
      profile: record.item.profile, submittedAt: record.item.submittedAt }
  } catch {throw new Error('workspace_invalid')} finally {if (fd !== undefined) {fs.closeSync(fd)}}
}
