/**
 * apex-plan-usage.ts — hc-1061 / hc-1062
 *
 * The single-thread sidebar's account row says the plan and how much of its
 * allowance is used (「快速 · 本月用了 18%」). The cloud is the only authority on
 * both, so this module reads them with the stored login JWT and hands the
 * renderer a small, validated summary; the JWT never crosses to the renderer.
 * Electron-free so it runs under `vitest --project electron`, like apex-team.ts.
 *
 * Backend contract (apex-nodes `app/routers/account_plan_usage.py`):
 *   GET {API_BASE}/api/v1/account/plan-usage
 *   Authorization: Bearer <login JWT>
 *   200 → { plan: { code, name }, period: 'month', period_key, resets_at,
 *           unlimited, quota_tokens, used_tokens, used_ratio,
 *           weekly: null | { resets_at, unlimited, allowance_cents, used_ratio, enforced? } }
 *   403 → an installer-only account (its grant is not this monthly quota)
 *   404 → a cloud from before this read
 *
 * Display only, and only what it can confirm: any failure or malformed reply
 * reads as "no usage line", and the row falls back to the email.
 */

import type { DesktopPlanUsage, DesktopPlanUsageResult, DesktopWeeklyQuota } from '../shared/apex-plan-usage'

import type { AccountReadDeps } from './apex-team'

export type { DesktopPlanUsage, DesktopPlanUsageResult } from '../shared/apex-plan-usage'

const PLAN_USAGE_PATH = '/api/v1/account/plan-usage'

export function planUsageUrl(apiBase: string): string {
  return `${String(apiBase || '').replace(/\/+$/, '')}${PLAN_USAGE_PATH}`
}

function ratioOf(body: Record<string, unknown>): null | number | undefined {
  if (body.unlimited === true) {
    return null
  }

  const ratio = body.used_ratio

  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 ? ratio : undefined
}

/**
 * hc-1133: the weekly view as the cloud states it. `enforced` is not in the reply
 * while the ledger only records (hc-1119, shadow), which is the point: nothing
 * here treats the numbers as a limit until the cloud says they are one.
 */
function parseWeekly(value: unknown): DesktopWeeklyQuota | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const weekly = value as Record<string, unknown>
  const ratio = weekly.used_ratio
  const resetsAt = weekly.resets_at

  return {
    enforced: weekly.enforced === true,
    resetsAt: typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt)) ? resetsAt : null,
    unlimited: weekly.unlimited === true,
    usedRatio: typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 ? ratio : null
  }
}

/** The usage the response names, or null for anything this row cannot say truthfully. */
export function parsePlanUsage(body: unknown): DesktopPlanUsage | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const record = body as Record<string, unknown>
  const plan = record.plan && typeof record.plan === 'object' ? (record.plan as Record<string, unknown>) : {}
  const planCode = typeof plan.code === 'string' ? plan.code.trim().toLowerCase() : ''
  const planName = typeof plan.name === 'string' ? plan.name.trim() : ''
  const period = record.period
  const usedRatio = ratioOf(record)

  if (!planName || (period !== 'month' && period !== 'week') || usedRatio === undefined) {
    return null
  }

  return { period, ...(planCode ? { planCode } : {}), planName, usedRatio, weekly: parseWeekly(record.weekly) }
}

function statusCodeOf(error: unknown): number | undefined {
  const code = error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined

  return typeof code === 'number' ? code : undefined
}

/** Never throws: the sidebar must draw whatever the network does. */
export async function fetchPlanUsage(deps: AccountReadDeps): Promise<DesktopPlanUsageResult> {
  const token = String(deps.accessToken() || '').trim()

  if (!token) {
    return { message: 'NOT_SIGNED_IN', needsSignIn: true, ok: false, usage: null }
  }

  try {
    return { ok: true, usage: parsePlanUsage(await deps.getJson(planUsageUrl(deps.apiBase()), { bearer: token })) }
  } catch (error) {
    const code = statusCodeOf(error)

    if (code === 401) {
      return { message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, usage: null }
    }

    if (code === 403 || code === 404) {
      return { ok: true, usage: null }
    }

    deps.log(`[plan-usage] fetch failed: ${error instanceof Error ? error.message : String(error)}`)

    return { message: 'FETCH_FAILED', ok: false, usage: null }
  }
}
