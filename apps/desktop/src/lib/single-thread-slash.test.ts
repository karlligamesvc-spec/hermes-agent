/**
 * hc-1015: in single-thread mode an APEX account is not offered `/moa` (typing
 * it, or `/model`, answers that APEX picks — slash.ts), the same gate as hc-960
 * tier mode. The user's own key keeps it. (`/model` is never in the popover.)
 */
import { afterEach, describe, expect, it } from 'vitest'

import { $authState } from '@/store/auth'
import { $singleThreadFlag } from '@/store/single-thread'

import { isDesktopSlashSuggestion } from './desktop-slash-commands'

function signIn(managed: boolean) {
  $authState.set({
    ...$authState.get(),
    enabled: managed,
    gateReason: null,
    modelTierMax: false,
    modelTiers: false,
    status: managed ? 'signed-in' : 'signed-out'
  })
}

afterEach(() => {
  $singleThreadFlag.set(false)
  signIn(false)
})

describe('model slash commands in single-thread mode', () => {
  it('/moa is offered with the switch off', () => {
    signIn(true)

    expect(isDesktopSlashSuggestion('/moa')).toBe(true)
  })

  it.each(['/model', '/moa'])('%s is not offered to an APEX account with the switch on', command => {
    signIn(true)
    $singleThreadFlag.set(true)

    expect(isDesktopSlashSuggestion(command)).toBe(false)
  })

  it('stays offered on the user’s own key', () => {
    signIn(false)
    $singleThreadFlag.set(true)

    expect(isDesktopSlashSuggestion('/moa')).toBe(true)
  })
})
