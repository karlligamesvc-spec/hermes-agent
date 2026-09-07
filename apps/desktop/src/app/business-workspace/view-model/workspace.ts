import type { ClientSessionState } from '@/app/types'
import { sessionMatchesStoredId } from '@/store/session'
import type { CronJob, SessionInfo, SessionMessage } from '@/types/hermes'

import { type ArtifactRecord, collectArtifactsForSession } from '../../artifacts/artifact-utils'
import { deriveProgress, primaryRun, type TaskProgress } from '../../tasks/task-model'

export type ConversationStatus = 'idle' | 'needs-input' | 'running'

export interface RecentConversation {
  id: string
  lastActive: number
  preview: string
  profile?: string
  status: ConversationStatus
  title: string
  toolCallCount: number
}

export interface WorkspaceTaskEvidence {
  jobId: string
  progress: null | TaskProgress
  readState: 'ready' | 'unavailable'
  run: null | SessionInfo
}

export interface WorkspaceEvidence {
  artifacts: ArtifactRecord[]
  failedArtifactSessions: number
  failedTasks: number
  tasks: Record<string, WorkspaceTaskEvidence>
}

export interface WorkspaceEvidenceReaders {
  getCronJobRuns: (jobId: string) => Promise<SessionInfo[]>
  getSessionMessages: (id: string, profile?: string | null) => Promise<{ messages: SessionMessage[] }>
}

function statusForSession(session: SessionInfo, states: Record<string, ClientSessionState>): ConversationStatus {
  const matching = Object.values(states).filter(
    state => state.storedSessionId && sessionMatchesStoredId(session, state.storedSessionId)
  )

  if (matching.some(state => state.needsInput)) {
    return 'needs-input'
  }

  return matching.some(state => state.busy) ? 'running' : 'idle'
}

/** Real recent conversations only: no project grouping or synthetic rows. */
export function recentConversations(
  sessions: readonly SessionInfo[],
  states: Record<string, ClientSessionState>,
  limit = 6
): RecentConversation[] {
  return [...sessions]
    .filter(session => session.message_count > 0 && session.source !== 'cron')
    .sort((left, right) => right.last_active - left.last_active)
    .slice(0, limit)
    .map(session => ({
      id: session.id,
      lastActive: session.last_active,
      preview: session.preview?.trim() || '',
      profile: session.profile,
      status: statusForSession(session, states),
      title: session.title?.trim() || session.preview?.trim() || '',
      toolCallCount: session.tool_call_count
    }))
}

function cronTime(value?: null | string): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)

  return Number.isNaN(parsed) ? 0 : parsed
}

/** Deterministic recency from real scheduler timestamps, never array order. */
export function recentWorkspaceTasks(jobs: readonly CronJob[], limit = 4): CronJob[] {
  return [...jobs]
    .sort((left, right) => {
      const byRun = cronTime(right.last_run_at) - cronTime(left.last_run_at)

      if (byRun !== 0) {
        return byRun
      }

      const byNext = cronTime(right.next_run_at) - cronTime(left.next_run_at)

      return byNext !== 0 ? byNext : left.id.localeCompare(right.id)
    })
    .slice(0, limit)
}

/** Read task and artifact evidence through the same exits as their canonical pages. */
export async function loadWorkspaceEvidence(
  sessions: readonly SessionInfo[],
  jobs: readonly CronJob[],
  readers: WorkspaceEvidenceReaders
): Promise<WorkspaceEvidence> {
  const transcriptCache = new Map<string, Promise<{ messages: SessionMessage[] }>>()

  const readTranscript = (session: SessionInfo) => {
    const key = `${session.profile || 'default'}:${session.id}`
    const cached = transcriptCache.get(key)

    if (cached) {
      return cached
    }

    const request = readers.getSessionMessages(session.id, session.profile)
    transcriptCache.set(key, request)

    return request
  }

  const taskResults = await Promise.all(
    jobs.map(async job => {
      try {
        const runs = await readers.getCronJobRuns(job.id)
        const run = primaryRun(runs)
        const progress = run ? deriveProgress((await readTranscript(run)).messages) : null

        return { jobId: job.id, progress, readState: 'ready', run } satisfies WorkspaceTaskEvidence
      } catch {
        return {
          jobId: job.id,
          progress: null,
          readState: 'unavailable',
          run: null
        } satisfies WorkspaceTaskEvidence
      }
    })
  )

  const artifactSessions = [...sessions]
    .filter(session => session.message_count > 0)
    .sort((left, right) => right.last_active - left.last_active)
    .slice(0, 30)

  const artifactResults = await Promise.allSettled(
    artifactSessions.map(async session => collectArtifactsForSession(session, (await readTranscript(session)).messages))
  )

  const tasks: Record<string, WorkspaceTaskEvidence> = {}
  taskResults.forEach(result => {
    tasks[result.jobId] = result
  })

  const artifacts = artifactResults
    .flatMap(result => (result.status === 'fulfilled' ? result.value : []))
    .sort((left, right) => right.timestamp - left.timestamp)

  return {
    artifacts,
    failedArtifactSessions: artifactResults.filter(result => result.status === 'rejected').length,
    failedTasks: taskResults.filter(result => result.readState === 'unavailable').length,
    tasks
  }
}
