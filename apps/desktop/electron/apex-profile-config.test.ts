import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test, vi } from 'vitest'

import {
  ensurePluginsEnabledYaml,
  ensureProductDefaultsYaml,
  ensureSkillsDisabledYaml,
  resolveApexEndpoints
} from './apex-managed'
import {
  guardProductBlocksInHomes,
  healProductBlocksInHome,
  healProductBlocksYaml,
  persistRelayKeyInHome,
  type ProductBlocksContext
} from './apex-profile-config'
import { DEFAULT_PROFILE, managedProfileHomes } from './apex-profile-homes'
import { auditManagedRelayKeyAnchors, maskRelayKey } from './apex-relay-key-anchors'

const RELAY = 'https://apex-nodes.com/relay/v1'
const OLD_KEY = 'sk-old-rotated-away'
const NEW_KEY = 'sk-new-after-sign-in'
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

// What a named profile cloned from the default looks like after a key rotation:
// both anchors still on the key it was cloned with, blocks the seed carries.
function managedConfig(model: string, key = OLD_KEY) {
  return (
    `model:\n  default: ${model}\n  provider: custom\n  base_url: "${RELAY}"\n  api_key: "${key}"\n` +
    `custom_providers:\n  - name: Apex-nodes.com\n    base_url: "${RELAY}"\n    api_key: "${key}"\n    model: apex-flash\n`
  )
}

const BYOK = 'model:\n  default: deepseek-v4-flash\n  provider: deepseek\n# my own setup, hands off\n'

function context(overrides: Partial<ProductBlocksContext> = {}): ProductBlocksContext {
  return {
    managed: { baseUrl: RELAY, key: NEW_KEY },
    endpoints: resolveApexEndpoints({}),
    env: {},
    entitled: null,
    ...overrides
  }
}

function hermesRoot(profiles: Record<string, string>, rootConfig = managedConfig('apex-flash')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-profile-config-'))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'config.yaml'), rootConfig)

  for (const [name, config] of Object.entries(profiles)) {
    const home = path.join(dir, 'profiles', name)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'SOUL.md'), `# ${name}\n`)
    fs.writeFileSync(path.join(home, 'config.yaml'), config)
  }

  return dir
}

// What the engine's profiles.configure writes for an assistant hc-1078 creates (yaml.safe_dump, block style).
const PRODUCT_PROFILE_YAML =
  'ui_meta:\n  apex:\n    name: "\\u5C0F\\u7EA2\\u4E66\\u6587\\u6848"\n    shape: circle\n    color: \'#E5484D\'\n    origin: product\n' +
  '_ui_meta_revisions:\n  apex: 1\n'

function markProduct(dir: string, ...profiles: string[]) {
  for (const profile of profiles) {
    fs.writeFileSync(path.join(dir, 'profiles', profile, 'profile.yaml'), PRODUCT_PROFILE_YAML)
  }
}

const read = (dir: string, profile: string) =>
  fs.readFileSync(
    profile === DEFAULT_PROFILE ? path.join(dir, 'config.yaml') : path.join(dir, 'profiles', profile, 'config.yaml'),
    'utf8'
  )

function fingerprint(file: string) {
  return {
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    mtimeMs: fs.statSync(file).mtimeMs
  }
}

