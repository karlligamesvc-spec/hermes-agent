import { useEffect, useMemo, useState } from 'react'

import { getCronJobRuns, getSessionMessages, listAllProfileSessions } from '@/hermes'
import type { CronJob, SessionInfo } from '@/types/hermes'

import { loadWorkspaceEvidence, type WorkspaceEvidence } from './workspace-model'

export interface WorkspaceEvidenceState {
  evidence: null | WorkspaceEvidence
  evidenceUnavailable: boolean
}

/**
 * Shared read model for the Start and Projects surfaces.
 *
 * Both pages consume the same bounded session/task exits, so a route change
 * cannot silently change what counts as progress or a deliverable. A failed
 * refresh preserves the last successful snapshot and marks it degraded.
 */
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
        // Same bounded all-profile source window as the canonical Artifacts
        // page. Cron run sessions remain included so task deliverables count.
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
