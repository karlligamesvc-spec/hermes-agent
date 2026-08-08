import fs from 'node:fs'
import path from 'node:path'

export const DESKTOP_UPDATE_PLAN_SCHEMA_VERSION = 1

export interface DesktopUpdatePlan {
  schemaVersion: 1
  kind: 'runtime-after-shell'
  requestedAt: string
  targetShellVersion: string | null
  targetRuntimeVersion: string | null
}

export interface DesktopUpdatePlanInput {
  kind: 'runtime-after-shell'
  targetShellVersion?: string | null
  targetRuntimeVersion?: string | null
}

function cleanVersion(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const clean = value.trim()

  return clean ? clean.slice(0, 160) : null
}

export function normalizeDesktopUpdatePlan(value: unknown): DesktopUpdatePlan | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Record<string, unknown>

  if (candidate.schemaVersion !== DESKTOP_UPDATE_PLAN_SCHEMA_VERSION || candidate.kind !== 'runtime-after-shell') {
    return null
  }

  if (typeof candidate.requestedAt !== 'string' || !candidate.requestedAt.trim()) {
    return null
  }

  return {
    schemaVersion: DESKTOP_UPDATE_PLAN_SCHEMA_VERSION,
    kind: 'runtime-after-shell',
    requestedAt: candidate.requestedAt,
    targetShellVersion: cleanVersion(candidate.targetShellVersion),
    targetRuntimeVersion: cleanVersion(candidate.targetRuntimeVersion)
  }
}

export function readDesktopUpdatePlan(filePath: string): DesktopUpdatePlan | null {
  try {
    return normalizeDesktopUpdatePlan(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

export function writeDesktopUpdatePlan(filePath: string, input: DesktopUpdatePlanInput): DesktopUpdatePlan {
  const plan: DesktopUpdatePlan = {
    schemaVersion: DESKTOP_UPDATE_PLAN_SCHEMA_VERSION,
    kind: 'runtime-after-shell',
    requestedAt: new Date().toISOString(),
    targetShellVersion: cleanVersion(input.targetShellVersion),
    targetRuntimeVersion: cleanVersion(input.targetRuntimeVersion)
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch {
      // The rename already made the plan durable. Cleanup is best-effort.
    }
  }

  return plan
}

export function clearDesktopUpdatePlan(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    // Idempotent and fail-open; a later successful resume can retry cleanup.
  }
}
