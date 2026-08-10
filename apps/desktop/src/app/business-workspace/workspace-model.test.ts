import { describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import type { CronJob, SessionInfo, SessionMessage } from '@/types/hermes'

import { loadWorkspaceEvidence, recentConversations, recentWorkspaceTasks } from './workspace-model'

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    ended_at: null,
    id: 'session-1',
    input_tokens: 0,
    is_active: false,
    last_active: 10,
    message_count: 2,
    model: null,
    output_tokens: 0,
    preview: 'Research the market',
    source: 'desktop',
    started_at: 1,
    title: 'Market research',
    tool_call_count: 3,
    ...overrides
  }
}

describe('hc-697 real workspace mapping', () => {
  it('projects only real non-cron conversations and resolves live state through lineage identity', () => {
    const sessions = [
      session({ id: 'tip-1', _lineage_root_id: 'root-1' }),
      session({ id: 'cron-1', source: 'cron', last_active: 20 }),
      session({ id: 'empty', message_count: 0, last_active: 30 })
    ]

    const states = {
      runtime: { storedSessionId: 'root-1', busy: true, needsInput: true } as ClientSessionState
    }

    expect(recentConversations(sessions, states)).toEqual([
      expect.objectContaining({ id: 'tip-1', status: 'needs-input', title: 'Market research', toolCallCount: 3 })
    ])
  })

  it('aggregates every matching lineage state with needs-input over busy over idle', () => {
    const row = session({ id: 'tip-1', _lineage_root_id: 'root-1' })

    const states = {
      first: { storedSessionId: 'tip-1', busy: false, needsInput: false } as ClientSessionState,
      second: { storedSessionId: 'root-1', busy: true, needsInput: false } as ClientSessionState,
      third: { storedSessionId: 'tip-1', busy: false, needsInput: true } as ClientSessionState
    }

    expect(recentConversations([row], states)[0]?.status).toBe('needs-input')
    const { third: _needsInput, ...withoutNeedsInput } = states
    expect(recentConversations([row], withoutNeedsInput)[0]?.status).toBe('running')
  })

  it('sorts recent tasks from scheduler timestamps with a stable fallback', () => {
    const jobs = [
      { enabled: true, id: 'z-old', last_run_at: '2026-08-01T00:00:00Z' },
      { enabled: true, id: 'a-scheduled', next_run_at: '2026-08-12T00:00:00Z' },
      { enabled: true, id: 'm-new', last_run_at: '2026-08-10T00:00:00Z' }
    ] as CronJob[]

    expect(recentWorkspaceTasks(jobs).map(job => job.id)).toEqual(['m-new', 'z-old', 'a-scheduled'])
  })

  it('derives task progress and artifacts from the real run/session transcripts', async () => {
    const job = { enabled: true, id: 'job-1', schedule: { kind: 'once' } } as CronJob
    const run = session({ id: 'run-1', source: 'cron' })

    const taskMessages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'todo-1',
            name: 'todo',
            args: { todos: [{ id: 'one', content: 'Collect evidence', status: 'in_progress' }] }
          }
        ]
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'todo-1', tool_name: 'todo' }
    ] as SessionMessage[]

    const artifactMessages = [
      { role: 'assistant', content: 'Delivered: [report](/tmp/report.pdf)', timestamp: 100 }
    ] as SessionMessage[]

    const getSessionMessages = vi.fn(async (id: string) => ({
      messages: id === 'run-1' ? taskMessages : artifactMessages
    }))

    const result = await loadWorkspaceEvidence([session()], [job], {
      getCronJobRuns: vi.fn(async () => [run]),
      getSessionMessages
    })

    expect(result.tasks['job-1']).toMatchObject({
      run: { id: 'run-1' },
      readState: 'ready',
      progress: { currentStep: 'Collect evidence', totalSteps: 1 }
    })
    expect(result.artifacts).toEqual([expect.objectContaining({ value: '/tmp/report.pdf', sessionId: 'session-1' })])
  })

  it('keeps partial real data and reports unreadable exits instead of fabricating replacements', async () => {
    const result = await loadWorkspaceEvidence([session()], [{ enabled: true, id: 'job-1' } as CronJob], {
      getCronJobRuns: vi.fn(async () => {
        throw new Error('older backend')
      }),
      getSessionMessages: vi.fn(async () => {
        throw new Error('locked profile')
      })
    })

    expect(result.tasks['job-1']).toMatchObject({ progress: null, readState: 'unavailable', run: null })
    expect(result.artifacts).toEqual([])
    expect(result.failedTasks).toBe(1)
    expect(result.failedArtifactSessions).toBe(1)
  })

  it('includes cron-session deliverables and deduplicates a run transcript shared with task progress', async () => {
    const run = session({ id: 'run-1', source: 'cron' })

    const getSessionMessages = vi.fn(async () => ({
      messages: [{ role: 'assistant', content: 'Saved /tmp/task-report.pdf', timestamp: 100 }] as SessionMessage[]
    }))

    const result = await loadWorkspaceEvidence([run], [{ enabled: true, id: 'job-1' } as CronJob], {
      getCronJobRuns: vi.fn(async () => [run]),
      getSessionMessages
    })

    expect(result.artifacts).toEqual([expect.objectContaining({ sessionId: 'run-1', value: '/tmp/task-report.pdf' })])
    expect(getSessionMessages).toHaveBeenCalledTimes(1)
  })

  it.each(['run-list', 'run-transcript'] as const)(
    'keeps the failing job id and marks %s reads unavailable',
    async failure => {
      const run = session({ id: 'run-1', source: 'cron' })

      const result = await loadWorkspaceEvidence([], [{ enabled: true, id: 'job-1' } as CronJob], {
        getCronJobRuns: vi.fn(async () => {
          if (failure === 'run-list') {
            throw new Error('run list unavailable')
          }

          return [run]
        }),
        getSessionMessages: vi.fn(async () => {
          throw new Error('transcript unavailable')
        })
      })

      expect(result.tasks['job-1']).toEqual({
        jobId: 'job-1',
        progress: null,
        readState: 'unavailable',
        run: null
      })
      expect(result.failedTasks).toBe(1)
    }
  )
})
