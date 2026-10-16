import { describe, expect, it } from 'vitest'

import {
  clampPoolLimits,
  mergePoolLimitsPatch,
  parsePoolLimits,
  POOL_LIMITS_BOUNDS,
  POOL_LIMITS_DEFAULTS,
  POOL_LIMITS_MIN
} from './pool-limits'

describe('parsePoolLimits', () => {
  it('falls back to defaults for null/empty/corrupt input', () => {
    expect(parsePoolLimits(null)).toEqual(POOL_LIMITS_DEFAULTS)
    expect(parsePoolLimits(undefined)).toEqual(POOL_LIMITS_DEFAULTS)
    expect(parsePoolLimits('')).toEqual(POOL_LIMITS_DEFAULTS)
    expect(parsePoolLimits('not json {')).toEqual(POOL_LIMITS_DEFAULTS)
  })

  it('parses a valid persisted blob', () => {
    expect(parsePoolLimits(JSON.stringify({ maxBackends: 11, idleMs: 7_200_000 }))).toEqual({
      maxBackends: 11,
      idleMs: 7_200_000
    })
  })

  it('fills missing keys from defaults', () => {
    expect(parsePoolLimits(JSON.stringify({ maxBackends: 5 }))).toEqual({ ...POOL_LIMITS_DEFAULTS, maxBackends: 5 })
    expect(parsePoolLimits('{}')).toEqual(POOL_LIMITS_DEFAULTS)
  })

  it('ignores non-numeric junk instead of NaN-poisoning the pool', () => {
    expect(parsePoolLimits(JSON.stringify({ maxBackends: 'lots', idleMs: null }))).toEqual(POOL_LIMITS_DEFAULTS)
  })
})

describe('clampPoolLimits', () => {
  it('clamps below the floors', () => {
    expect(clampPoolLimits({ maxBackends: 0 }).maxBackends).toBe(POOL_LIMITS_MIN.maxBackends)
    expect(clampPoolLimits({ idleMs: 100 }).idleMs).toBe(POOL_LIMITS_MIN.idleMs)
  })

  it('clamps absurdly high backend counts', () => {
    expect(clampPoolLimits({ maxBackends: 10_000 }).maxBackends).toBeLessThanOrEqual(64)
  })

  it('clamps idleMs to the shared ceiling (7 days)', () => {
    expect(clampPoolLimits({ idleMs: 999_000_000 }).idleMs).toBe(POOL_LIMITS_BOUNDS.idleMsMax)
  })

  it('floors fractional values', () => {
    expect(clampPoolLimits({ maxBackends: 2.9 }).maxBackends).toBe(2)
  })
})

describe('mergePoolLimitsPatch', () => {
  const current = { maxBackends: 7, idleMs: 3_600_000 }

  // Settings saves one knob per commit; the other must survive (hc-914).
  it.each([
    ['maxBackends only keeps idleMs', { maxBackends: 5 }, { maxBackends: 5, idleMs: 3_600_000 }],
    ['idleMs only keeps maxBackends', { idleMs: 120_000 }, { maxBackends: 7, idleMs: 120_000 }],
    ['both fields', { maxBackends: 2, idleMs: 90_000 }, { maxBackends: 2, idleMs: 90_000 }],
    ['empty patch', {}, current],
    ['null patch', null, current],
    ['non-object patch', 'lots', current],
    ['string number is ignored', { maxBackends: '5' }, current],
    ['NaN is ignored', { maxBackends: Number.NaN }, current],
    ['below floor clamps', { maxBackends: 0, idleMs: 1 }, POOL_LIMITS_MIN],
    ['above ceiling clamps', { maxBackends: 10_000 }, { maxBackends: POOL_LIMITS_BOUNDS.maxBackendsMax, idleMs: 3_600_000 }]
  ])('%s', (_label, patch, expected) => {
    expect(mergePoolLimitsPatch(current, patch)).toEqual(expected)
  })
})
