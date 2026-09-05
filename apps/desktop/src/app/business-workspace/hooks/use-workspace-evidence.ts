import { useEffect, useMemo, useState } from 'react'

import { getCronJobRuns, getSessionMessages, listAllProfileSessions } from '@/hermes'
import type { CronJob, SessionInfo } from '@/types/hermes'

import { loadWorkspaceEvidence, type WorkspaceEvidence } from '../view-model/workspace'

export interface WorkspaceEvidenceState {
  evidence: null | WorkspaceEvidence
  evidenceUnavailable: boolean
}

/** Shared read model for the Start and Projects surfaces. */
export function useWorkspaceEvidence(
  sessions: readonly SessionInfo[],
  tasks: readonly CronJob[]
): WorkspaceEvidenceState {
  const [evidence, setEvidence] = useState<null | WorkspaceEvidence>(null)
  const [evidenceUnavailable, setEvidenceUnavailable] = useState(false)

  const requestKey = useMemo(
    () =>
      `${sessions.map(session => `${session.id}:${session.last_active}`).join('|')}::${tasks
        .map(task => `${task.id}:${task.state || ''}:${task.last_run_at || ''}`)
        .join('|')}`,
    [sessions, tasks]
  )

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const sourceSessions = (await listAllProfileSessions(30, 1)).sessions

        const result = await loadWorkspaceEvidence(sourceSessions, tasks, {
          getCronJobRuns,
          getSessionMessages
        })

        if (!cancelled) {
          setEvidence(result)
          setEvidenceUnavailable(false)
        }
      } catch {
        if (!cancelled) {
          setEvidenceUnavailable(true)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [requestKey, tasks])

  return { evidence, evidenceUnavailable }
}
