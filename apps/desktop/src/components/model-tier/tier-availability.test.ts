import { describe, expect, it } from 'vitest'

import { MANAGED_PROVIDER_SLUG } from '@/lib/provider-allowlist'

import { type ModelTierAvailability, modelTierAvailabilityFromProviders, modelTierCardState } from './tier-availability'

const ready = (...tiers: ('flash' | 'max' | 'pro')[]): ModelTierAvailability => ({
  status: 'ready',
  tiers: new Set(tiers)
})

const managed = (models: string[]) => ({ models, name: 'Apex-nodes.com', slug: MANAGED_PROVIDER_SLUG })

describe('which tiers the account has', () => {
  it('reads the managed relay row, never another provider', () => {
    expect(
      modelTierAvailabilityFromProviders([
        { models: ['apex-pro'], name: 'Mine', slug: 'custom:my-box' },
        managed(['apex-flash', 'deepseek-flash'])
      ])
    ).toEqual({ status: 'ready', tiers: new Set(['flash']) })
  })

  it('tells "the relay serves no tier yet" apart from "could not read"', () => {
    expect(modelTierAvailabilityFromProviders([managed(['deepseek-flash', 'kimi-k2.7-code'])])).toEqual({
      status: 'not-ready'
    })
    expect(modelTierAvailabilityFromProviders([])).toEqual({ status: 'unknown' })
    expect(modelTierAvailabilityFromProviders(undefined)).toEqual({ status: 'unknown' })
  })
})

// Kael 2026-10-19: free → Flash; fast → Flash + Pro; advanced → all three, with
// Max held back until the platform opens it. The relay's entitled list is the
// plan; the card only says which plan opens a locked tier.
describe('tier cards per plan', () => {
  it.each([
    ['free', ready('flash'), false, ['available', 'locked:fast', 'coming-soon']],
    ['fast', ready('flash', 'pro'), false, ['available', 'available', 'coming-soon']],
    ['advanced, Max not open yet', ready('flash', 'pro'), false, ['available', 'available', 'coming-soon']],
    ['fast, Max open', ready('flash', 'pro'), true, ['available', 'available', 'locked:advanced']],
    ['advanced, Max open', ready('flash', 'pro', 'max'), true, ['available', 'available', 'available']]
  ] as const)('%s', (_plan, availability, maxOpen, expected) => {
    const states = (['flash', 'pro', 'max'] as const).map(tier => {
      const state = modelTierCardState(tier, availability, maxOpen)

      return state.kind === 'locked' ? `locked:${state.plan}` : state.kind
    })

    expect(states).toEqual(expected)
  })

  it.each([
    ['loading', { status: 'loading' }, 'pending'],
    ['unknown', { status: 'unknown' }, 'unavailable'],
    ['not ready', { status: 'not-ready' }, 'unavailable']
  ] as const)('keeps Flash usable and Pro neutral while the list is %s', (_label, availability, pro) => {
    expect(modelTierCardState('flash', availability, true).kind).toBe('available')
    expect(modelTierCardState('pro', availability, true).kind).toBe(pro)
  })
})
