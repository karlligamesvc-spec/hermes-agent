const WORKFLOW_DOMAIN_PATH = '/api/v1/workflow-domain'
const DELIVERABLE_STATUSES = new Set(['approved', 'draft', 'in_review', 'ready', 'rejected', 'superseded'])
const RUN_ACTIVITY_STATUSES = new Set([
  'cancel_requested',
  'cancelled',
  'failed',
  'queued',
  'retry_deferred',
  'retry_scheduled',
  'running',
  'succeeded',
  'timed_out',
  'waiting_review'
])
const REVIEW_STATUSES = new Set(['approved', 'changes_requested', 'pending', 'rejected'])

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

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function uuidText(value: unknown, field: string): string {
  const normalized = requireText(value, field, 36).toLowerCase()

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`Invalid workflow domain ${field}`)
  }

  return normalized
}

function publicUrl(value: unknown): null | string {
  const normalized = optionalText(value, 4000)

  if (!normalized) {
    return null
  }

  try {
    const url = new URL(normalized)

    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function rendererPublicUrl(value: unknown): null | string {
  const normalized = publicUrl(value)

  if (!normalized) {
    return null
  }

  const url = new URL(normalized)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const ipLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':')
  const privateName = hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')

  if (url.protocol !== 'https:' || url.search || url.hash || ipLiteral || privateName) {
    return null
  }

  return url.toString()
}

function projectWorkflowDomainReview(value: unknown): JsonObject {
  const review = requireObject(value, 'deliverable review')
  const status = requireText(review.status, 'deliverable review status', 48)

  if (status !== 'pending' && status !== 'approved' && status !== 'changes_requested' && status !== 'rejected') {
    throw new Error('Invalid workflow domain deliverable review status')
  }

  const metrics = requireObject(review.metrics ?? {}, 'deliverable review metrics')
  const projectedMetrics: JsonObject = {}

  for (const key of ['citationCoverage', 'completeness', 'qualityScore', 'issueCount'] as const) {
    const metric = optionalNumber(metrics[key])

    if (metric !== undefined) {
      projectedMetrics[key] = metric
    }
  }

  const passed = optionalBoolean(metrics.passed)

  if (passed !== undefined) {
    projectedMetrics.passed = passed
  }

  const rawNextAction = review.nextAction
  let nextAction: JsonObject | null = null

  if (rawNextAction && typeof rawNextAction === 'object' && !Array.isArray(rawNextAction)) {
    const next = rawNextAction as JsonObject
    nextAction = {}

    for (const [key, limit] of [
      ['type', 80],
      ['label', 240],
      ['targetId', 160]
    ] as const) {
      const text = optionalText(next[key], limit)

      if (text) {
        nextAction[key] = text
      }
    }
  }

  return {
    createdAt: optionalText(review.createdAt, 80),
    decidedAt: optionalText(review.decidedAt, 80),
    id: requireText(review.id, 'deliverable review id', 160),
    metrics: projectedMetrics,
    nextAction,
    notes: optionalText(review.notes, 8000),
    reviewerType: requireText(review.reviewerType, 'deliverable reviewer type', 48),
    roundNumber: requireInteger(review.roundNumber, 'deliverable review round', 1),
    status,
    updatedAt: optionalText(review.updatedAt, 80)
  }
}

function projectWorkflowDomainDeliverable(value: unknown): JsonObject {
  const deliverable = requireObject(value, 'deliverable')
  const executorType = requireText(deliverable.executorType, 'deliverable executor type', 48).toLowerCase()
  const status = requireText(deliverable.status, 'deliverable status', 48)

  if (executorType !== 'hermes') {
    throw new Error('Unsupported workflow domain executor')
  }

  if (!DELIVERABLE_STATUSES.has(status)) {
    throw new Error('Invalid workflow domain deliverable status')
  }

  const payload = requireObject(deliverable.payload ?? {}, 'deliverable payload')
  const projectedPayload: JsonObject = {}

  for (const [key, limit] of [
    ['format', 80],
    ['content', 8000],
    ['summary', 8000],
    ['filename', 500],
    ['mimeType', 160]
  ] as const) {
    const text = optionalText(payload[key], limit)

    if (text) {
      projectedPayload[key] = text
    }
  }

  const partial = optionalBoolean(payload.partial)

  if (partial !== undefined) {
    projectedPayload.partial = partial
  }

  if (Array.isArray(payload.highlights)) {
    projectedPayload.highlights = payload.highlights.slice(0, 20).flatMap(item => {
      const highlight = optionalText(item, 1000)

      return highlight ? [highlight] : []
    })
  }

  const evidence = Array.isArray(deliverable.evidence)
    ? deliverable.evidence.slice(0, 500).map(value => {
        const item = requireObject(value, 'deliverable evidence')
        const projected: JsonObject = {}

        for (const [key, limit] of [
          ['title', 1000],
          ['source', 1000],
          ['quote', 8000],
          ['capturedAt', 80],
          ['verificationStatus', 80]
        ] as const) {
          const text = optionalText(item[key], limit)

          if (text) {
            projected[key] = text
          }
        }

        const url = rendererPublicUrl(item.url)

        if (url) {
          projected.url = url
        }

        const verified = optionalBoolean(item.verified)

        if (verified !== undefined) {
          projected.verified = verified
        }

        return projected
      })
    : []

  const rawStorageTarget = deliverable.storageTarget
  let storageTarget: JsonObject | null = null

  if (rawStorageTarget && typeof rawStorageTarget === 'object' && !Array.isArray(rawStorageTarget)) {
    const target = rawStorageTarget as JsonObject

    if (target.kind === 'user_file') {
      storageTarget = { id: uuidText(target.id, 'user file id'), kind: 'user_file' }
    }
  }

  const rawVerifier = deliverable.verifierResult
  let verifierResult: JsonObject | null = null

  if (rawVerifier && typeof rawVerifier === 'object' && !Array.isArray(rawVerifier)) {
    const verifier = rawVerifier as JsonObject
    verifierResult = {}

    for (const [key, limit] of [
      ['status', 80],
      ['reason', 4000],
      ['checkedAt', 80]
    ] as const) {
      const text = optionalText(verifier[key], limit)

      if (text) {
        verifierResult[key] = text
      }
    }

    for (const key of ['citationCoverage', 'evidenceCount'] as const) {
      const metric = optionalNumber(verifier[key])

      if (metric !== undefined) {
        verifierResult[key] = metric
      }
    }

    const passed = optionalBoolean(verifier.passed)

    if (passed !== undefined) {
      verifierResult.passed = passed
    }
  }

  return {
    createdAt: requireText(deliverable.createdAt, 'deliverable creation time', 80),
    evidence,
    executorType,
    executorVersion: optionalText(deliverable.executorVersion, 160),
    id: requireText(deliverable.id, 'deliverable id', 160),
    kind: requireText(deliverable.kind, 'deliverable kind', 80),
    payload: projectedPayload,
    projectId: requireText(deliverable.projectId, 'deliverable project id', 160),
    reviews: Array.isArray(deliverable.reviews)
      ? deliverable.reviews.slice(0, 100).map(projectWorkflowDomainReview)
      : [],
    runId: requireText(deliverable.runId, 'deliverable run id', 160),
    // The cloud contract uses a namespaced schema identifier
    // (`deliverable/v1`), not an integer revision. Treating it as a number
    // rejected every otherwise-valid production Deliverable after a 200.
    schemaVersion: requireText(deliverable.schemaVersion, 'deliverable schema version', 80),
    sourceCapturedAt: optionalText(deliverable.sourceCapturedAt, 80),
    status,
    storageTarget,
    title: requireText(deliverable.title, 'deliverable title', 240),
    updatedAt: requireText(deliverable.updatedAt, 'deliverable update time', 80),
    verifierResult
  }
}

export function projectWorkflowDomainDeliverableList(value: unknown): JsonObject {
  const result = requireObject(value, 'deliverable list')

  if (!Array.isArray(result.items)) {
    throw new Error('Invalid workflow domain deliverable list response')
  }

  return {
    items: result.items.map(projectWorkflowDomainDeliverable),
    nextCursor: optionalText(result.nextCursor, 512)
  }
}

export function projectWorkflowDomainDeliverableDetail(value: unknown): JsonObject {
  const detail = requireObject(value, 'deliverable detail')
  const project = requireObject(detail.project, 'deliverable detail project')
  const workflow = requireObject(detail.workflow, 'deliverable detail workflow')
  const run = requireObject(detail.run, 'deliverable detail run')

  if (requireText(run.executorType, 'deliverable run executor type', 48).toLowerCase() !== 'hermes') {
    throw new Error('Unsupported workflow domain executor')
  }

  return {
    item: projectWorkflowDomainDeliverable(detail.item),
    project: {
      createdAt: requireText(project.createdAt, 'project creation time', 80),
      id: requireText(project.id, 'project id', 160),
      name: requireText(project.name, 'project name', 200),
      objective: optionalText(project.objective, 4000) ?? '',
      status: requireText(project.status, 'project status', 48),
      updatedAt: requireText(project.updatedAt, 'project update time', 80)
    },
    run: {
      completedAt: optionalText(run.completedAt, 80),
      createdAt: requireText(run.createdAt, 'run creation time', 80),
      id: requireText(run.id, 'run id', 160),
      startedAt: optionalText(run.startedAt, 80),
      status: requireText(run.status, 'run status', 48),
      updatedAt: requireText(run.updatedAt, 'run update time', 80)
    },
    workflow: {
      createdAt: requireText(workflow.createdAt, 'workflow creation time', 80),
      description: optionalText(workflow.description, 4000),
      id: requireText(workflow.id, 'workflow id', 160),
      name: requireText(workflow.name, 'workflow name', 200),
      projectId: requireText(workflow.projectId, 'workflow project id', 160),
      slug: requireText(workflow.slug, 'workflow slug', 120),
      status: requireText(workflow.status, 'workflow status', 48),
      updatedAt: requireText(workflow.updatedAt, 'workflow update time', 80),
      version: workflow.version === null ? null : requireInteger(workflow.version, 'workflow version', 1)
    }
  }
}

export function projectWorkflowDomainActivityList(value: unknown): JsonObject {
  const result = requireObject(value, 'activity list')

  if (!Array.isArray(result.items)) {
    throw new Error('Invalid workflow domain activity list response')
  }

  return {
    items: result.items.map(value => {
      const item = requireObject(value, 'activity item')
      const kind = requireText(item.kind, 'activity kind', 48)

      if (kind !== 'run' && kind !== 'deliverable' && kind !== 'review') {
        throw new Error('Invalid workflow domain activity kind')
      }

      const target = requireObject(item.target, 'activity target')
      const targetKind = requireText(target.kind, 'activity target kind', 48)

      if (targetKind !== 'run' && targetKind !== 'deliverable') {
        throw new Error('Invalid workflow domain activity target')
      }

      const expectedTargetKind = kind === 'run' ? 'run' : 'deliverable'

      if (targetKind !== expectedTargetKind) {
        throw new Error('Mismatched workflow domain activity target')
      }

      const status = requireText(item.status, 'activity status', 120)
      const allowedStatuses =
        kind === 'run' ? RUN_ACTIVITY_STATUSES : kind === 'review' ? REVIEW_STATUSES : DELIVERABLE_STATUSES

      if (!allowedStatuses.has(status)) {
        throw new Error('Invalid workflow domain activity status')
      }

      return {
        happenedAt: requireText(item.happenedAt, 'activity time', 80),
        id: requireText(item.id, 'activity id', 200),
        kind,
        status,
        summary: optionalText(item.summary, 8000),
        target: { id: requireText(target.id, 'activity target id', 160), kind: targetKind },
        title: requireText(item.title, 'activity title', 240)
      }
    }),
    nextCursor: optionalText(result.nextCursor, 512)
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
    const deliverable = projectWorkflowDomainDeliverable(value)

    const reviews = (deliverable.reviews as JsonObject[])
      .map(review => ({
        createdAt: review.createdAt,
        id: review.id,
        roundNumber: review.roundNumber,
        status: review.status
      }))
      .sort(
        (left, right) =>
          Number(left.roundNumber) - Number(right.roundNumber) || String(left.id).localeCompare(String(right.id))
      )

    return {
      createdAt: deliverable.createdAt,
      evidenceCount: (deliverable.evidence as JsonObject[]).length,
      id: deliverable.id,
      kind: deliverable.kind,
      openReference: null,
      reviews,
      status: deliverable.status,
      title: deliverable.title,
      updatedAt: deliverable.updatedAt
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

  if (
    !/^[a-z0-9-]+$/.test(slug) ||
    !/^[a-z0-9-]+$/.test(templateId) ||
    !Number.isInteger(templateVersion) ||
    templateVersion < 1
  ) {
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

export async function listWorkflowDomainDeliverables(
  apiBase: string,
  options: { cursor?: string; kind?: string; limit?: number; projectId?: string; status?: string },
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  return projectWorkflowDomainDeliverableList(
    await transport.getJson(
      workflowDomainListUrl(apiBase, 'deliverables', {
        cursor: options.cursor,
        kind: options.kind,
        limit: options.limit,
        projectId: options.projectId,
        status: options.status
      })
    )
  )
}

export async function getWorkflowDomainDeliverable(
  apiBase: string,
  deliverableId: string,
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  const normalizedId = requireText(deliverableId, 'deliverable id', 160)

  return projectWorkflowDomainDeliverableDetail(
    await transport.getJson(workflowDomainUrl(apiBase, `deliverables/${encodeURIComponent(normalizedId)}`))
  )
}

export async function listWorkflowDomainActivity(
  apiBase: string,
  options: { cursor?: string; kinds?: string; limit?: number },
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<JsonObject> {
  return projectWorkflowDomainActivityList(
    await transport.getJson(
      workflowDomainListUrl(apiBase, 'activity', {
        cursor: options.cursor,
        kinds: options.kinds,
        limit: options.limit
      })
    )
  )
}

export async function getWorkflowDomainUserFileDownload(
  apiBase: string,
  fileId: string,
  transport: Pick<WorkflowDomainTransport, 'getJson'>
): Promise<{ filename: null | string; url: string }> {
  const normalizedBase = trimmed(apiBase).replace(/\/+$/, '')
  const normalizedId = uuidText(fileId, 'user file id')
  const requestUrl = new URL(`${normalizedBase}/api/v1/account/files/${encodeURIComponent(normalizedId)}/download`)

  if (requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'https:') {
    throw new Error(`Unsupported ApexNodes URL protocol: ${requestUrl.protocol}`)
  }

  const result = requireObject(await transport.getJson(requestUrl.toString()), 'user file download')

  const url = publicUrl(result.download_url)

  if (!url) {
    throw new Error('Invalid workflow domain user file download URL')
  }

  return { filename: optionalText(result.filename, 500), url }
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
  notes: string | undefined,
  transport: Pick<WorkflowDomainTransport, 'postJson'>
): Promise<JsonObject> {
  const normalizedId = requireText(deliverableId, 'deliverable id', 160)

  if (status !== 'approved' && status !== 'changes_requested') {
    throw new Error('Invalid workflow domain review status')
  }

  if (notes !== undefined && typeof notes !== 'string') {
    throw new Error('Invalid workflow domain review notes')
  }

  const normalizedNotes = notes === undefined ? null : optionalText(notes, 8000)

  if (
    (notes !== undefined && trimmed(notes) && !normalizedNotes) ||
    (status === 'changes_requested' && !normalizedNotes)
  ) {
    throw new Error('Invalid workflow domain review notes')
  }

  return responseItem(
    await transport.postJson(workflowDomainUrl(apiBase, `deliverables/${encodeURIComponent(normalizedId)}/reviews`), {
      status,
      metrics: {},
      notes: normalizedNotes,
      nextAction: null
    }),
    'deliverable review'
  )
}
