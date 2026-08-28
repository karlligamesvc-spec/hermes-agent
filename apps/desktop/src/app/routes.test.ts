import { describe, expect, it } from 'vitest'

import {
  appViewForPath,
  NEW_CHAT_ROUTE,
  primaryRouteSelectedSessionId,
  routeSessionId,
  sessionRoute,
  SETTINGS_ROUTE,
  taskDetailRoute,
  workflowRunRoute
} from './routes'

const SESS_A = 'sess-a'
const SESS_B = 'sess-b'

describe('taskDetailRoute', () => {
  it('builds an additive encoded task target without changing the bare tasks route', () => {
    expect(taskDetailRoute('job/a b')).toBe('/tasks?task=job%2Fa+b')
  })
})

describe('workflowRunRoute', () => {
  it('keeps a real workflow Run in the workflow navigation domain without masquerading as a chat session', () => {
    const route = workflowRunRoute('run/a b')

    expect(route).toBe('/workflow-runs/run%2Fa%20b')
    expect(appViewForPath(route)).toBe('workflows')
    expect(routeSessionId(route)).toBeNull()
  })
})

describe('primaryRouteSelectedSessionId', () => {
  it('prefers the routed session id over a stale/different store selection (#59305)', () => {
    // The route already committed to B while the store selection hasn't
    // caught up yet (still reads A) — the route wins.
    expect(primaryRouteSelectedSessionId(sessionRoute(SESS_B), SESS_A)).toBe(SESS_B)
  })

  it('returns null on the new-chat route even with a leftover selection from the previous chat', () => {
    expect(primaryRouteSelectedSessionId(NEW_CHAT_ROUTE, SESS_A)).toBeNull()
  })

  it('falls back to the store selection on a non-chat route (settings, overlays)', () => {
    expect(primaryRouteSelectedSessionId(SETTINGS_ROUTE, SESS_A)).toBe(SESS_A)
  })

  it('falls back to the store selection when the route matches the same session', () => {
    expect(primaryRouteSelectedSessionId(sessionRoute(SESS_A), SESS_A)).toBe(SESS_A)
  })

  it('returns null on a non-chat route with no store selection', () => {
    expect(primaryRouteSelectedSessionId(SETTINGS_ROUTE, null)).toBeNull()
  })
})
