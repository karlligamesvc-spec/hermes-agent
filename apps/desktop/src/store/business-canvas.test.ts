import { describe, expect, it } from 'vitest'

import { isBusinessCanvasRoute } from './business-workspace'

describe('APEX business canvas shell', () => {
  it.each([
    ['Start', '/'],
    ['Start with query state', '/?draft=market'],
    ['Projects', '/projects'],
    ['Project drawer', '/projects/project%2Falpha'],
    ['Workflows', '/workflows'],
    ['Run drawer', '/workflow-runs/run%2Falpha']
  ])('classifies %s as a business canvas', (_label, path) => {
    expect(isBusinessCanvasRoute(path, true)).toBe(true)
  })

  it.each([
    ['ordinary Session', '/session-123'],
    ['Settings', '/settings'],
    ['Profile', '/profile'],
    ['Sessions history', '/history'],
    ['Bots/Assistant', '/assistant'],
    ['Scheduled runs', '/cron'],
    ['malformed Project drawer', '/projects/project/a'],
    ['malformed Run drawer', '/workflow-runs/run/a']
  ])('does not classify %s as a business canvas', (_label, path) => {
    expect(isBusinessCanvasRoute(path, true)).toBe(false)
  })

  it('keeps every route out of the business painter when the rollback flag is off', () => {
    for (const path of ['/', '/projects', '/projects/project-a', '/workflows', '/workflow-runs/run-a']) {
      expect(isBusinessCanvasRoute(path, false)).toBe(false)
    }
  })
})
