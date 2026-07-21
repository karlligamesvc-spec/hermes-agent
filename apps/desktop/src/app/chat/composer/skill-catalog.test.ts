import { describe, expect, it } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import {
  disabledCategoryCounts,
  disabledSkills,
  enabledSkills,
  filterDisabledSkills,
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

describe('disabledCategoryCounts', () => {
  it('counts only disabled skills per category, sorted by key', () => {
    // enabled zeta(social)/mango(office) excluded; disabled: alpha(office),
    // beta(social), gamma(''→general).
    expect(disabledCategoryCounts(CATALOG)).toEqual([
      { key: 'general', count: 1 },
      { key: 'office', count: 1 },
      { key: 'social', count: 1 }
    ])
  })

  it('is empty when every skill is enabled', () => {
    expect(disabledCategoryCounts(CATALOG.map(s => ({ ...s, enabled: true })))).toEqual([])
  })
})

describe('filterDisabledSkills', () => {
  it('returns every disabled skill with no query or category', () => {
    expect(filterDisabledSkills(CATALOG, '', null, false).map(s => s.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('never surfaces an enabled skill even when it matches the query', () => {
    // "mango" is enabled — a query for it yields nothing from the unused list.
    expect(filterDisabledSkills(CATALOG, 'mango', null, false)).toEqual([])
  })

  it('scopes to a category among disabled skills', () => {
    expect(filterDisabledSkills(CATALOG, '', 'office', false).map(s => s.name)).toEqual(['alpha'])
    expect(filterDisabledSkills(CATALOG, '', 'social', false).map(s => s.name)).toEqual(['beta'])
  })

  it('matches on name, description, or category', () => {
    expect(filterDisabledSkills(CATALOG, 'beta', null, false).map(s => s.name)).toEqual(['beta'])
    expect(filterDisabledSkills(CATALOG, 'alpha things', null, false).map(s => s.name)).toEqual(['alpha'])
    expect(filterDisabledSkills(CATALOG, 'social', null, false).map(s => s.name)).toEqual(['beta'])
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
