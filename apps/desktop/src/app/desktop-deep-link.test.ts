import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'
import { $pendingDesktopLoginCode } from '@/store/onboarding'

const { requestComposerFocus, requestComposerInsert } = vi.hoisted(() => ({
  requestComposerFocus: vi.fn(),
  requestComposerInsert: vi.fn()
}))

vi.mock('./chat/composer/focus', () => ({ requestComposerFocus, requestComposerInsert }))

import { handleDesktopDeepLinkPayload } from './desktop-deep-link'

beforeEach(() => {
  requestComposerFocus.mockReset()
  requestComposerInsert.mockReset()
  $pendingDesktopLoginCode.set(null)
  $authState.set({
    account: { email: '', name: '', plan: '' },
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-out'
  })
})

describe('desktop deep-link renderer handoff', () => {
  it('parks an APEX login code for the real managed sign-in screen', () => {
    handleDesktopDeepLinkPayload({ kind: 'login', name: '', params: { code: '  one-time  ' } })

    expect($pendingDesktopLoginCode.get()).toBe('one-time')
    expect(requestComposerInsert).not.toHaveBeenCalled()
  })

  it('does not turn a login handoff into an account switch', () => {
    $authState.set({
      account: { email: 'kael@apex-nodes.com', name: 'Kael', plan: 'pro' },
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })

    handleDesktopDeepLinkPayload({ kind: 'login', name: '', params: { code: 'ignored' } })

    expect($pendingDesktopLoginCode.get()).toBeNull()
  })

  it('keeps legacy blueprint links reviewable instead of executing them', () => {
    handleDesktopDeepLinkPayload({
      kind: 'blueprint',
      name: 'morning-brief',
      params: { audience: 'product team' }
    })

    expect(requestComposerInsert).toHaveBeenCalledWith('/blueprint morning-brief audience="product team"', {
      mode: 'block',
      target: 'main'
    })
    expect(requestComposerFocus).toHaveBeenCalledWith('main')
  })
})
