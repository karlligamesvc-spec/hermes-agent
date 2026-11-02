/**
 * apex-plan-usage.ts — what main hands the renderer about the plan and its usage
 * (electron/apex-plan-usage.ts reads it, store/plan-usage.ts holds it).
 */

export type PlanUsagePeriod = 'month' | 'week'

/**
 * hc-1133: the cloud's weekly allowance (hc-1119 `weekly`). The ledger records
 * every call, but `unlimited` only says the allowance is 0, not whether anything
 * is refused at it, so `enforced` is what makes these numbers something to show.
 */
export interface DesktopWeeklyQuota {
  /** Only an explicit `true` from the cloud: calls are refused at this allowance. */
  enforced: boolean
  /** When the week turns over (an ISO instant), or null when the reply has none that parses. */
  resetsAt: null | string
  unlimited: boolean
  /** Share of the allowance used (1.25 = 125%), or null when the reply has no usable number. */
  usedRatio: null | number
}

export interface DesktopPlanUsage {
  period: PlanUsagePeriod
  /** The canonical plan code (`free`, `fast`, `advanced`); absent from a reply that names none. */
  planCode?: string
  planName: string
  /** Share of the allowance used (1.25 = 125%); null when the plan is unlimited. */
  usedRatio: null | number
  /** hc-1133: null or absent when the cloud has no weekly view: its ledger is off, or it predates one. */
  weekly?: DesktopWeeklyQuota | null
}

export interface DesktopPlanUsageResult {
  message?: 'FETCH_FAILED' | 'NOT_SIGNED_IN' | 'SESSION_EXPIRED'
  needsSignIn?: boolean
  ok: boolean
  usage: DesktopPlanUsage | null
}
