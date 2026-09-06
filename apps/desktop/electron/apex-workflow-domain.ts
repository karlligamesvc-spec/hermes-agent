const WORKFLOW_DOMAIN_PATH = '/api/v1/workflow-domain'

type JsonObject = Record<string, unknown>

export interface WorkflowDomainTransport {
  getJson: (url: string) => Promise<unknown>
  postJson: (url: string, body: JsonObject) => Promise<unknown>
}

export interface WorkflowDomainStarter {
  description: string
  id: string
  name: string
  slug: string
  version: number
}

export interface StartWorkflowDomainGoalOptions {
  apiBase: string
  objective: string
  starter: WorkflowDomainStarter
  transport: WorkflowDomainTransport
  uuid: () => string
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim()
}

function requireText(value: unknown, field: string, maxLength: number): string {
  const normalized = trimmed(value)

  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid workflow domain ${field}`)
  }

  return normalized
}

function requireObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid workflow domain ${field} response`)
  }

  return value as JsonObject
}

function responseItem(value: unknown, field: string): JsonObject {
  return requireObject(requireObject(value, field).item, `${field}.item`)
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  const normalized = Number(value)

  if (!Number.isInteger(normalized) || normalized < minimum) {
    throw new Error(`Invalid workflow domain ${field} response`)
  }

  return normalized
}

function optionalText(value: unknown, maxLength: number): null | string {
  if (value === null || value === undefined) {
    return null
  }

  const normalized = trimmed(value)

  return normalized && normalized.length <= maxLength ? normalized : null
}

