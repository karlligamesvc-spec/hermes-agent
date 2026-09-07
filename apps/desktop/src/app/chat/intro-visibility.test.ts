import { describe, expect, it } from 'vitest'

import { shouldShowChatComposer, shouldShowIntro } from './intro-visibility'

const showing = {
  activeSessionId: null,
  auxiliaryWindow: false,
  enabled: true,
  freshDraftReady: true,
  messagesEmpty: true,
  primary: true,
  routedSessionView: false,
  selectedSessionId: null
} as const

describe('shouldShowIntro', () => {
  it('shows on a fresh draft in the primary window', () => {
    expect(shouldShowIntro(showing)).toBe(true)
  })

  it('hides when the Appearance toggle is off', () => {
    expect(shouldShowIntro({ ...showing, enabled: false })).toBe(false)
  })

  it('keeps the toggle authoritative over every other clause', () => {
    // Off means off: no window, session, or draft state re-enables the splash.
    const inputs = [
      { ...showing, auxiliaryWindow: true, enabled: false },
      { ...showing, enabled: false, freshDraftReady: false },
      { ...showing, enabled: false, primary: false },
      { ...showing, enabled: false, messagesEmpty: false }
    ]

    for (const input of inputs) {
      expect(shouldShowIntro(input)).toBe(false)
    }
  })

  it('hides on surfaces that are not an empty primary draft', () => {
    expect(shouldShowIntro({ ...showing, primary: false })).toBe(false)
    expect(shouldShowIntro({ ...showing, auxiliaryWindow: true })).toBe(false)
    expect(shouldShowIntro({ ...showing, freshDraftReady: false })).toBe(false)
    expect(shouldShowIntro({ ...showing, routedSessionView: true })).toBe(false)
    expect(shouldShowIntro({ ...showing, selectedSessionId: 'session-1' })).toBe(false)
    expect(shouldShowIntro({ ...showing, activeSessionId: 'session-1' })).toBe(false)
    expect(shouldShowIntro({ ...showing, messagesEmpty: false })).toBe(false)
  })
})

describe('shouldShowChatComposer', () => {
  it('removes the global composer only from the business Start zero-state', () => {
    expect(
      shouldShowChatComposer({ available: true, businessStartVisible: true, objectRouteOpen: false })
    ).toBe(false)
    expect(
      shouldShowChatComposer({ available: true, businessStartVisible: false, objectRouteOpen: false })
    ).toBe(true)
  })

  it('keeps the composer for a Workflow Run opened over Start', () => {
    expect(
      shouldShowChatComposer({ available: true, businessStartVisible: true, objectRouteOpen: true })
    ).toBe(true)
  })

  it('never bypasses the base loading, failure, or watch-window gate', () => {
    expect(
      shouldShowChatComposer({ available: false, businessStartVisible: false, objectRouteOpen: true })
    ).toBe(false)
  })
})
