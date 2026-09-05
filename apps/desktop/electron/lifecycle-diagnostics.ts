import crypto from 'node:crypto'

export interface DesktopLifecycleContext {
  instanceNonce: string
  startedAt: string
  pid: number
  parentPid: number
  argv: string[]
  userData: string
}

export interface DesktopLifecycleContextInput {
  argv: readonly string[]
  parentPid: number
  pid: number
  userData: string
  now?: () => Date
  randomUUID?: () => string
}

const SECRET_QUERY_KEYS = new Set(['access_token', 'code', 'refresh_token', 'ticket', 'token'])
const SECRET_FLAGS = new Set(['--access-token', '--code', '--refresh-token', '--ticket', '--token'])

function redactUrlArgument(value: string): string {
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    return value
  }

  for (const key of SECRET_QUERY_KEYS) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, '<redacted>')
    }
  }

  const hashQueryIndex = parsed.hash.indexOf('?')

  if (hashQueryIndex >= 0) {
    const hashPath = parsed.hash.slice(0, hashQueryIndex)
    const hashParams = new URLSearchParams(parsed.hash.slice(hashQueryIndex + 1))

    for (const key of SECRET_QUERY_KEYS) {
      if (hashParams.has(key)) {
        hashParams.set(key, '<redacted>')
      }
    }

    parsed.hash = `${hashPath}?${hashParams.toString()}`
  }

  return parsed.toString()
}

export function sanitizeLifecycleArgv(argv: readonly string[]): string[] {
  const sanitized: string[] = []
  let redactNext = false

  for (const rawArg of argv) {
    const arg = String(rawArg)

    if (redactNext) {
      sanitized.push('<redacted>')
      redactNext = false

      continue
    }

    const separator = arg.indexOf('=')
    const flag = separator >= 0 ? arg.slice(0, separator) : arg

    if (SECRET_FLAGS.has(flag)) {
      if (separator >= 0) {
        sanitized.push(`${flag}=<redacted>`)
      } else {
        sanitized.push(flag)
        redactNext = true
      }

      continue
    }

    sanitized.push(redactUrlArgument(arg))
  }

  return sanitized
}

export function createDesktopLifecycleContext(input: DesktopLifecycleContextInput): DesktopLifecycleContext {
  const now = input.now ?? (() => new Date())
  const randomUUID = input.randomUUID ?? crypto.randomUUID

  return {
    instanceNonce: randomUUID(),
    startedAt: now().toISOString(),
    pid: input.pid,
    parentPid: input.parentPid,
    argv: sanitizeLifecycleArgv(input.argv),
    userData: input.userData
  }
}

export function formatLifecycleEvent(
  event: string,
  context: DesktopLifecycleContext,
  fields: Record<string, unknown> = {},
  now: () => Date = () => new Date()
): string {
  // Call-site fields are useful context, but must never be able to forge the
  // process identity or event name that makes a lifecycle line attributable.
  return `[lifecycle] ${JSON.stringify({ ...fields, ...context, event, eventAt: now().toISOString() })}`
}

export function processGoneLifecycleFields(
  details: {
    exitCode?: unknown
    name?: unknown
    reason?: unknown
    serviceName?: unknown
    type?: unknown
  } = {}
): Record<string, unknown> {
  const exitCode = Number(details.exitCode)

  return {
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    name: String(details.name || ''),
    reason: String(details.reason || 'unknown'),
    serviceName: String(details.serviceName || ''),
    type: String(details.type || '')
  }
}

export function httpFailureLifecycleFields(input: {
  method?: unknown
  path?: unknown
  pageUrl?: unknown
  statusCode?: unknown
}): Record<string, unknown> {
  return {
    method: String(input.method || 'GET').toUpperCase(),
    path: String(input.path || ''),
    pageUrl: redactUrlArgument(String(input.pageUrl || 'unknown')),
    statusCode: Number(input.statusCode) || 0
  }
}
