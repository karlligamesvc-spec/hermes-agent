/** A local Desktop submission receipt, not proof of report generation or turn completion. */
export interface AnalysisChatTarget {
  sessionId: string
  connectionId: string | null
  profile: string
}
export interface AnalysisChatLink extends AnalysisChatTarget { submittedAt: string }

export function validAnalysisChatTarget(value: unknown): value is AnalysisChatTarget {
  if (!value || typeof value !== 'object') {return false}
  const item = value as Partial<AnalysisChatTarget>
  const bounded = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 256 && [...s].every(char => char.charCodeAt(0) >= 32)

  return bounded(item.sessionId) && bounded(item.profile) && (item.connectionId === null || bounded(item.connectionId))
}
