/** A local Desktop submission receipt, not proof of report generation or turn completion. */
export interface AnalysisChatTarget {
  sessionId: string
  connectionId: string | null
  profile: string
  turn?: { id: string; runtimeSessionId: string }
}
export const ANALYSIS_TURN_STATES = ['running', 'complete', 'error', 'interrupted', 'unavailable'] as const
export type AnalysisTurnState = typeof ANALYSIS_TURN_STATES[number]
export interface AnalysisChatLink extends AnalysisChatTarget {
  submittedAt: string
  outcome?: { status: AnalysisTurnState; observedAt: string }
}

export function sameAnalysisChatLink(current: AnalysisChatLink | null | undefined, expected: AnalysisChatLink): boolean {
  return current?.sessionId === expected.sessionId && current.connectionId === expected.connectionId &&
    current.profile === expected.profile && current.submittedAt === expected.submittedAt &&
    current.turn?.id === expected.turn?.id && current.turn?.runtimeSessionId === expected.turn?.runtimeSessionId
}

export function validAnalysisTurnState(value: unknown): value is AnalysisTurnState {
  return typeof value === 'string' && ANALYSIS_TURN_STATES.includes(value as AnalysisTurnState)
}

export function validAnalysisChatTarget(value: unknown): value is AnalysisChatTarget {
  if (!value || typeof value !== 'object') {return false}
  const item = value as Partial<AnalysisChatTarget>
  const bounded = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 256 && [...s].every(char => char.charCodeAt(0) >= 32)

  return bounded(item.sessionId) && bounded(item.profile) && (item.connectionId === null || bounded(item.connectionId)) &&
    (item.turn === undefined || (item.turn !== null && typeof item.turn === 'object' &&
      bounded(item.turn.id) && item.turn.id.length <= 64 && bounded(item.turn.runtimeSessionId)))
}
