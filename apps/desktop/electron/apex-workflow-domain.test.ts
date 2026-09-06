import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  cancelWorkflowDomainRun,
  getWorkflowDomainAccess,
  getWorkflowDomainCatalog,
  getWorkflowDomainProject,
  getWorkflowDomainRun,
  listWorkflowDomainProjects,
  listWorkflowDomainWorkflows,
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
      id: 'market-research',
      name: 'Market research',
      slug: 'market-research',
      version: 3
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

        return {
          item: {
            id: 'run-1',
            payload: { apiKey: 'start-response-secret' },
            status: 'queued',
            userId: 'tenant-user'
          }
        }
      }
    }
  })

  assert.deepEqual(run, { id: 'run-1' })
  assert.equal(calls.length, 3)
  assert.equal(calls[0]?.url, 'https://api.apex-nodes.com/api/v1/workflow-domain/projects')
  assert.deepEqual(calls[0]?.body, {
    name: 'Analyze the pet market',
    objective: 'Analyze the pet market',
    projectConfig: { createdFrom: 'desktop_start' }
  })
  assert.equal(calls[1]?.url, 'https://api.apex-nodes.com/api/v1/workflow-domain/projects/project-1/workflows')
  assert.deepEqual(calls[1]?.body, {
    name: 'Market research',
    slug: 'market-research',
    description: 'Evidence-backed market research',
    definition: {
      entrypoint: 'hermes',
      objective: 'Analyze the pet market',
      template: { id: 'market-research', version: 3 }
    },
    inputSchema: {
      type: 'object',
      required: ['objective'],
      properties: { objective: { type: 'string' } }
    },
    outputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' }, evidence: { type: 'array' } }
    }
  })
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
      starter: { description: 'Description', id: 'workflow', name: 'Workflow', slug: 'workflow', version: 1 },
      uuid: () => 'uuid',
      transport: {
        getJson: async () => ({}),
        postJson: async () => ({ item: { id: '' } })
      }
    }),
    /project id/
  )
})

test('keeps Project, Workflow, and catalog reads on bounded authenticated exits', async () => {
  const gets: string[] = []

  const transport = {
    getJson: async (url: string) => {
      gets.push(url)

      return url.endsWith('/projects/project%2F1') ? { item: { id: 'project/1' } } : { items: [] }
    }
  }

  await listWorkflowDomainProjects(
    'https://api.apex-nodes.com',
    { cursor: 'opaque cursor', limit: 20, status: 'active' },
    transport
  )
  await listWorkflowDomainWorkflows(
    'https://api.apex-nodes.com',
    { cursor: 'workflow cursor', limit: 50, projectId: 'project/1', status: 'paused' },
    transport
  )
  await getWorkflowDomainCatalog('https://api.apex-nodes.com', transport)
  await getWorkflowDomainProject('https://api.apex-nodes.com', 'project/1', transport)

  assert.equal(
    gets[0],
    'https://api.apex-nodes.com/api/v1/workflow-domain/projects?cursor=opaque+cursor&limit=20&status=active'
  )
  assert.equal(
    gets[1],
    'https://api.apex-nodes.com/api/v1/workflow-domain/workflows?cursor=workflow+cursor&limit=50&projectId=project%2F1&status=paused'
  )
  assert.equal(gets[2], 'https://api.apex-nodes.com/api/v1/workflow-domain/catalog')
  assert.equal(gets[3], 'https://api.apex-nodes.com/api/v1/workflow-domain/projects/project%2F1')
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

test('projects Run detail into a sequence-stable renderer model without raw or tenant-sensitive fields', async () => {
  const projected = await getWorkflowDomainRun('https://api.apex-nodes.com', 'run/1', {
    getJson: async () => ({
      deliverables: [
        {
          createdAt: '2026-09-06T10:02:00Z',
          evidenceManifest: [{ sourceUrl: 'https://private.example/evidence', token: 'evidence-secret' }],
          id: 'deliverable-1',
          kind: 'report',
          payload: { config: { apiKey: 'payload-secret' }, schema: 'private-schema' },
          reviews: [
            {
              createdAt: '2026-09-06T10:03:00Z',
              deliverableId: 'deliverable-1',
              id: 'review-2',
              notes: 'private-review-note',
              roundNumber: 2,
              status: 'approved',
              userId: 'tenant-user'
            },
            {
              createdAt: '2026-09-06T10:02:30Z',
              id: 'review-1',
              roundNumber: 1,
              status: 'changes_requested'
            }
          ],
          status: 'ready',
          storageKind: 'url',
          storageRef: 'https://files.example/report.pdf',
          title: 'Market report',
          updatedAt: '2026-09-06T10:03:00Z',
          userId: 'tenant-user'
        }
      ],
      events: [
        {
          eventKey: 'private-key',
          eventType: 'tool.result',
          happenedAt: '2026-09-06T10:01:00Z',
          id: 'event-2',
          payload: { result: 'raw-result-secret', token: 'event-secret' },
          sequence: 2,
          userId: 'tenant-user'
        },
        {
          eventType: 'run.running',
          happenedAt: '2026-09-06T10:00:00Z',
          id: 'event-1',
          payload: {},
          sequence: 1
        }
      ],
      steps: [{ progress: 88, title: 'Fabricated stage from unsupported response data' }],
      run: {
        attempt: 1,
        completedAt: null,
        createdAt: '2026-09-06T09:59:00Z',
        errorMessage: 'private stack',
        executorType: 'hermes',
        id: 'run-1',
        maxAttempts: 2,
        startedAt: '2026-09-06T10:00:00Z',
        status: 'waiting_review',
        triggerRef: 'Review market evidence',
        updatedAt: '2026-09-06T10:03:00Z',
        userId: 'tenant-user'
      }
    })
  })

  assert.deepEqual(
    (projected.events as Array<{ sequence: number }>).map(event => event.sequence),
    [1, 2]
  )
  assert.equal((projected.deliverables as Array<Record<string, unknown>>)[0]?.evidenceCount, 1)
  assert.equal(
    (projected.deliverables as Array<Record<string, unknown>>)[0]?.openReference,
    'https://files.example/report.pdf'
  )
  assert.deepEqual(
    ((projected.deliverables as Array<Record<string, unknown>>)[0]?.reviews as Array<{ roundNumber: number }>).map(
      review => review.roundNumber
    ),
    [1, 2]
  )
  assert.equal('steps' in projected, false)

  const rendererJson = JSON.stringify(projected)

  for (const forbidden of [
    'tenant-user',
    'payload-secret',
    'private-schema',
    'private-key',
    'raw-result-secret',
    'event-secret',
    'evidence-secret',
    'private-review-note',
    'private stack',
    'Fabricated stage from unsupported response data'
  ]) {
    assert.equal(rendererJson.includes(forbidden), false)
  }
})

test('rejects any non-Hermes executor at the Run projection boundary', async () => {
  await assert.rejects(
    getWorkflowDomainRun('https://api.apex-nodes.com', 'run-1', {
      getJson: async () => ({
        deliverables: [],
        events: [],
        run: {
          attempt: 1,
          completedAt: null,
          createdAt: '2026-09-06T09:59:00Z',
          executorType: 'deepseek-harness',
          id: 'run-1',
          maxAttempts: 1,
          startedAt: null,
          status: 'queued',
          triggerRef: null,
          updatedAt: '2026-09-06T09:59:00Z'
        }
      })
    }),
    /Unsupported workflow domain executor/
  )
})