function deliverableOpenReference(value: JsonObject): null | string {
  const kind = trimmed(value.storageKind).toLowerCase()
  const reference = optionalText(value.storageRef, 240)

  if (!reference || kind !== 'url') {
    return null
  }

  try {
    const url = new URL(reference)

    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

/** The renderer receives a narrow Run read model rather than the server's raw
 * audit payload. Event payloads, deliverable payloads, evidence records,
 * ownership fields, schemas and verifier internals stay on the trusted side of
 * the preload boundary. */
export function projectWorkflowDomainRunOverview(value: unknown): JsonObject {
  const overview = requireObject(value, 'run overview')
  const run = requireObject(overview.run, 'run overview.run')
  const executorType = requireText(run.executorType, 'run executor type', 48).toLowerCase()

  if (executorType !== 'hermes') {
    throw new Error('Unsupported workflow domain executor')
  }

  if (!Array.isArray(overview.events) || !Array.isArray(overview.deliverables)) {
    throw new Error('Invalid workflow domain run overview response')
  }

  const events = overview.events
    .map(value => {
      const event = requireObject(value, 'run event')

      return {
        id: requireText(event.id, 'run event id', 160),
        sequence: requireInteger(event.sequence, 'run event sequence'),
        eventType: requireText(event.eventType, 'run event type', 120),
        happenedAt: requireText(event.happenedAt, 'run event time', 80)
      }
    })
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.happenedAt.localeCompare(right.happenedAt) ||
        left.id.localeCompare(right.id)
    )

  const deliverables = overview.deliverables.map(value => {
    const deliverable = requireObject(value, 'run deliverable')

    const reviews = Array.isArray(deliverable.reviews)
      ? deliverable.reviews
          .map(value => {
            const review = requireObject(value, 'deliverable review')
            const status = requireText(review.status, 'deliverable review status', 48)

            if (status !== 'approved' && status !== 'changes_requested' && status !== 'rejected') {
              throw new Error('Invalid workflow domain deliverable review status')
            }

            return {
              createdAt: optionalText(review.createdAt, 80),
              id: requireText(review.id, 'deliverable review id', 160),
              roundNumber: requireInteger(review.roundNumber, 'deliverable review round', 1),
              status
            }
          })
          .sort((left, right) => left.roundNumber - right.roundNumber || left.id.localeCompare(right.id))
      : []

    return {
      createdAt: requireText(deliverable.createdAt, 'deliverable creation time', 80),
      evidenceCount: Array.isArray(deliverable.evidenceManifest) ? deliverable.evidenceManifest.length : 0,
      id: requireText(deliverable.id, 'deliverable id', 160),
      kind: requireText(deliverable.kind, 'deliverable kind', 80),
      openReference: deliverableOpenReference(deliverable),
      reviews,
      status: requireText(deliverable.status, 'deliverable status', 48),
      title: requireText(deliverable.title, 'deliverable title', 240),
      updatedAt: requireText(deliverable.updatedAt, 'deliverable update time', 80)
    }
  })

  return {
    deliverables,
    events,
    run: {
      attempt: requireInteger(run.attempt, 'run attempt', 1),
      completedAt: optionalText(run.completedAt, 80),
      createdAt: requireText(run.createdAt, 'run creation time', 80),
      executorType,
      id: requireText(run.id, 'run id', 160),
      maxAttempts: requireInteger(run.maxAttempts, 'run maximum attempts', 1),
      startedAt: optionalText(run.startedAt, 80),
      status: requireText(run.status, 'run status', 48),
      triggerRef: optionalText(run.triggerRef, 4000),
      updatedAt: requireText(run.updatedAt, 'run update time', 80)
    }
  }
}

export function workflowDomainUrl(apiBase: string, path = ''): string {
  const normalizedBase = trimmed(apiBase).replace(/\/+$/, '')

  if (!normalizedBase) {
    throw new Error('Missing ApexNodes API base')
  }

  const suffix = path ? `/${String(path).replace(/^\/+/, '')}` : ''
  const url = new URL(`${normalizedBase}${WORKFLOW_DOMAIN_PATH}${suffix}`)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported ApexNodes URL protocol: ${url.protocol}`)
  }

  return url.toString()
}

export function workflowProjectName(objective: string): string {
  const normalized = requireText(objective, 'objective', 4000)
  const firstLine = normalized.split(/\r?\n/, 1)[0]?.trim() || normalized

  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine
}

export async function getWorkflowDomainAccess(
  apiBase: string,
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<{ enabled: true }> {
  const body = requireObject(await transport.getJson(workflowDomainUrl(apiBase, 'access')), 'access')

  if (body.enabled !== true) {
    throw new Error('Workflow domain access is not enabled')
  }

  return { enabled: true }
}

function workflowDomainListUrl(
  apiBase: string,
  path: string,
  query: Record<string, null | number | string | undefined>
) {
  const url = new URL(workflowDomainUrl(apiBase, path))

  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && String(value).trim()) {
      url.searchParams.set(key, String(value))
    }
  }

  return url.toString()
}

export async function listWorkflowDomainProjects(
  apiBase: string,
  options: { cursor?: string; limit?: number; status?: string },
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  return requireObject(
    await transport.getJson(
      workflowDomainListUrl(apiBase, 'projects', {
        cursor: options.cursor,
        limit: options.limit,
        status: options.status
      })
    ),
    'project list'
  )
}

export async function getWorkflowDomainProject(
  apiBase: string,
  projectId: string,
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  const normalizedProjectId = requireText(projectId, 'project id', 160)

  return responseItem(
    await transport.getJson(workflowDomainUrl(apiBase, `projects/${encodeURIComponent(normalizedProjectId)}`)),
    'project'
  )
}

export async function listWorkflowDomainWorkflows(
  apiBase: string,
  options: { cursor?: string; limit?: number; projectId?: string; status?: string },
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  return requireObject(
    await transport.getJson(
      workflowDomainListUrl(apiBase, 'workflows', {
        cursor: options.cursor,
        limit: options.limit,
        projectId: options.projectId,
        status: options.status
      })
    ),
    'workflow list'
  )
}

export async function getWorkflowDomainCatalog(
  apiBase: string,
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  return requireObject(await transport.getJson(workflowDomainUrl(apiBase, 'catalog')), 'workflow catalog')
}

export async function startWorkflowDomainGoal(options: StartWorkflowDomainGoalOptions): Promise<JsonObject> {
  const objective = requireText(options.objective, 'objective', 4000)
  const name = requireText(options.starter.name, 'workflow name', 200)
  const templateId = requireText(options.starter.id, 'workflow template id', 120)
  const slug = requireText(options.starter.slug, 'workflow slug', 120)
  const description = requireText(options.starter.description, 'workflow description', 4000)
  const templateVersion = Number(options.starter.version)

  if (
    !/^[a-z0-9-]+$/.test(slug) ||
    !/^[a-z0-9-]+$/.test(templateId) ||
    !Number.isInteger(templateVersion) ||
    templateVersion < 1
  ) {
    throw new Error('Invalid workflow domain workflow slug')
  }

  const project = responseItem(
    await options.transport.postJson(workflowDomainUrl(options.apiBase, 'projects'), {
      name: workflowProjectName(objective),
      objective,
      projectConfig: { createdFrom: 'desktop_start' }
    }),
    'project'
  )

  const projectId = requireText(project.id, 'project id', 160)

  const workflow = responseItem(
    await options.transport.postJson(
      workflowDomainUrl(options.apiBase, `projects/${encodeURIComponent(projectId)}/workflows`),
      {
        name,
        slug,
        description,
        definition: {
          entrypoint: 'hermes',
          objective,
          template: { id: templateId, version: templateVersion }
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
      }
    ),
    'workflow'
  )

  const workflowId = requireText(workflow.id, 'workflow id', 160)

  const run = responseItem(
    await options.transport.postJson(workflowDomainUrl(options.apiBase, 'runs'), {
      workflowId,
      idempotencyKey: `desktop:${options.uuid()}`,
      triggerRef: objective.slice(0, 160),
      executorType: 'hermes',
      maxAttempts: 2
    }),
    'run'
  )

  return { id: requireText(run.id, 'run id', 160) }
}

export async function getWorkflowDomainRun(
  apiBase: string,
  runId: string,
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  const normalizedRunId = requireText(runId, 'run id', 160)

  return projectWorkflowDomainRunOverview(
    await transport.getJson(workflowDomainUrl(apiBase, `runs/${encodeURIComponent(normalizedRunId)}`))
  )
}

export async function cancelWorkflowDomainRun(
  apiBase: string,
  runId: string,
  transport: Pick<WorkflowDomainTransport, 'postJson'>
): Promise<JsonObject> {
  const normalizedRunId = requireText(runId, 'run id', 160)

  return responseItem(
    await transport.postJson(workflowDomainUrl(apiBase, `runs/${encodeURIComponent(normalizedRunId)}/cancel`), {}),
    'cancelled run'
  )
}

export async function reviewWorkflowDomainDeliverable(
  apiBase: string,
  deliverableId: string,
  status: 'approved' | 'changes_requested',
  transport: Pick<WorkflowDomainTransport, 'postJson'>
): Promise<JsonObject> {
  const normalizedId = requireText(deliverableId, 'deliverable id', 160)

  if (status !== 'approved' && status !== 'changes_requested') {
    throw new Error('Invalid workflow domain review status')
  }

  return responseItem(
    await transport.postJson(workflowDomainUrl(apiBase, `deliverables/${encodeURIComponent(normalizedId)}/reviews`), {
      status,
      metrics: {},
      notes: null,
      nextAction: null
    }),
    'deliverable review'
  )
}
