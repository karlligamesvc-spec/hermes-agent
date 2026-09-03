import { describe, expect, it, vi } from 'vitest'

import {
  APEX_PRIMARY_NAVIGATION,
  appViewForPath,
  ASSISTANT_ROUTE,
  closeRouteDrawer,
  DELIVERABLES_ROUTE,
  HISTORY_ROUTE,
  LEGACY_ACCOUNTS_ROUTE,
  NEW_CHAT_ROUTE,
  primaryRouteSelectedSessionId,
  routeDrawerBackgroundLocation,
  routeDrawerNavigationState,
  routeSessionId,
  sessionRoute,
  SETTINGS_ROUTE,
  taskDetailRoute,
  workflowRunIdForPath,
  workflowRunRoute,
  WORKFLOWS_ROUTE
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
    expect(workflowRunIdForPath(route)).toBe('run/a b')
  })

  it('rejects missing, nested, and malformed run ids', () => {
    expect(workflowRunIdForPath('/workflow-runs/')).toBeNull()
    expect(workflowRunIdForPath('/workflow-runs/a/b')).toBeNull()
    expect(workflowRunIdForPath('/workflow-runs/%E0%A4%A')).toBeNull()
  })
})

describe('APEX route contract', () => {
  it('declares the seven user destinations in their fixed product order', () => {
    expect(APEX_PRIMARY_NAVIGATION).toEqual([
      { id: 'start', path: '/' },
      { id: 'projects', path: '/projects' },
      { id: 'workflows', path: '/workflows' },
      { id: 'scheduled-runs', path: '/cron' },
      { id: 'deliverables', path: '/deliverables' },
      { id: 'assistant', path: '/assistant' },
      { id: 'history', path: '/history' }
    ])
  })

  it('classifies canonical pages and reserves the legacy accounts alias from session routing', () => {
    expect(appViewForPath(DELIVERABLES_ROUTE)).toBe('deliverables')
    expect(appViewForPath(ASSISTANT_ROUTE)).toBe('assistant')
    expect(appViewForPath(HISTORY_ROUTE)).toBe('history')
    expect(appViewForPath(LEGACY_ACCOUNTS_ROUTE)).toBe('assistant')
    expect(routeSessionId(LEGACY_ACCOUNTS_ROUTE)).toBeNull()
  })
})

describe('route-driven drawer history', () => {
  it('preserves the exact source location for the background page', () => {
    const state = routeDrawerNavigationState({
      hash: '#current',
      key: 'projects-key',
      pathname: '/projects',
      search: '?status=running',
      state: { scrollTop: 420 }
    })

    expect(routeDrawerBackgroundLocation(state)).toEqual({
      hash: '#current',
      key: 'projects-key',
      pathname: '/projects',
      search: '?status=running',
      state: { scrollTop: 420 }
    })
  })

  it('uses browser Back for an in-app drawer and a replacing default for a cold deep link', () => {
    const navigate = vi.fn()
    const state = routeDrawerNavigationState({ hash: '', pathname: '/projects', search: '' })

    closeRouteDrawer(navigate, state, WORKFLOWS_ROUTE)
    expect(navigate).toHaveBeenCalledWith(-1)

    navigate.mockClear()
    closeRouteDrawer(navigate, null, WORKFLOWS_ROUTE)
    expect(navigate).toHaveBeenCalledWith(WORKFLOWS_ROUTE, { replace: true })
  })

  it('rejects unsafe or nested background locations', () => {
    expect(() => routeDrawerNavigationState({ hash: '', pathname: '//outside.example', search: '' })).toThrowError(
      'Invalid route drawer source'
    )
    expect(() => routeDrawerNavigationState({ hash: '', pathname: '/workflow-runs/other', search: '' })).toThrowError(
      'Invalid route drawer source'
    )
    expect(routeDrawerBackgroundLocation({ routeDrawer: { backgroundLocation: { pathname: '/projects' } } })).toBeNull()
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
