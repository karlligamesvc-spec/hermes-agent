import { describe, expect, it } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import {
  disabledSkills,
  enabledSkills,
  filterSkillsByScope,
  scopedCategoryCounts,
  skillCategory,
  skillCategoryLabel,
  skillMatchesQuery
} from './skill-catalog'

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return { name: 'alpha', description: 'does alpha things', category: 'office', enabled: false, ...overrides }
}

const CATALOG: SkillInfo[] = [
  skill({ name: 'zeta', category: 'social', enabled: true, description: 'zeta capability' }),
  skill({ name: 'alpha', category: 'office', enabled: false, description: 'does alpha things' }),
  skill({ name: 'mango', category: 'office', enabled: true, description: 'mango capability' }),
  skill({ name: 'beta', category: 'social', enabled: false, description: 'beta capability' }),
  skill({ name: 'gamma', category: '', enabled: false, description: 'gamma capability' })
]

describe('skill catalog partitioning', () => {
  it('splits enabled/disabled and sorts each by name', () => {
    expect(enabledSkills(CATALOG).map(s => s.name)).toEqual(['mango', 'zeta'])
    expect(disabledSkills(CATALOG).map(s => s.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('does not mutate the input order', () => {
    const before = CATALOG.map(s => s.name)
    enabledSkills(CATALOG)
    disabledSkills(CATALOG)
    expect(CATALOG.map(s => s.name)).toEqual(before)
  })

  it('falls back to "general" for a blank category', () => {
    expect(skillCategory(skill({ category: '' }))).toBe('general')
    expect(skillCategory(skill({ category: 'office' }))).toBe('office')
  })
})

describe('scopedCategoryCounts', () => {
  it('counts only disabled skills per category, sorted by key, in the "disabled" scope', () => {
    // enabled zeta(social)/mango(office) excluded; disabled: alpha(office),
    // beta(social), gamma(''→general).
    expect(scopedCategoryCounts(CATALOG, 'disabled')).toEqual([
      { key: 'general', count: 1 },
      { key: 'office', count: 1 },
      { key: 'social', count: 1 }
    ])
  })

  it('counts only enabled skills per category, sorted by key, in the "enabled" scope', () => {
    // disabled alpha/beta/gamma excluded; enabled: mango(office), zeta(social).
    expect(scopedCategoryCounts(CATALOG, 'enabled')).toEqual([
      { key: 'office', count: 1 },
      { key: 'social', count: 1 }
    ])
  })

  it('is empty when the scope has nothing in it', () => {
    expect(scopedCategoryCounts(CATALOG.map(s => ({ ...s, enabled: true })), 'disabled')).toEqual([])
    expect(scopedCategoryCounts(CATALOG.map(s => ({ ...s, enabled: false })), 'enabled')).toEqual([])
  })
})

describe('filterSkillsByScope', () => {
  it('returns every disabled skill with no query or category in the "disabled" scope', () => {
    expect(filterSkillsByScope(CATALOG, 'disabled', '', null, false).map(s => s.name)).toEqual([
      'alpha',
      'beta',
      'gamma'
    ])
  })

  it('returns every enabled skill with no query or category in the "enabled" scope', () => {
    expect(filterSkillsByScope(CATALOG, 'enabled', '', null, false).map(s => s.name)).toEqual(['mango', 'zeta'])
  })

  it('never surfaces an enabled skill from the "disabled" scope even when it matches the query', () => {
    // "mango" is enabled — a query for it yields nothing from the disabled scope.
    expect(filterSkillsByScope(CATALOG, 'disabled', 'mango', null, false)).toEqual([])
  })

  it('never surfaces a disabled skill from the "enabled" scope even when it matches the query', () => {
    // "alpha" is disabled — a query for it yields nothing from the enabled scope.
    expect(filterSkillsByScope(CATALOG, 'enabled', 'alpha', null, false)).toEqual([])
  })

  it('scopes to a category within the active scope', () => {
    expect(filterSkillsByScope(CATALOG, 'disabled', '', 'office', false).map(s => s.name)).toEqual(['alpha'])
    expect(filterSkillsByScope(CATALOG, 'disabled', '', 'social', false).map(s => s.name)).toEqual(['beta'])
    expect(filterSkillsByScope(CATALOG, 'enabled', '', 'office', false).map(s => s.name)).toEqual(['mango'])
    expect(filterSkillsByScope(CATALOG, 'enabled', '', 'social', false).map(s => s.name)).toEqual(['zeta'])
  })

  it('matches on name, description, or category', () => {
    expect(filterSkillsByScope(CATALOG, 'disabled', 'beta', null, false).map(s => s.name)).toEqual(['beta'])
    expect(filterSkillsByScope(CATALOG, 'disabled', 'alpha things', null, false).map(s => s.name)).toEqual(['alpha'])
    expect(filterSkillsByScope(CATALOG, 'disabled', 'social', null, false).map(s => s.name)).toEqual(['beta'])
    expect(filterSkillsByScope(CATALOG, 'enabled', 'zeta capability', null, false).map(s => s.name)).toEqual(['zeta'])
  })
})

describe('skillMatchesQuery', () => {
  it.each([
    ['', true],
    ['ALPHA', true],
    ['alpha things', true],
    ['office', true],
    ['nomatch', false]
  ])('query %j → %s', (query, expected) => {
    expect(skillMatchesQuery(skill({ name: 'alpha', description: 'does alpha things', category: 'office' }), query, false)).toBe(
      expected
    )
  })
})

describe('skillCategoryLabel', () => {
  it('title-cases the folder name for English', () => {
    expect(skillCategoryLabel('social_media', 'en')).toBe('Social Media')
    expect(skillCategoryLabel('office', 'en')).toBe('Office')
  })

  it('returns a non-empty label for localized locales', () => {
    expect(skillCategoryLabel('office', 'zh').length).toBeGreaterThan(0)
    expect(skillCategoryLabel('office', 'zh-hant').length).toBeGreaterThan(0)
  })
})
