/**
 * hc-1275: APEX Desktop turns upstream defaults off: the popular-web-designs skill, the catalog
 * toolset (manage_catalog), the consolidated `github` skill and the two red-team skills a terminal
 * command can reinstall (godmode, obliteratus), for a first install (the seed) and for every install
 * after it (the boot/watch heal pass). cli-config.yaml.example, the CLI path's seed, carries the same
 * lists. tests/apex_overlay/test_desktop_disabled_skills.py runs the engine with that list.
 * hc-1294 graded the 11 bundled skills no grade covered: five more names, and six that stay on.
 *
 * Run with: npx vitest run electron/apex-disabled-toolsets.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import yaml from 'js-yaml'
import { test } from 'vitest'

import { ensureToolsetsDisabledYaml, SEED_DISABLED_TOOLSETS } from './apex-disabled-toolsets'
import { resolveApexEndpoints, SEED_DISABLED_SKILLS, SEED_PRODUCT_DEFAULTS_BLOCK, seedSkillsBlockYaml } from './apex-managed'
import { healProductBlocksYaml, type ProductBlocksContext } from './apex-profile-config'

interface Config {
  agent?: { disabled_toolsets?: string[]; max_turns?: number }
  skills?: { disabled?: string[] }
}

const parse = (raw: string) => (yaml.load(raw) ?? {}) as Config

const BYOK: ProductBlocksContext = { managed: {}, endpoints: resolveApexEndpoints({}), env: {}, entitled: null }

// Added after 0.18.2 shipped with the other 51 names: hc-1275's three and hc-1294's five, in list order.
const ADDED_AFTER_0182 = [
  'blocked-page-recovery', 'github', 'weekly-review-planning', 'godmode', 'obliteratus',
  'email-inbox-triage', 'meeting-action-items', 'document-to-action-items'
]

// hc-1294 graded these on. sdlc-review must never be listed: the kanban review lane force-loads it, and a
// listed skill counts as missing there (test_desktop_disabled_skills.py runs that lane's check).
const GRADED_ON_AFTER_0182 = [
  'competitor-news-monitor', 'product-price-monitor', 'grounded-citations', 'microsoft-office', 'pdf', 'sdlc-review'
]

test('popular-web-designs is in the default-off skills, as the seed renders them', () => {
  assert.ok(SEED_DISABLED_SKILLS.includes('popular-web-designs'))
  assert.deepEqual(parse(seedSkillsBlockYaml()).skills?.disabled, [...SEED_DISABLED_SKILLS])
})

test.each(ADDED_AFTER_0182)('%s is in the default-off skills too', name => {
  assert.ok(SEED_DISABLED_SKILLS.includes(name))
})

test.each(GRADED_ON_AFTER_0182)('%s stays out of the default-off skills', name => {
  assert.ok(!SEED_DISABLED_SKILLS.includes(name))
})

test('the five github-* names stay next to github, for homes that still hold their copies', () => {
  for (const name of ['github-auth', 'github-code-review', 'github-issues', 'github-pr-workflow', 'github-repo-management']) {
    assert.ok(SEED_DISABLED_SKILLS.includes(name), name)
  }
})

test('an install seeded with the 0.18.2 list gets exactly the eight new names from the heal pass, once', () => {
  const shipped = SEED_DISABLED_SKILLS.filter(name => !ADDED_AFTER_0182.includes(name))
  const raw = 'model:\n  default: deepseek-v4-flash\n  provider: deepseek\n' + seedSkillsBlockYaml(shipped)
  const { fixed, next } = healProductBlocksYaml(raw, BYOK)

  assert.equal(shipped.length, 51)
  assert.ok(fixed.includes('skills.disabled(+8)'), fixed.join(', '))
  assert.deepEqual(parse(next).skills?.disabled, [...shipped, ...ADDED_AFTER_0182])
  assert.deepEqual(healProductBlocksYaml(next, BYOK).fixed, [])
})

test('cli-config.yaml.example carries the same skills.disabled and agent.disabled_toolsets lists', () => {
  const example = parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'cli-config.yaml.example'), 'utf8'))

  assert.deepEqual(example.skills?.disabled, [...SEED_DISABLED_SKILLS])
  assert.deepEqual(example.agent?.disabled_toolsets, [...SEED_DISABLED_TOOLSETS])
  assert.deepEqual([...SEED_DISABLED_TOOLSETS], ['catalog'])
})

test('a first install is seeded with the catalog toolset off, so the heal has nothing to add', () => {
  assert.deepEqual(parse(SEED_PRODUCT_DEFAULTS_BLOCK).agent?.disabled_toolsets, ['catalog'])
  assert.deepEqual(ensureToolsetsDisabledYaml(SEED_PRODUCT_DEFAULTS_BLOCK), {
    added: [],
    changed: false,
    next: SEED_PRODUCT_DEFAULTS_BLOCK
  })
})

test.each([
  ['an agent block without the list', 'agent:\n  max_turns: 500\nmemory:\n  nudge_interval: 0\n', ['catalog']],
  ['no agent block at all', 'model:\n  default: deepseek-v4-flash\n', ['catalog']],
  ['an empty flow list', 'agent:\n  disabled_toolsets: []\n', ['catalog']],
  ["a user's own entry, which stays first", 'agent:\n  disabled_toolsets:\n  - browser\n', ['browser', 'catalog']]
])('an install upgraded from %s gets catalog added once', (_, raw, expected) => {
  const healed = ensureToolsetsDisabledYaml(raw)

  assert.equal(healed.changed, true)
  assert.deepEqual(healed.added, ['catalog'])
  assert.deepEqual(parse(healed.next).agent?.disabled_toolsets, expected)
  assert.equal(ensureToolsetsDisabledYaml(healed.next).changed, false)
})

test('the add-only heal keeps every other agent setting', () => {
  const healed = ensureToolsetsDisabledYaml('agent:\n  max_turns: 140\n')

  assert.equal(parse(healed.next).agent?.max_turns, 140)
})

test('the boot/watch heal pass puts catalog back in a config that lost it', () => {
  const { fixed, next } = healProductBlocksYaml('model:\n  default: deepseek-v4-flash\n  provider: deepseek\n', BYOK)

  assert.ok(fixed.includes('agent.disabled_toolsets(+1)'), fixed.join(', '))
  assert.deepEqual(parse(next).agent?.disabled_toolsets, ['catalog'])
  assert.deepEqual(healProductBlocksYaml(next, BYOK).fixed, [])
})
