import assert from 'node:assert/strict'

import { test } from 'vitest'

type JsonObject = Record<string, unknown>

import {
  cancelWorkflowDomainRun,
  createWorkflowDomainProject,
  getWorkflowDomainAccess,
  getWorkflowDomainCatalog,
  getWorkflowDomainDeliverable,
  getWorkflowDomainProject,
  getWorkflowDomainRun,
  getWorkflowDomainUserFileDownload,
  listWorkflowDomainActivity,
  listWorkflowDomainDeliverables,
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

test('creates an honest empty Project with its optional local folder', async () => {
  const calls: Array<{ body: Record<string, unknown>; url: string }> = []

  const item = await createWorkflowDomainProject({
    apiBase: 'https://api.apex-nodes.com',
    localPath: '/Users/karl/Projects/pet-market',
    name: 'Pet market',
    objective: 'Analyze the market',
    transport: {
      postJson: async (url, body) => {
        calls.push({ body, url })

        return { item: { id: 'project-1', name: 'Pet market' } }
      }
    }
  })

  assert.deepEqual(item, { id: 'project-1', name: 'Pet market' })
  assert.deepEqual(calls, [
    {
      body: {
        name: 'Pet market',
        objective: 'Analyze the market',
        projectConfig: { createdFrom: 'desktop_projects', localPath: '/Users/karl/Projects/pet-market' }
      },
      url: 'https://api.apex-nodes.com/api/v1/workflow-domain/projects'
    }
  ])
})

test('adds a Workflow and Run to an existing Project without creating a duplicate Project', async () => {
  const calls: Array<{ body?: Record<string, unknown>; method: string; url: string }> = []

  const run = await startWorkflowDomainGoal({
    apiBase: 'https://api.apex-nodes.com',
    objective: 'Continue the existing goal',
    projectId: 'project-existing',
    starter: {
      description: 'Evidence-backed market research',
      id: 'market-research',
      name: 'Market research',
      slug: 'market-research',
      version: 3
    },
    transport: {
      getJson: async url => {
        calls.push({ method: 'GET', url })

        return {}
      },
      postJson: async (url, body) => {
        calls.push({ body, method: 'POST', url })

        return url.endsWith('/workflows') ? { item: { id: 'workflow-1' } } : { item: { id: 'run-1', status: 'queued' } }
      }
    },
    uuid: () => '00000000-0000-4000-8000-000000000828'
  })

  assert.deepEqual(run, { id: 'run-1' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.url, 'https://api.apex-nodes.com/api/v1/workflow-domain/projects/project-existing/workflows')
  assert.equal(calls[1]?.url, 'https://api.apex-nodes.com/api/v1/workflow-domain/runs')
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
      '  Cite the primary source.  ',
      transport
    ),
    { id: 'saved' }
  )

  assert.equal(gets[0], 'https://api.apex-nodes.com/api/v1/workflow-domain/access')
  assert.equal(posts[0]?.url.endsWith('/runs/run%2F1/cancel'), true)
  assert.deepEqual(posts[1]?.body, {
    status: 'changes_requested',
    metrics: {},
    notes: 'Cite the primary source.',
    nextAction: null
  })
  await assert.rejects(
    reviewWorkflowDomainDeliverable(
      'https://api.apex-nodes.com',
      'deliverable/1',
      'rejected' as never,
      undefined,
      transport
    ),
    /review status/
  )
  await assert.rejects(
    reviewWorkflowDomainDeliverable(
      'https://api.apex-nodes.com',
      'deliverable/1',
      'changes_requested',
      '   ',
      transport
    ),
    /review notes/
  )
  await assert.rejects(
    reviewWorkflowDomainDeliverable(
      'https://api.apex-nodes.com',
      'deliverable/1',
      'approved',
      { note: 'not a string' } as never,
      transport
    ),
    /review notes/
  )
  assert.equal(posts.length, 2)
})