describe('healProductBlocksYaml', () => {
  test('restores every APEX block a managed config lost, and a second pass is clean', () => {
    const { fixed, next } = healProductBlocksYaml(managedConfig('apex-flash', NEW_KEY), context())

    assert.deepEqual(
      fixed.map(item => item.replace(/\(.*$/, '')),
      [
        'skills.disabled',
        'budget-defaults',
        'product-defaults',
        'web.search_backend',
        'model.disabled_providers',
        'plugins.enabled'
      ]
    )
    assert.equal(ensureSkillsDisabledYaml(next).changed, false)
    assert.equal(ensureProductDefaultsYaml(next).changed, false)
    assert.equal(ensurePluginsEnabledYaml(next).changed, false)
    assert.deepEqual(healProductBlocksYaml(next, context()), { fixed: [], next })
  })

  test('rewrites a stale relay key in every anchor, and re-adds a wiped endpoint entry', () => {
    const stale = healProductBlocksYaml(managedConfig('apex-flash'), context())

    assert.equal(stale.fixed[0], 'managed-key(model custom_providers[0])')
    assert.equal(auditManagedRelayKeyAnchors(stale.next, RELAY, NEW_KEY).clean, true)

    const wiped = healProductBlocksYaml(
      `model:\n  default: apex-flash\n  provider: custom\n  base_url: "${RELAY}"\n  api_key: "${NEW_KEY}"\n`,
      context()
    )

    assert.ok(wiped.fixed.includes('custom_providers'))
    assert.equal(auditManagedRelayKeyAnchors(wiped.next, RELAY, NEW_KEY).holders.length, 2)
  })

  test('signed out: the product blocks still heal, the relay half does not run', () => {
    const { fixed, next } = healProductBlocksYaml(
      managedConfig('deepseek-v4-pro-APEX'),
      context({ managed: {}, env: { APEXNODES_SINGLE_THREAD: '1' } })
    )

    assert.ok(!fixed.some(item => /managed-key|custom_providers|model\((tier|single)/.test(item)), fixed.join(', '))
    assert.match(next, new RegExp(`api_key: "${OLD_KEY}"`))
    assert.match(next, /^ {2}default: deepseek-v4-pro-APEX$/m)
  })

  // hc-1072 in every profile: one account, one relay listing, one rule.
  test.each([
    ['an old id goes to Flash', 'deepseek-v4-pro-APEX', null, 'apex-flash'],
    ['a granted pick stays', 'apex-pro', ['apex-flash', 'apex-pro'], 'apex-pro'],
    [
      'a pick the plan does not grant drops to the strongest it does',
      'apex-max',
      ['apex-flash', 'apex-pro'],
      'apex-pro'
    ],
    ['an unknown listing keeps the pick', 'apex-max', null, 'apex-max']
  ])('single-thread tier: %s', (_label, model, entitled, expected) => {
    const env = { APEXNODES_SINGLE_THREAD: '1', APEX_SINGLE_THREAD_ACTIVE: '1' }

    const { next } = healProductBlocksYaml(
      managedConfig(model as string, NEW_KEY),
      context({ env, entitled: entitled as null | string[] })
    )

    assert.match(next, new RegExp(`^ {2}default: ${expected}$`, 'm'))
  })
})

describe('with several assistants on, the named profiles follow the root (account) tier', () => {
  const ST = { APEXNODES_SINGLE_THREAD: '1', APEX_SINGLE_THREAD_ACTIVE: '1', APEX_MULTI_BOT_ACTIVE: '1' }
  const allTiers = ['apex-flash', 'apex-pro', 'apex-max']

  test('every assistant the product mode created takes the tier the root settles on, whatever it held', () => {
    const dir = hermesRoot(
      {
        writer: managedConfig('apex-flash'),
        editor: managedConfig('deepseek-v4-pro-APEX'),
        maxer: managedConfig('apex-max'),
        mine: BYOK
      },
      managedConfig('apex-pro', NEW_KEY)
    )

    markProduct(dir, 'writer', 'editor', 'maxer', 'mine')

    const lines: string[] = []
    const mine = path.join(dir, 'profiles', 'mine', 'config.yaml')
    const before = fingerprint(mine)

    guardProductBlocksInHomes(
      managedProfileHomes(dir, RELAY),
      context({ env: ST, entitled: allTiers }),
      'watch',
      line => lines.push(line)
    )

    for (const profile of [DEFAULT_PROFILE, 'writer', 'editor', 'maxer']) {
      assert.match(read(dir, profile), /^ {2}default: apex-pro$/m, profile)
    }

    assert.deepEqual(fingerprint(mine), before, 'a BYOK profile has no tier to follow')
    assert.ok(
      lines.some(line => line.includes('model(account:apex-max→pro)') && line.endsWith('(watch; profile maxer)')),
      lines.join('\n')
    )
  })

  // Following goes by where a profile came from, not by the UI mode (the main process cannot see the
  // mode): a tier picked on the hc-960 card in upstream Bot mode or developer mode stays, even with several assistants on.
  test('a profile not created by the product mode keeps settling its own tier, byte for byte', () => {
    const profiles = {
      writer: managedConfig('apex-flash'),
      devbot: managedConfig('apex-max'),
      plain: managedConfig('apex-max'),
      empty: managedConfig('apex-max'),
      broken: managedConfig('apex-max'),
      renamed: managedConfig('apex-max'),
      other: managedConfig('apex-max')
    }

    const dir = hermesRoot(profiles, managedConfig('apex-pro', NEW_KEY))
    markProduct(dir, 'writer')
    fs.writeFileSync(
      path.join(dir, 'profiles', 'devbot', 'profile.yaml'),
      'ui_meta:\n  hermes-bots:\n    rune: spark\n'
    )
    fs.writeFileSync(path.join(dir, 'profiles', 'empty', 'profile.yaml'), 'ui_meta:\n  apex: {}\n')
    fs.writeFileSync(path.join(dir, 'profiles', 'broken', 'profile.yaml'), 'ui_meta: [unclosed\n')
    // A developer-mode bot renamed in chat (hc-1082 writes ui_meta.apex.name), and a foreign origin.
    fs.writeFileSync(path.join(dir, 'profiles', 'renamed', 'profile.yaml'), 'ui_meta:\n  apex:\n    name: X\n')
    fs.writeFileSync(
      path.join(dir, 'profiles', 'other', 'profile.yaml'),
      'ui_meta:\n  apex:\n    name: X\n    origin: developer\n'
    )
    const ctx = context({ env: ST, entitled: allTiers })

    guardProductBlocksInHomes(managedProfileHomes(dir, RELAY), ctx, 'boot', () => undefined)

    assert.match(read(dir, 'writer'), /^ {2}default: apex-pro$/m)

    for (const profile of ['devbot', 'plain', 'empty', 'broken', 'renamed', 'other'] as const) {
      assert.equal(read(dir, profile), healProductBlocksYaml(profiles[profile], ctx).next, profile)
      assert.match(read(dir, profile), /^ {2}default: apex-max$/m, profile)
    }
  })

  test('the root is capped by the plan first, and the profiles follow the capped tier', () => {
    const dir = hermesRoot({ writer: managedConfig('apex-flash') }, managedConfig('apex-max', NEW_KEY))
    markProduct(dir, 'writer')

    guardProductBlocksInHomes(
      managedProfileHomes(dir, RELAY),
      context({ env: ST, entitled: ['apex-flash', 'apex-pro'] }),
      'relay-tiers',
      () => undefined
    )

    assert.match(read(dir, DEFAULT_PROFILE), /^ {2}default: apex-pro$/m)
    assert.match(read(dir, 'writer'), /^ {2}default: apex-pro$/m)
  })

  test('a root on BYOK sets no account tier: each profile settles by the hc-1072 rule on its own', () => {
    const dir = hermesRoot({ writer: managedConfig('apex-max'), editor: managedConfig('deepseek-v4-pro-APEX') }, BYOK)
    markProduct(dir, 'writer', 'editor')

    guardProductBlocksInHomes(
      managedProfileHomes(dir, RELAY),
      context({ env: ST, entitled: allTiers }),
      'boot',
      () => undefined
    )

    assert.match(read(dir, 'writer'), /^ {2}default: apex-max$/m)
    assert.match(read(dir, 'editor'), /^ {2}default: apex-flash$/m)
  })

  test('with tiers and single-thread both off, no profile model is rewritten', () => {
    const dir = hermesRoot({ writer: managedConfig('apex-flash') }, managedConfig('apex-pro', NEW_KEY))
    markProduct(dir, 'writer')

    guardProductBlocksInHomes(managedProfileHomes(dir, RELAY), context(), 'boot', () => undefined)

    assert.match(read(dir, 'writer'), /^ {2}default: apex-flash$/m)
  })

  test('a profile whose main model is its own keeps it, while its relay entry still gets the key', () => {
    const own =
      'model:\n  default: deepseek-v4-flash\n  provider: deepseek\n' +
      managedConfig('apex-flash')
        .split('model: apex-flash\n')[0]
        .slice(managedConfig('apex-flash').indexOf('custom_providers:'))

    const dir = hermesRoot({ writer: own }, managedConfig('apex-pro', NEW_KEY))

    guardProductBlocksInHomes(
      managedProfileHomes(dir, RELAY),
      context({ env: ST, entitled: allTiers }),
      'boot',
      () => undefined
    )

    assert.match(read(dir, 'writer'), /^ {2}default: deepseek-v4-flash$/m)
    assert.equal(auditManagedRelayKeyAnchors(read(dir, 'writer'), RELAY, NEW_KEY).clean, true)
  })
})

// The default, and developer mode (hc-960 lets each bot pick its own tier there): the second pass
// over the named profiles must be exactly the per-profile heal, with no account tier at all.
describe('with several assistants off, every profile keeps settling its own tier', () => {
  const allTiers = ['apex-flash', 'apex-pro', 'apex-max']

  test.each([
    ['single-thread', { APEXNODES_SINGLE_THREAD: '1', APEX_SINGLE_THREAD_ACTIVE: '1' }],
    ['tiers', { APEXNODES_MODEL_TIERS: '1' }],
    ['multi-bot set to anything but 1', { APEX_SINGLE_THREAD_ACTIVE: '1', APEX_MULTI_BOT_ACTIVE: 'true' }]
  ])('%s: each named file is byte for byte the per-profile heal', (_label, env) => {
    const profiles = {
      maxer: managedConfig('apex-max'),
      flasher: managedConfig('apex-flash'),
      editor: managedConfig('deepseek-v4-pro-APEX')
    }

    const dir = hermesRoot(profiles, managedConfig('apex-pro', NEW_KEY))
    const lines: string[] = []
    const ctx = context({ env, entitled: allTiers })

    guardProductBlocksInHomes(managedProfileHomes(dir, RELAY), ctx, 'boot', line => lines.push(line))

    for (const [profile, original] of Object.entries(profiles)) {
      assert.equal(read(dir, profile), healProductBlocksYaml(original, ctx).next, profile)
    }

    assert.match(read(dir, 'maxer'), /^ {2}default: apex-max$/m)
    assert.match(read(dir, 'flasher'), /^ {2}default: apex-flash$/m)
    assert.ok(!lines.some(line => line.includes('model(account:')), lines.join('\n'))
  })
})

describe('every managed profile is kept in step, nothing else is touched', () => {
  test('the guard heals the root and each managed profile; a BYOK profile keeps every byte and its mtime', () => {
    const dir = hermesRoot({
      writer: managedConfig('apex-flash'),
      editor: managedConfig('deepseek-v4-pro-APEX'),
      mine: BYOK
    })

    const mine = path.join(dir, 'profiles', 'mine', 'config.yaml')
    const before = fingerprint(mine)
    const lines: string[] = []
    const homes = managedProfileHomes(dir, RELAY)

    const outcomes = guardProductBlocksInHomes(
      homes,
      context({ env: { APEXNODES_SINGLE_THREAD: '1', APEX_SINGLE_THREAD_ACTIVE: '1' } }),
      'boot',
      line => lines.push(line)
    )

    assert.deepEqual(outcomes, { default: 'healed', writer: 'healed', editor: 'healed' })
    assert.deepEqual(fingerprint(mine), before)

    for (const profile of [DEFAULT_PROFILE, 'writer', 'editor']) {
      assert.equal(auditManagedRelayKeyAnchors(read(dir, profile), RELAY, NEW_KEY).clean, true, profile)
      assert.equal(ensurePluginsEnabledYaml(read(dir, profile)).changed, false, profile)
    }

    assert.match(read(dir, 'editor'), /^ {2}default: apex-flash$/m)
    // The root's log line reads exactly as before; a profile names itself.
    assert.ok(
      lines.some(line => /^\[config-guard\] restored missing block\(s\): managed-key\(.*\) \(boot\)$/.test(line)),
      lines.join('\n')
    )
    assert.ok(
      lines.some(line => line.endsWith('(boot; profile editor)')),
      lines.join('\n')
    )
    assert.deepEqual(
      guardProductBlocksInHomes(homes, context(), 'watch', () => undefined),
      { default: 'clean', writer: 'clean', editor: 'clean' }
    )
  })

  test('a file another writer replaces mid-pass is never overwritten: three recomputes, then deferred', () => {
    const dir = hermesRoot({ writer: managedConfig('apex-flash') })
    const writer = managedProfileHomes(dir, RELAY)[1]
    const original = read(dir, 'writer')
    const realRead = fs.readFileSync
    let reads = 0

    // Every second read (the compare-and-swap check) sees what a racing writer just landed.
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (file === writer.configPath) {
        reads += 1

        return reads % 2 === 0 ? `${original}# the runtime saved settings meanwhile\n` : original
      }

      return realRead(file, options as never)
    }) as typeof fs.readFileSync)

    const lines: string[] = []
    const outcomes = guardProductBlocksInHomes([writer], context(), 'watch', line => lines.push(line))

    vi.restoreAllMocks()
    assert.deepEqual(outcomes, { writer: 'stale' })
    assert.equal(read(dir, 'writer'), original, 'never written over the other writer')
    assert.equal(lines.filter(line => line.startsWith('[config-guard] config.yaml changed mid-pass')).length, 3)
    assert.equal(lines.at(-1), '[config-guard] deferred to the watcher after 3 racing passes (watch; profile writer)')
  })

  test('a profile without config.yaml is absent, and the pass moves on', () => {
    const dir = hermesRoot({ writer: managedConfig('apex-flash') })
    const [rootHome, writer] = managedProfileHomes(dir, RELAY)
    fs.rmSync(writer.configPath)

    assert.equal(
      healProductBlocksInHome(writer, context(), 'boot', () => undefined),
      'absent'
    )
    assert.equal(
      healProductBlocksInHome(rootHome, context(), 'boot', () => undefined),
      'healed'
    )
  })

  test('the relay key lands in every anchor of every managed profile, verified, with one log line each', () => {
    const dir = hermesRoot({ writer: managedConfig('apex-flash'), mine: BYOK })
    const mine = path.join(dir, 'profiles', 'mine', 'config.yaml')
    const before = fingerprint(mine)
    const lines: string[] = []

    const results = managedProfileHomes(dir, RELAY).map(home =>
      persistRelayKeyInHome(home, { baseUrl: RELAY, key: NEW_KEY }, 'managed-runtime-complete', line =>
        lines.push(line)
      )
    )

    assert.deepEqual(
      results.map(result => [result.ok, result.changed]),
      [
        [true, true],
        [true, true]
      ]
    )
    assert.equal(auditManagedRelayKeyAnchors(read(dir, 'writer'), RELAY, NEW_KEY).clean, true)
    assert.deepEqual(fingerprint(mine), before)
    assert.deepEqual(lines, [
      `[apexnodes] config.yaml relay key refreshed (managed-runtime-complete) to ${maskRelayKey(NEW_KEY)} — model:updated custom_providers[0]:updated`,
      `[apexnodes] profile writer config.yaml relay key refreshed (managed-runtime-complete) to ${maskRelayKey(NEW_KEY)} — model:updated custom_providers[0]:updated`
    ])
  })

  test('a profile the writer cannot verify fails loudly on its own, without touching the root result', () => {
    const dir = hermesRoot({ writer: managedConfig('apex-flash') })
    const [rootHome, writer] = managedProfileHomes(dir, RELAY)
    fs.chmodSync(writer.configPath, 0o400)
    const lines: string[] = []

    const rootResult = persistRelayKeyInHome(rootHome, { baseUrl: RELAY, key: NEW_KEY }, 'sync', line =>
      lines.push(line)
    )

    const writerResult = persistRelayKeyInHome(writer, { baseUrl: RELAY, key: NEW_KEY }, 'sync', line =>
      lines.push(line)
    )

    assert.equal(rootResult.ok, true)

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      assert.equal(writerResult.ok, false)
      assert.match(
        lines[1],
        /^\[apexnodes\] profile writer config\.yaml relay key write FAILED \(sync\): config-unwritable/
      )
    }
  })
})
