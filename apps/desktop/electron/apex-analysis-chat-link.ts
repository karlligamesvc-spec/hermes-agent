import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { type AnalysisChatLink, type AnalysisChatTarget, type AnalysisTurnState, sameAnalysisChatLink, validAnalysisChatTarget, validAnalysisTurnState } from '../shared/analysis-chat-link'

import { ownedAnalysisAttempt, ownedAnalysisWorkspace } from './apex-analysis-workspace'

/** Only the latest accepted submission is retained, on this Desktop, inside its source workspace. */
export function writeAnalysisChatLink(root: string, scope: string, id: string, revision: string, target: AnalysisChatTarget): AnalysisChatLink {
  if (!validAnalysisChatTarget(target)) {throw new Error('workspace_invalid')}
  const directory = ownedAnalysisWorkspace(root, scope, id, revision)

  if (target.workspaceId) {ownedAnalysisAttempt(root, scope, id, revision, target.workspaceId)}

  const item: AnalysisChatLink = { sessionId: target.sessionId, connectionId: target.connectionId,
    profile: target.profile, submittedAt: new Date().toISOString(),
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(target.turn ? { turn: { id: target.turn.id, runtimeSessionId: target.turn.runtimeSessionId } } : {}) }

  commitChatReceipt(directory, scope, id, revision, item)

  return item
}

function commitChatReceipt(directory: string, scope: string, id: string, revision: string, item: AnalysisChatLink): void {
  const temp = path.join(directory, `.chat-${crypto.randomUUID()}.tmp`)

  try {
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, scope, sourceId: id, revision, item }), { flag: 'wx', mode: 0o600 })
    fs.renameSync(temp, path.join(directory, 'apex-chat.json'))
  } finally {fs.rmSync(temp, { force: true })}
}

export function updateAnalysisChatOutcome(root: string, scope: string, id: string, revision: string, expected: AnalysisChatLink, status: AnalysisTurnState): AnalysisChatLink {
  if (!validAnalysisChatTarget(expected) || !expected.turn || !validAnalysisTurnState(status)) {throw new Error('workspace_invalid')}
  const current = readAnalysisChatLink(root, scope, id, revision)

  if (!current || !sameAnalysisChatLink(current, expected)) {throw new Error('analysis_context_changed')}

  if (current.outcome && ['complete', 'error', 'interrupted'].includes(current.outcome.status)) {return current}
  const item = { ...current, outcome: { status, observedAt: new Date().toISOString() } }
  commitChatReceipt(ownedAnalysisWorkspace(root, scope, id, revision), scope, id, revision, item)

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
      !validAnalysisChatTarget(record.item) || typeof record.item.submittedAt !== 'string' || !Number.isFinite(Date.parse(record.item.submittedAt)) ||
      (record.item.outcome !== undefined && (!record.item.turn || !record.item.outcome || !validAnalysisTurnState(record.item.outcome.status) ||
        typeof record.item.outcome.observedAt !== 'string' || !Number.isFinite(Date.parse(record.item.outcome.observedAt))))) {
      throw new Error('workspace_invalid')
    }

    return { sessionId: record.item.sessionId, connectionId: record.item.connectionId,
      profile: record.item.profile, submittedAt: record.item.submittedAt,
      ...(record.item.workspaceId ? { workspaceId: record.item.workspaceId } : {}),
      ...(record.item.turn ? { turn: { id: record.item.turn.id, runtimeSessionId: record.item.turn.runtimeSessionId } } : {}),
      ...(record.item.outcome ? { outcome: { status: record.item.outcome.status, observedAt: record.item.outcome.observedAt } } : {}) }
  } catch {throw new Error('workspace_invalid')} finally {if (fd !== undefined) {fs.closeSync(fd)}}
}
