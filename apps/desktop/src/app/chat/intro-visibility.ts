/**
 * Whether the empty-chat intro splash renders.
 *
 * The splash is the full-height empty state of the primary chat: it belongs to
 * a fresh draft in the main window and nothing else. Auxiliary and non-primary
 * windows are scratch surfaces, a routed or active session already owns the
 * view, and any transcript at all means the conversation started.
 *
 * `enabled` is the user's Appearance toggle and outranks every other clause:
 * turning the splash off never depends on which window asks.
 */
export function shouldShowIntro(input: {
  activeSessionId: null | string
  auxiliaryWindow: boolean
  enabled: boolean
  freshDraftReady: boolean
  messagesEmpty: boolean
  primary: boolean
  routedSessionView: boolean
  selectedSessionId: null | string
}): boolean {
  return (
    input.enabled &&
    input.primary &&
    !input.auxiliaryWindow &&
    input.freshDraftReady &&
    !input.routedSessionView &&
    !input.selectedSessionId &&
    !input.activeSessionId &&
    input.messagesEmpty
  )
}

/**
 * The business Start surface owns the only primary input while its zero-state
 * is visible. Once a goal/session exists, or an object drawer (currently a
 * Workflow Run or Project detail) is open over Start, the canonical chat composer returns for
 * follow-up, approval, and intervention.
 */
export function shouldShowChatComposer(input: {
  available: boolean
  businessStartVisible: boolean
  objectRouteOpen: boolean
}): boolean {
  return input.available && (!input.businessStartVisible || input.objectRouteOpen)
}
