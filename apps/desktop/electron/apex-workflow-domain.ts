const WORKFLOW_DOMAIN_PATH = '/api/v1/workflow-domain'

type JsonObject = Record<string, unknown>

export interface WorkflowDomainTransport {
  getJson: (url: string) => Promise<unknown>
  postJson: (url: string, body: JsonObject) => Promise<unknown>
}

export interface WorkflowDomainStarter {
  description: string
  name: string
  slug: string
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

export async function startWorkflowDomainGoal(options: StartWorkflowDomainGoalOptions): Promise<JsonObject> {
  const objective = requireText(options.objective, 'objective', 4000)
  const name = requireText(options.starter.name, 'workflow name', 200)
  const slug = requireText(options.starter.slug, 'workflow slug', 120)
  const description = requireText(options.starter.description, 'workflow description', 4000)

  if (!/^[a-z0-9-]+$/.test(slug)) {
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
          steps: ['clarify', 'execute', 'deliver']
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

  return responseItem(
    await options.transport.postJson(workflowDomainUrl(options.apiBase, 'runs'), {
      workflowId,
      idempotencyKey: `desktop:${options.uuid()}`,
      triggerRef: objective.slice(0, 160),
      executorType: 'hermes',
      maxAttempts: 2
    }),
    'run'
  )
}

export async function getWorkflowDomainRun(
  apiBase: string,
  runId: string,
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  const normalizedRunId = requireText(runId, 'run id', 160)

  return requireObject(
    await transport.getJson(workflowDomainUrl(apiBase, `runs/${encodeURIComponent(normalizedRunId)}`)),
    'run overview'
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
