/**
 * Cross-cutting bus: picking a scenario (zero-state shelf or the ✦ menu) needs
 * to touch session lifecycle — start a fresh draft when the current session
 * already has content, and queue the scenario's name as that new session's
 * title — but the picker components (`scenario-shelf.tsx`, `scenario-button.tsx`)
 * live far from `useSessionActions`, which owns both `startFreshSessionDraft`
 * and the gateway connection. Dispatched from `./pick`; the desktop controller
 * (the sole place `useSessionActions` is mounted) is the sole subscriber.
 * Mirrors the composer's own external-request bus (`../composer/focus`).
 */

export interface ScenarioSessionRequest {
  /** The scenario's catalog name (e.g. "拆一条视频"), verbatim — trimming and
   *  the empty-name fallback are the subscriber's job. */
  title: string
}

const SCENARIO_SESSION_EVENT = 'hermes:scenario-session-request'

export const requestScenarioSession = (title: string): void => {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent<ScenarioSessionRequest>(SCENARIO_SESSION_EVENT, { detail: { title } }))
}

export const onScenarioSessionRequest = (handler: (title: string) => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ScenarioSessionRequest>).detail

    if (detail) {
      handler(detail.title)
    }
  }

  window.addEventListener(SCENARIO_SESSION_EVENT, listener)

  return () => window.removeEventListener(SCENARIO_SESSION_EVENT, listener)
}