test('projects Run detail into a sequence-stable renderer model without raw or tenant-sensitive fields', async () => {
  const projected = await getWorkflowDomainRun('https://api.apex-nodes.com', 'run/1', {
    getJson: async () => ({
      deliverables: [
        {
          createdAt: '2026-09-06T10:02:00Z',
          evidence: [
            {
              quote: 'Public quote',
              token: 'evidence-secret',
              url: 'https://public.example/evidence'
            }
          ],
          executorType: 'hermes',
          executorVersion: '2026.9.1',
          id: 'deliverable-1',
          kind: 'report',
          payload: {
            config: { apiKey: 'payload-secret' },
            highlights: ['Finding one'],
            schema: 'private-schema',
            summary: 'Public summary'
          },
          projectId: 'project-1',
          reviews: [
            {
              createdAt: '2026-09-06T10:02:15Z',
              id: 'review-pending',
              metrics: {},
              nextAction: null,
              reviewerType: 'human',
              roundNumber: 3,
              status: 'pending'
            },
            {
              createdAt: '2026-09-06T10:03:00Z',
              deliverableId: 'deliverable-1',
              id: 'review-2',
              metrics: {},
              notes: 'private-review-note',
              nextAction: null,
              reviewerType: 'human',
              roundNumber: 2,
              status: 'approved',
              userId: 'tenant-user'
            },
            {
              createdAt: '2026-09-06T10:02:30Z',
              id: 'review-1',
              metrics: {},
              nextAction: null,
              reviewerType: 'human',
              roundNumber: 1,
              status: 'changes_requested'
            }
          ],
          runId: 'run-1',
          schemaVersion: 1,
          sourceCapturedAt: '2026-09-06T10:01:30Z',
          status: 'ready',
          storageTarget: { id: '00000000-0000-4000-8000-000000000831', kind: 'user_file' },
          title: 'Market report',
          updatedAt: '2026-09-06T10:03:00Z',
          userId: 'tenant-user',
          verifierResult: { passed: true, secret: 'verifier-secret' }
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
  assert.equal((projected.deliverables as Array<Record<string, unknown>>)[0]?.openReference, null)
  assert.deepEqual(
    ((projected.deliverables as Array<Record<string, unknown>>)[0]?.reviews as Array<{ roundNumber: number }>).map(
      review => review.roundNumber
    ),
    [1, 2, 3]
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
    'verifier-secret',
    'private stack',
    'Fabricated stage from unsupported response data'
  ]) {
    assert.equal(rendererJson.includes(forbidden), false)
  }

  await assert.rejects(
    listWorkflowDomainActivity(
      'https://api.apex-nodes.com',
      { kinds: 'review' },
      {
        getJson: async () => ({
          items: [
            {
              happenedAt: '2026-09-13T01:11:00Z',
              id: 'review:mismatched',
              kind: 'review',
              status: 'approved',
              summary: null,
              target: { id: 'run-831', kind: 'run' },
              title: 'Mismatched review'
            }
          ]
        })
      }
    ),
    /Mismatched workflow domain activity target/
  )
})

test('projects Deliverable list/detail and Activity onto typed renderer-safe models', async () => {
  const deliverable = {
    createdAt: '2026-09-13T01:00:00Z',
    evidence: [
      {
        quote: 'Verified quote',
        secretHeader: 'evidence-secret',
        title: 'Primary source',
        url: 'https://example.com/source',
        verified: true
      },
      { title: 'Unsafe URL is omitted', url: 'javascript:alert(1)' },
      { title: 'Credential-like query is omitted', url: 'https://example.com/source?token=secret' },
      { title: 'Private host is omitted', url: 'https://localhost/source' }
    ],
    executorType: 'hermes',
    executorVersion: '2026.9.1',
    id: 'deliverable/831',
    kind: 'report',
    payload: {
      config: { apiKey: 'payload-secret' },
      highlights: ['First finding', '', { secret: true }],
      summary: 'Market summary'
    },
    projectId: 'project-831',
    reviews: [
      {
        createdAt: '2026-09-13T01:10:00Z',
        id: 'review-831',
        metrics: { issueCount: 1, secretScore: 99 },
        nextAction: { internalToken: 'next-secret', label: 'Revise', targetId: 'deliverable/831', type: 'edit' },
        notes: 'Cite the source.',
        reviewerType: 'human',
        roundNumber: 1,
        status: 'changes_requested',
        userId: 'tenant-user'
      }
    ],
    runId: 'run-831',
    schemaVersion: 1,
    sourceCapturedAt: '2026-09-13T00:59:00Z',
    status: 'ready',
    storageTarget: {
      id: '00000000-0000-4000-8000-000000000831',
      kind: 'user_file',
      signedUrl: 'https://private.example/signed?token=file-secret'
    },
    title: 'Market report',
    updatedAt: '2026-09-13T01:10:00Z',
    userId: 'tenant-user',
    verifierResult: { evidenceCount: 2, passed: false, reason: 'Needs citation', secret: 'verifier-secret' }
  }

  const getJson = async (url: string) => {
    if (url.includes('/activity')) {
      return {
        items: [
          {
            happenedAt: '2026-09-13T01:11:00Z',
            id: 'review:review-831',
            kind: 'review',
            payload: { token: 'activity-secret' },
            status: 'changes_requested',
            summary: 'Changes requested',
            target: { id: 'deliverable/831', kind: 'deliverable', secret: 'target-secret' },
            title: 'Review saved',
            userId: 'tenant-user'
          }
        ],
        nextCursor: 'activity cursor'
      }
    }

    if (url.endsWith('/deliverables/deliverable%2F831')) {
      return {
        item: deliverable,
        project: {
          createdAt: '2026-09-13T00:00:00Z',
          id: 'project-831',
          name: 'Market project',
          objective: 'Research the market',
          projectConfig: { apiKey: 'project-secret' },
          status: 'active',
          updatedAt: '2026-09-13T01:10:00Z'
        },
        run: {
          completedAt: null,
          createdAt: '2026-09-13T00:30:00Z',
          executorType: 'hermes',
          id: 'run-831',
          rawPayload: { token: 'run-secret' },
          startedAt: '2026-09-13T00:31:00Z',
          status: 'waiting_review',
          updatedAt: '2026-09-13T01:10:00Z'
        },
        workflow: {
          createdAt: '2026-09-13T00:15:00Z',
          definition: { token: 'workflow-secret' },
          description: 'Research workflow',
          id: 'workflow-831',
          name: 'Market research',
          projectId: 'project-831',
          slug: 'market-research',
          status: 'active',
          updatedAt: '2026-09-13T00:15:00Z',
          version: 1
        }
      }
    }

    return { items: [deliverable], nextCursor: 'deliverable cursor' }
  }

  const list = await listWorkflowDomainDeliverables(
    'https://api.apex-nodes.com',
    { cursor: 'before 1', kind: 'report', limit: 20, projectId: 'project/831', status: 'ready' },
    { getJson }
  )

  const detail = await getWorkflowDomainDeliverable('https://api.apex-nodes.com', 'deliverable/831', { getJson })

  const activity = await listWorkflowDomainActivity(
    'https://api.apex-nodes.com',
    { cursor: 'before 2', kinds: 'review', limit: 30 },
    { getJson }
  )

  assert.equal((list.items as JsonObject[]).length, 1)
  assert.deepEqual((activity.items as JsonObject[])[0]?.target, { id: 'deliverable/831', kind: 'deliverable' })
  assert.equal(
    (detail.item as JsonObject).storageTarget &&
      'signedUrl' in ((detail.item as JsonObject).storageTarget as JsonObject),
    false
  )
  assert.equal(((list.items as JsonObject[])[0]?.evidence as JsonObject[])[1]?.url, undefined)
  assert.equal(((list.items as JsonObject[])[0]?.evidence as JsonObject[])[2]?.url, undefined)
  assert.equal(((list.items as JsonObject[])[0]?.evidence as JsonObject[])[3]?.url, undefined)

  const rendererJson = JSON.stringify({ activity, detail, list })

  for (const forbidden of [
    'tenant-user',
    'payload-secret',
    'evidence-secret',
    'next-secret',
    'file-secret',
    'verifier-secret',
    'activity-secret',
    'target-secret',
    'project-secret',
    'run-secret',
    'workflow-secret'
  ]) {
    assert.equal(rendererJson.includes(forbidden), false)
  }

  await assert.rejects(
    listWorkflowDomainDeliverables(
      'https://api.apex-nodes.com',
      {},
      {
        getJson: async () => ({ items: [{ ...deliverable, status: 'invented' }] })
      }
    ),
    /deliverable status/
  )
  await assert.rejects(
    listWorkflowDomainActivity(
      'https://api.apex-nodes.com',
      {},
      {
        getJson: async () => ({
          items: [
            {
              happenedAt: '2026-09-13T01:11:00Z',
              id: 'review:invalid-status',
              kind: 'review',
              status: 'invented',
              summary: null,
              target: { id: 'deliverable/831', kind: 'deliverable' },
              title: 'Invalid status'
            }
          ]
        })
      }
    ),
    /activity status/
  )
})

test('keeps authenticated user-file download URLs on a UUID-only, public-protocol exit', async () => {
  const gets: string[] = []

  const result = await getWorkflowDomainUserFileDownload(
    'https://api.apex-nodes.com',
    '00000000-0000-4000-8000-000000000831',
    {
      getJson: async url => {
        gets.push(url)

        return { download_url: 'https://files.example/report.pdf?signature=short-lived', filename: 'report.pdf' }
      }
    }
  )

  assert.deepEqual(result, {
    filename: 'report.pdf',
    url: 'https://files.example/report.pdf?signature=short-lived'
  })
  assert.equal(gets[0], 'https://api.apex-nodes.com/api/v1/account/files/00000000-0000-4000-8000-000000000831/download')
  await assert.rejects(
    getWorkflowDomainUserFileDownload('https://api.apex-nodes.com', '../secret', {
      getJson: async () => ({ download_url: 'https://files.example/file' })
    }),
    /user file id/
  )
  await assert.rejects(
    getWorkflowDomainUserFileDownload('https://api.apex-nodes.com', '00000000-0000-4000-8000-000000000831', {
      getJson: async () => ({ download_url: 'file:///tmp/secret' })
    }),
    /download URL/
  )
  await assert.rejects(
    getWorkflowDomainUserFileDownload('file:///tmp/apex', '00000000-0000-4000-8000-000000000831', {
      getJson: async () => ({ download_url: 'https://files.example/file' })
    }),
    /Unsupported ApexNodes URL protocol/
  )
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
