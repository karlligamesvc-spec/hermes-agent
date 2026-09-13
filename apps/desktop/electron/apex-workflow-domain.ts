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
  projectId?: string
  starter: WorkflowDomainStarter
  transport: WorkflowDomainTransport
  uuid: () => string
}

export interface CreateWorkflowDomainProjectOptions {
  apiBase: string
  createdFrom?: 'desktop_projects' | 'desktop_start'
  localPath?: string
  name: string
  objective: string
  transport: Pick<WorkflowDomainTransport, 'postJson'>
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

function workflowDomainListUrl(apiBase: string, path: string, query: Record<string, null | number | string | undefined>) {
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

export async function createWorkflowDomainProject(options: CreateWorkflowDomainProjectOptions): Promise<JsonObject> {
  const name = requireText(options.name, 'project name', 200)
  const objective = requireText(options.objective, 'objective', 4000)
  const localPath = trimmed(options.localPath)

  return responseItem(
    await options.transport.postJson(workflowDomainUrl(options.apiBase, 'projects'), {
      name,
      objective,
      projectConfig: {
        createdFrom: options.createdFrom ?? 'desktop_projects',
        ...(localPath ? { localPath } : {})
      }
    }),
    'project'
  )
}

export async function startWorkflowDomainGoal(options: StartWorkflowDomainGoalOptions): Promise<JsonObject> {
  const objective = requireText(options.objective, 'objective', 4000)
  const name = requireText(options.starter.name, 'workflow name', 200)
  const templateId = requireText(options.starter.id, 'workflow template id', 120)
  const slug = requireText(options.starter.slug, 'workflow slug', 120)
  const description = requireText(options.starter.description, 'workflow description', 4000)
  const templateVersion = Number(options.starter.version)

  if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9-]+$/.test(templateId) || !Number.isInteger(templateVersion) || templateVersion < 1) {
    throw new Error('Invalid workflow domain workflow slug')
  }

  const projectId = options.projectId
    ? requireText(options.projectId, 'project id', 160)
    : requireText(
        (
          await createWorkflowDomainProject({
            apiBase: options.apiBase,
            createdFrom: 'desktop_start',
            name: workflowProjectName(objective),
            objective,
            transport: options.transport
          })
        ).id,
        'project id',
        160
      )

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
