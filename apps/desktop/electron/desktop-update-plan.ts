import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const DESKTOP_UPDATE_PLAN_SCHEMA_VERSION = 1

export type DesktopUpdatePlanKind = 'runtime-after-shell' | 'shell-only'
export type DesktopUpdatePlanPhase = 'failed' | 'ready-to-restart' | 'resuming'

export interface DesktopUpdatePlan {
  schemaVersion: 1
  planId: string | null
  kind: DesktopUpdatePlanKind
  phase: DesktopUpdatePlanPhase
  requestedAt: string
  createdAt: string
  updatedAt: string
  currentShellVersion: string | null
  targetShellVersion: string | null
  currentRuntimeKey: string | null
  currentRuntimeVersion: string | null
  targetRuntimeKey: string | null
  targetRuntimeVersion: string | null
  attempts: number
  lastError: string | null
}

export interface DesktopUpdatePlanInput {
  kind: DesktopUpdatePlanKind
  currentShellVersion?: string | null
  targetShellVersion?: string | null
  currentRuntimeKey?: string | null
  currentRuntimeVersion?: string | null
  targetRuntimeKey?: string | null
  targetRuntimeVersion?: string | null
}

export interface DesktopUpdatePlanReadOptions {
  quarantineInvalid?: boolean
  onQuarantine?: (quarantinePath: string, reason: string) => void
}

export interface DesktopUpdatePlanTransition {
  phase: DesktopUpdatePlanPhase
  lastError?: string | null
  incrementAttempt?: boolean
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const clean = value.trim()

  return clean ? clean.slice(0, maxLength) : null
}

function cleanVersion(value: unknown): string | null {
  return cleanText(value, 160)
}

function cleanTimestamp(value: unknown): string | null {
  const clean = cleanText(value, 80)

  return clean && Number.isFinite(Date.parse(clean)) ? clean : null
}

function cleanAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, 1_000) : 0
}

export function normalizeDesktopUpdatePlan(value: unknown): DesktopUpdatePlan | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Record<string, unknown>
  const requestedAt = cleanTimestamp(candidate.requestedAt)
  const kind = candidate.kind

  if (
    candidate.schemaVersion !== DESKTOP_UPDATE_PLAN_SCHEMA_VERSION ||
    (kind !== 'runtime-after-shell' && kind !== 'shell-only') ||
    !requestedAt
  ) {
    return null
  }

  const phase = candidate.phase

  const normalizedPhase: DesktopUpdatePlanPhase =
    phase === 'failed' || phase === 'resuming' || phase === 'ready-to-restart' ? phase : 'ready-to-restart'

  return {
    schemaVersion: DESKTOP_UPDATE_PLAN_SCHEMA_VERSION,
    planId: cleanText(candidate.planId, 160),
    kind,
    phase: normalizedPhase,
    requestedAt,
    createdAt: cleanTimestamp(candidate.createdAt) ?? requestedAt,
    updatedAt: cleanTimestamp(candidate.updatedAt) ?? requestedAt,
    currentShellVersion: cleanVersion(candidate.currentShellVersion),
    targetShellVersion: cleanVersion(candidate.targetShellVersion),
    currentRuntimeKey: cleanVersion(candidate.currentRuntimeKey),
    currentRuntimeVersion: cleanVersion(candidate.currentRuntimeVersion),
    targetRuntimeKey: cleanVersion(candidate.targetRuntimeKey),
    targetRuntimeVersion: cleanVersion(candidate.targetRuntimeVersion),
    attempts: cleanAttempts(candidate.attempts),
    lastError: cleanText(candidate.lastError, 512)
  }
}

function writePlanAtomically(filePath: string, plan: DesktopUpdatePlan): void {
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
}

function quarantineDesktopUpdatePlan(filePath: string, reason: string, options: DesktopUpdatePlanReadOptions): void {
  if (!options.quarantineInvalid || !fs.existsSync(filePath)) {
    return
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const quarantinePath = `${filePath}.corrupt-${timestamp}-${process.pid}`

  try {
    fs.renameSync(filePath, quarantinePath)
    options.onQuarantine?.(quarantinePath, reason)
  } catch {
    // A damaged recovery plan must never block Desktop startup. If isolation
    // itself fails, leave the file in place and fail open for this launch.
  }
}

export function readDesktopUpdatePlan(
  filePath: string,
  options: DesktopUpdatePlanReadOptions = {}
): DesktopUpdatePlan | null {
  let raw: string

  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      quarantineDesktopUpdatePlan(filePath, 'read_failed', options)
    }

    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    quarantineDesktopUpdatePlan(filePath, 'invalid_json', options)

    return null
  }

  const plan = normalizeDesktopUpdatePlan(parsed)

  if (!plan) {
    quarantineDesktopUpdatePlan(filePath, 'invalid_schema', options)
  }

  return plan
}

export function writeDesktopUpdatePlan(filePath: string, input: DesktopUpdatePlanInput): DesktopUpdatePlan {
  const now = new Date().toISOString()

  const plan: DesktopUpdatePlan = {
    schemaVersion: DESKTOP_UPDATE_PLAN_SCHEMA_VERSION,
    planId: crypto.randomUUID(),
    kind: input.kind,
    phase: 'ready-to-restart',
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
    currentShellVersion: cleanVersion(input.currentShellVersion),
    targetShellVersion: cleanVersion(input.targetShellVersion),
    currentRuntimeKey: cleanVersion(input.currentRuntimeKey),
    currentRuntimeVersion: cleanVersion(input.currentRuntimeVersion),
    targetRuntimeKey: cleanVersion(input.targetRuntimeKey),
    targetRuntimeVersion: cleanVersion(input.targetRuntimeVersion),
    attempts: 0,
    lastError: null
  }

  writePlanAtomically(filePath, plan)

  return plan
}

export function transitionDesktopUpdatePlan(
  filePath: string,
  transition: DesktopUpdatePlanTransition,
  options: DesktopUpdatePlanReadOptions = {}
): DesktopUpdatePlan | null {
  const current = readDesktopUpdatePlan(filePath, options)

  if (!current) {
    return null
  }

  const next: DesktopUpdatePlan = {
    ...current,
    phase: transition.phase,
    updatedAt: new Date().toISOString(),
    attempts: transition.incrementAttempt ? Math.min(current.attempts + 1, 1_000) : current.attempts,
    lastError: cleanText(transition.lastError, 512)
  }

  writePlanAtomically(filePath, next)

  return next
}

export function clearDesktopUpdatePlan(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    // Idempotent and fail-open; a later successful resume can retry cleanup.
  }
}
