import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $authState } from '@/store/auth'
import { $modelChoiceHidden } from '@/store/model-choice'
import { userFacingModelName, useUserFacingModelName } from '@/store/model-tiers'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

function auth(enabled: boolean, status: 'expired' | 'signed-in' | 'signed-out', modelTiers = false) {
  $authState.set({ ...$authState.get(), enabled, gateReason: null, modelTierMax: false, modelTiers, status })
}

afterEach(() => {
  $singleThreadFlag.set(false)
  setToolViewMode('product')
  auth(false, 'signed-out')
})

describe('model choice on chat surfaces', () => {
  it.each([
    // [switch, managed, status, tier mode] → hidden
    [true, true, 'signed-in', false, true],
    [true, true, 'expired', false, true],
    [true, true, 'signed-out', false, false],
    [true, false, 'signed-out', false, false],
    [false, true, 'signed-in', false, false],
    // hc-960 tier mode hides it whatever the switch says.
    [false, true, 'signed-in', true, true],
    [true, true, 'signed-in', true, true]
  ] as const)('switch %s, managed %s, %s, tiers %s → hidden %s', (on, managed, status, tiers, hidden) => {
    $singleThreadFlag.set(on)
    auth(managed, status, tiers)

    expect($modelChoiceHidden.get()).toBe(hidden)
  })

  it('stays visible in developer mode with the switch on (tiers off)', () => {
    $singleThreadFlag.set(true)
    auth(true, 'signed-in')
    setToolViewMode('technical')

    expect($modelChoiceHidden.get()).toBe(false)
  })
})

describe('model names on display-only surfaces (subagent rows, session cards)', () => {
  it('names the model with the switch off, and in tier mode the tier', () => {
    auth(true, 'signed-in')
    expect(userFacingModelName('apex-flash', 'custom')).toBe('APEX Flash')

    auth(true, 'signed-in', true)
    expect(userFacingModelName('apex-flash', 'custom')).toBe('Flash')
  })

  it('names nothing in single-thread mode on an APEX account, tiers on or off', () => {
    $singleThreadFlag.set(true)
    auth(true, 'signed-in')
    expect(userFacingModelName('apex-flash', 'custom')).toBe('')

    auth(true, 'signed-in', true)
    expect(userFacingModelName('apex-pro', 'custom')).toBe('')

    const { result } = renderHook(() => useUserFacingModelName())

    expect(result.current('apex-pro', 'custom')).toBe('')
  })

  it('still names the user’s own model', () => {
    $singleThreadFlag.set(true)
    auth(false, 'signed-out')

    expect(userFacingModelName('deepseek-chat', 'deepseek')).not.toBe('')

    const { result } = renderHook(() => useUserFacingModelName())

    expect(result.current('deepseek-chat', 'deepseek')).not.toBe('')
  })
})
