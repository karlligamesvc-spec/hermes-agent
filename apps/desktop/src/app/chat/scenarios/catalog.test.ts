import { describe, expect, it } from 'vitest'

import {
  FALLBACK_CATALOG,
  isScenarioPickable,
  menuSections,
  normalizeScenarioCatalog,
  type ScenarioCatalog,
  scenarioIcon,
  type ScenarioItem,
  scenarioMatchesQuery,
  scenarioPrefill,
  shelfSections
} from './catalog'

const item = (over: Partial<ScenarioItem>): ScenarioItem => ({
  key: 'k',
  name: 'name',
  status: 'live',
  param_required: false,
  ...over
})

describe('scenarioPrefill', () => {
  it('uses the mapped 口令 for known catalog keys', () => {
    expect(scenarioPrefill(item({ key: 'trending' }))).toBe('抖音热榜')
    expect(scenarioPrefill(item({ key: 'single_transcribe', param_required: true }))).toBe('拆解这条视频：')
  })

  it('derives from the name for unknown keys — param appends a fullwidth colon', () => {
    expect(scenarioPrefill(item({ key: 'brand_new', name: '新场景', param_required: true }))).toBe('新场景：')
    expect(scenarioPrefill(item({ key: 'brand_new', name: '直出场景', param_required: false }))).toBe('直出场景')
  })
})

describe('scenarioIcon', () => {
  it('falls back to a generic icon for unknown keys', () => {
    // Known + unknown both resolve to a renderable component (never undefined).
    expect(typeof scenarioIcon(item({ key: 'trending' }))).not.toBe('undefined')
    expect(typeof scenarioIcon(item({ key: 'totally_unknown' }))).not.toBe('undefined')
  })
})

describe('isScenarioPickable', () => {
  it('is true only for live scenarios', () => {
    expect(isScenarioPickable(item({ status: 'live' }))).toBe(true)
    expect(isScenarioPickable(item({ status: 'coming_soon' }))).toBe(false)
  })
})

describe('shelfSections', () => {
  it('caps the hero subset to 6 社媒 + 3 电商 and drops uncapped sections', () => {
    const sections = shelfSections(FALLBACK_CATALOG)

    expect(sections.map(s => s.key)).toEqual(['social', 'ecom'])
    expect(sections.find(s => s.key === 'social')?.items).toHaveLength(6)
    expect(sections.find(s => s.key === 'ecom')?.items).toHaveLength(3)
    // '更多' has no cap → excluded from the shelf.
    expect(sections.some(s => s.key === 'more')).toBe(false)
  })

  it('preserves catalog order within a capped section', () => {
    const social = shelfSections(FALLBACK_CATALOG).find(s => s.key === 'social')

    expect(social?.items[0]?.key).toBe('trending')
    expect(social?.items[5]?.key).toBe('imitate_viral')
  })
})

describe('menuSections', () => {
  it('returns every non-empty section (all three of the fallback)', () => {
    expect(menuSections(FALLBACK_CATALOG).map(s => s.key)).toEqual(['social', 'ecom', 'more'])
  })

  it('drops empty sections', () => {
    const catalog: ScenarioCatalog = {
      enabled: true,
      version: 'x',
      sections: [
        { key: 'a', title: 'A', items: [item({ key: 'a1' })] },
        { key: 'b', title: 'B', items: [] }
      ]
    }

    expect(menuSections(catalog).map(s => s.key)).toEqual(['a'])
  })
})

describe('scenarioMatchesQuery', () => {
  it('matches on name and blurb, case-insensitively; empty query matches all', () => {
    const it0 = item({ name: 'Listing·评价', sample_ref: '优化标题/五点/关键词' })

    expect(scenarioMatchesQuery(it0, '')).toBe(true)
    expect(scenarioMatchesQuery(it0, 'listing')).toBe(true)
    expect(scenarioMatchesQuery(it0, '五点')).toBe(true)
    expect(scenarioMatchesQuery(it0, 'nomatch')).toBe(false)
  })
})

describe('normalizeScenarioCatalog', () => {
  it('accepts a well-formed wire payload and coerces item fields', () => {
    const normalized = normalizeScenarioCatalog({
      enabled: true,
      version: 'hc552-v1',
      sections: [
        {
          key: 'social',
          title: '社媒',
          items: [
            { key: 'trending', name: '热榜', status: 'live', param_required: false, number: 1 },
            { key: 'x', name: 'x', status: 'coming_soon', param_required: true, param_prompt: 'p' }
          ]
        }
      ]
    })

    expect(normalized?.sections[0]?.items[0]?.status).toBe('live')
    expect(normalized?.sections[0]?.items[1]?.status).toBe('coming_soon')
    expect(normalized?.sections[0]?.items[1]?.param_prompt).toBe('p')
  })

  it('drops malformed items/sections but keeps the valid remainder', () => {
    const normalized = normalizeScenarioCatalog({
      sections: [
        { key: 's', title: 'S', items: [{ name: 'no-key' }, { key: 'ok', name: 'ok' }] },
        { key: 'bad-no-items' }
      ]
    })

    expect(normalized?.sections).toHaveLength(1)
    expect(normalized?.sections[0]?.items.map(i => i.key)).toEqual(['ok'])
  })

  it('returns null for non-catalog input (→ caller uses the fallback)', () => {
    expect(normalizeScenarioCatalog(null)).toBeNull()
    expect(normalizeScenarioCatalog({})).toBeNull()
    expect(normalizeScenarioCatalog({ sections: 'nope' })).toBeNull()
    expect(normalizeScenarioCatalog({ sections: [] })).toBeNull()
  })

  it('defaults enabled to true unless explicitly false', () => {
    expect(normalizeScenarioCatalog({ sections: [{ key: 's', title: 'S', items: [{ key: 'a', name: 'A' }] }] })?.enabled).toBe(true)
    expect(
      normalizeScenarioCatalog({ enabled: false, sections: [{ key: 's', title: 'S', items: [{ key: 'a', name: 'A' }] }] })?.enabled
    ).toBe(false)
  })
})
