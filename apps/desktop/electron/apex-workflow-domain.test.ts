import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  cancelWorkflowDomainRun,
  getWorkflowDomainAccess,
  reviewWorkflowDomainDeliverable,
  startWorkflowDomainGoal,
  workflowDomainUrl,
  workflowProjectName
} from './apex-workflow-domain'

test('builds workflow-domain URLs under the canonical API v1 prefix', () => {
  assert.equal(
    workflowDomainUrl('https://api.apex-nodes.com/', '/runs/run-1'),
    'https://api.apex-nodes.com/api/v1/workflow-domain/runs/run-1'
  )
  assert.throws(() => workflowDomainUrl('file:///tmp/apex', 'access'), /Unsupported/)
})

test('derives a bounded project name from the real objective', () => {
  assert.equal(workflowProjectName('First line\nSecond line'), 'First line')
  assert.equal(workflowProjectName('x'.repeat(60)), `${'x'.repeat(47)}…`)
})

test('starts one canonical Project to Workflow to Hermes Run chain', async () => {
  const calls: Array<{ body?: Record<string, unknown>; method: string; url: string }> = []

  const run = await startWorkflowDomainGoal({
    apiBase: 'https://api.apex-nodes.com',
    objective: 'Analyze the pet market',
    starter: {
      description: 'Evidence-backed market research',
      name: 'Market research',
      slug: 'market-research'
    },
    uuid: () => '00000000-0000-4000-8000-000000000795',
    transport: {
      getJson: async url => {
        calls.push({ method: 'GET', url })

        return {}
      },
      postJson: async (url, body) => {
        calls.push({ body, method: 'POST', url })

        if (url.endsWith('/projects')) {
          return { item: { id: 'project-1' } }
        }

        if (url.endsWith('/workflows')) {
          return { item: { id: 'workflow-1' } }
        }

        return { item: { id: 'run-1', status: 'queued' } }
      }
    }
  })

  assert.deepEqual(run, { id: 'run-1', status: 'queued' })
  assert.equal(calls.length, 3)
  assert.equal(calls[0]?.url, 'https://api.apex-nodes.com/api/v1/workflow-domain/projects')
  assert.deepEqual(calls[0]?.body, {
    name: 'Analyze the pet market',
    objective: 'Analyze the pet market',
    projectConfig: { createdFrom: 'desktop_start' }
  })
  assert.equal(calls[1]?.url, 'https://api.apex-nodes.com/api/v1/workflow-domain/projects/project-1/workflows')
  assert.deepEqual(calls[2]?.body, {
    workflowId: 'workflow-1',
    idempotencyKey: 'desktop:00000000-0000-4000-8000-000000000795',
    triggerRef: 'Analyze the pet market',
    executorType: 'hermes',
    maxAttempts: 2
  })
})

test('rejects malformed server identifiers before they can retarget a later request', async () => {
  await assert.rejects(
    startWorkflowDomainGoal({
      apiBase: 'https://api.apex-nodes.com',
      objective: 'Goal',
      starter: { description: 'Description', name: 'Workflow', slug: 'workflow' },
      uuid: () => 'uuid',
      transport: {
        getJson: async () => ({}),
        postJson: async () => ({ item: { id: '' } })
      }
    }),
    /project id/
  )
})

test('keeps access, cancel, and review on their exact typed exits', async () => {
  const gets: string[] = []
  const posts: Array<{ body: Record<string, unknown>; url: string }> = []

  const transport = {
    getJson: async (url: string) => {
      gets.push(url)

      return { enabled: true }
    },
    postJson: async (url: string, body: Record<string, unknown>) => {
      posts.push({ body, url })

      return { item: { id: 'saved' } }
    }
  }

  assert.deepEqual(await getWorkflowDomainAccess('https://api.apex-nodes.com', transport), { enabled: true })
  assert.deepEqual(await cancelWorkflowDomainRun('https://api.apex-nodes.com', 'run/1', transport), { id: 'saved' })
  assert.deepEqual(
    await reviewWorkflowDomainDeliverable(
      'https://api.apex-nodes.com',
      'deliverable/1',
      'changes_requested',
      transport
    ),
    { id: 'saved' }
  )

  assert.equal(gets[0], 'https://api.apex-nodes.com/api/v1/workflow-domain/access')
  assert.equal(posts[0]?.url.endsWith('/runs/run%2F1/cancel'), true)
  assert.deepEqual(posts[1]?.body, {
    status: 'changes_requested',
    metrics: {},
    notes: null,
    nextAction: null
  })
  await assert.rejects(
    reviewWorkflowDomainDeliverable('https://api.apex-nodes.com', 'deliverable/1', 'rejected' as never, transport),
    /review status/
  )
  assert.equal(posts.length, 2)
})
