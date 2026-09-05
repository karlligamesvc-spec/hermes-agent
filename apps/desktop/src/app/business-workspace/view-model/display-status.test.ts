import { describe, expect, it } from 'vitest'

import { businessStatusPresentation, businessStatusToneClass } from './display-status'

describe('hc-806 business object display status', () => {
  it.each([
    ['project', 'completed', 'success'],
    ['workflow', 'published', 'success'],
    ['run', 'waiting_review', 'attention'],
    ['deliverable', 'changes_requested', 'attention'],
    ['activity', 'failed', 'danger']
  ] as const)('maps %s %s through the shared semantic table', (object, status, tone) => {
    expect(businessStatusPresentation(object, status).tone).toBe(tone)
  })

  it('keeps only queued and running Runs pollable and cancellable', () => {
    expect(businessStatusPresentation('run', 'queued')).toMatchObject({ active: true, canCancel: true, poll: true })
    expect(businessStatusPresentation('run', 'running')).toMatchObject({ active: true, canCancel: true, poll: true })
    expect(businessStatusPresentation('run', 'waiting_review')).toMatchObject({
      active: true,
      canCancel: false,
      poll: false
    })
    expect(businessStatusPresentation('run', 'succeeded')).toMatchObject({
      active: false,
      canCancel: false,
      poll: false,
      terminal: true
    })
  })

  it('normalizes backend casing and degrades unknown or missing states honestly', () => {
    expect(businessStatusPresentation('deliverable', ' APPROVED ')).toMatchObject({ canonical: 'approved', tone: 'success' })
    expect(businessStatusPresentation('activity', 'new-server-state')).toMatchObject({
      active: false,
      canonical: 'new-server-state',
      terminal: false,
      tone: 'muted'
    })
    expect(businessStatusPresentation('project', null).canonical).toBe('unknown')
    expect(businessStatusToneClass('muted')).toBe('text-(--ui-text-tertiary)')
  })
})
