import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import { ensurePluginsEnabledYaml, resolveApexEndpoints } from './apex-managed'
import type { ProductBlocksContext } from './apex-profile-config'
import { healProfileConfig, type ProfileConfigHealDeps, registerProfileConfigIpc } from './apex-profile-config-ipc'
import { managedProfileHomes } from './apex-profile-homes'
import { auditManagedRelayKeyAnchors } from './apex-relay-key-anchors'

const RELAY = 'https://apex-nodes.com/relay/v1'
const OLD_KEY = 'sk-cloned-before-rotation'
const NEW_KEY = 'sk-current'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o700)
    fs.rmSync(root, { force: true, recursive: true })
  }
})

const managedConfig = (key: string) =>
  `model:\n  default: apex-flash\n  provider: custom\n  base_url: "${RELAY}"\n  api_key: "${key}"\n` +
  `custom_providers:\n  - name: Apex-nodes.com\n    base_url: "${RELAY}"\n    api_key: "${key}"\n    model: apex-flash\n`

const BYOK = 'model:\n  default: deepseek-v4-flash\n  provider: deepseek\n'

function hermesRoot(profiles: Record<string, null | string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-profile-config-ipc-'))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'config.yaml'), managedConfig(NEW_KEY))

  for (const [name, config] of Object.entries(profiles)) {
    const home = path.join(dir, 'profiles', name)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'SOUL.md'), `# ${name}\n`)

    if (config !== null) {
      fs.writeFileSync(path.join(home, 'config.yaml'), config)
    }
  }

  return dir
}

function deps(root: string, overrides: Partial<ProfileConfigHealDeps> = {}) {
  const restarts: string[] = []

  const context: ProductBlocksContext = {
    managed: { baseUrl: RELAY, key: NEW_KEY },
    endpoints: resolveApexEndpoints({}),
    env: {},
    entitled: null
  }

  const value: ProfileConfigHealDeps = {
    root,
    homes: managed => managedProfileHomes(root, managed.baseUrl || RELAY),
    context: () => context,
    afterHeal: reason => restarts.push(reason),
    log: () => undefined,
    ...overrides
  }

  return { deps: value, restarts }
}

const fileOf = (root: string, profile: string) => path.join(root, 'profiles', profile, 'config.yaml')
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

describe('healProfileConfig', () => {
  test('a new managed profile on a stale key gets the current key and the APEX blocks at once', () => {
    const root = hermesRoot({ 'apex-bot-2': managedConfig(OLD_KEY) })
    const { deps: d, restarts } = deps(root)

    const result = healProfileConfig('apex-bot-2', d)

    assert.equal(result.ok, true)
    assert.equal(result.profile, 'apex-bot-2')
    assert.equal(result.fixed[0], 'managed-key(model custom_providers[0])')
    assert.ok(result.fixed.some(item => item.startsWith('plugins.enabled')))
    assert.equal(
      auditManagedRelayKeyAnchors(fs.readFileSync(fileOf(root, 'apex-bot-2'), 'utf8'), RELAY, NEW_KEY).clean,
      true
    )
    assert.equal(ensurePluginsEnabledYaml(fs.readFileSync(fileOf(root, 'apex-bot-2'), 'utf8')).changed, false)
    assert.deepEqual(restarts, ['profile-heal'], 'a pooled engine still on the old key restarts')
    assert.deepEqual(healProfileConfig('apex-bot-2', d), { ok: true, profile: 'apex-bot-2', fixed: [] })
    assert.deepEqual(restarts, ['profile-heal'], 'nothing changed, nothing restarts')
  })

  test('a new assistant takes the tier APEX (the root) runs on', () => {
    const root = hermesRoot({
      'apex-bot-2': managedConfig(NEW_KEY).replace('default: apex-flash', 'default: apex-max')
    })

    fs.writeFileSync(
      path.join(root, 'config.yaml'),
      managedConfig(NEW_KEY).replace('default: apex-flash', 'default: apex-pro')
    )
    const base = deps(root).deps.context()!
    const env = { APEX_SINGLE_THREAD_ACTIVE: '1', APEX_MULTI_BOT_ACTIVE: '1' }
    const { deps: d } = deps(root, { context: () => ({ ...base, env }) })
    fs.writeFileSync(
      path.join(root, 'profiles', 'apex-bot-2', 'profile.yaml'),
      'ui_meta:\n  apex:\n    name: X\n    origin: product\n'
    )

    const result = healProfileConfig('apex-bot-2', d)

    assert.equal(result.ok, true)
    assert.ok(result.fixed.includes('model(account:apex-max→pro)'), result.fixed.join(', '))
    assert.match(fs.readFileSync(fileOf(root, 'apex-bot-2'), 'utf8'), /^ {2}default: apex-pro$/m)
    assert.match(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), /^ {2}default: apex-pro$/m)
  })

  test('with several assistants on, a profile the product mode did not create keeps its tier', () => {
    const root = hermesRoot({
      'dev-bot': managedConfig(NEW_KEY).replace('default: apex-flash', 'default: apex-max')
    })

    fs.writeFileSync(
      path.join(root, 'config.yaml'),
      managedConfig(NEW_KEY).replace('default: apex-flash', 'default: apex-pro')
    )
    // Renamed in chat (hc-1082 writes ui_meta.apex.name), never stamped with the product origin.
    fs.writeFileSync(
      path.join(root, 'profiles', 'dev-bot', 'profile.yaml'),
      'ui_meta:\n  hermes-bots:\n    rune: spark\n  apex:\n    name: Y\n'
    )
    const base = deps(root).deps.context()!
    const env = { APEX_SINGLE_THREAD_ACTIVE: '1', APEX_MULTI_BOT_ACTIVE: '1' }

    const result = healProfileConfig('dev-bot', deps(root, { context: () => ({ ...base, env }) }).deps)

    assert.equal(result.ok, true)
    assert.ok(!result.fixed.some(item => item.startsWith('model(')), result.fixed.join(', '))
    assert.match(fs.readFileSync(fileOf(root, 'dev-bot'), 'utf8'), /^ {2}default: apex-max$/m)
  })

  test('with several assistants off, a profile keeps the tier it holds', () => {
    const root = hermesRoot({
      'apex-bot-2': managedConfig(NEW_KEY).replace('default: apex-flash', 'default: apex-max')
    })

    fs.writeFileSync(
      path.join(root, 'config.yaml'),
      managedConfig(NEW_KEY).replace('default: apex-flash', 'default: apex-pro')
    )
    const base = deps(root).deps.context()!
    const { deps: d } = deps(root, { context: () => ({ ...base, env: { APEX_SINGLE_THREAD_ACTIVE: '1' } }) })

    const result = healProfileConfig('apex-bot-2', d)

    assert.equal(result.ok, true)
    assert.ok(!result.fixed.some(item => item.startsWith('model(')), result.fixed.join(', '))
    assert.match(fs.readFileSync(fileOf(root, 'apex-bot-2'), 'utf8'), /^ {2}default: apex-max$/m)
  })

  test("'default' is the root", () => {
    const root = hermesRoot({})
    fs.writeFileSync(path.join(root, 'config.yaml'), managedConfig(OLD_KEY))

    assert.equal(healProfileConfig('default', deps(root).deps).ok, true)
    assert.equal(
      auditManagedRelayKeyAnchors(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), RELAY, NEW_KEY).clean,
      true
    )
  })

  test.each([
    ['a name that is not a listed profile', 'ghost', 'unknown-profile'],
    ['a path outside profiles/', '../..', 'unknown-profile'],
    ['a nested path', 'apex-bot-2/../mine', 'unknown-profile'],
    ['a clone staging dir', '.apex-bot-3.staging-77', 'unknown-profile'],
    ['not a string', 42, 'unknown-profile'],
    ['a profile without config.yaml', 'fresh', 'no-config'],
    ['a profile on its own provider', 'mine', 'not-managed']
  ])('refuses %s and writes nothing', (_label, profile, reason) => {
    const root = hermesRoot({ 'apex-bot-2': managedConfig(OLD_KEY), fresh: null, mine: BYOK })
    fs.mkdirSync(path.join(root, 'profiles', '.apex-bot-3.staging-77'))
    fs.writeFileSync(path.join(root, 'profiles', '.apex-bot-3.staging-77', 'config.yaml'), managedConfig(OLD_KEY))
    const before = ['apex-bot-2', 'mine'].map(name => digest(fileOf(root, name)))
    const { deps: d, restarts } = deps(root)

    const result = healProfileConfig(profile, d)

    assert.equal(result.ok, false)
    assert.equal(result.reason, reason)
    assert.deepEqual(result.fixed, [])
    assert.deepEqual(
      ['apex-bot-2', 'mine'].map(name => digest(fileOf(root, name))),
      before
    )
    assert.equal(fs.existsSync(fileOf(root, 'fresh')), false)
    assert.deepEqual(restarts, [])
  })

  test('waits while a Native model write is unresolved', () => {
    const root = hermesRoot({ 'apex-bot-2': managedConfig(OLD_KEY) })
    const before = digest(fileOf(root, 'apex-bot-2'))

    const result = healProfileConfig('apex-bot-2', deps(root, { context: () => null }).deps)

    assert.deepEqual(result, { ok: false, profile: 'apex-bot-2', reason: 'pending-model-writes', fixed: [] })
    assert.equal(digest(fileOf(root, 'apex-bot-2')), before)
  })

  test('a file it cannot write is reported, not thrown', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }

    const root = hermesRoot({ 'apex-bot-2': managedConfig(OLD_KEY) })
    fs.chmodSync(fileOf(root, 'apex-bot-2'), 0o400)

    const result = healProfileConfig('apex-bot-2', deps(root).deps)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'error')
  })

  test('registers the IPC channel, and the renderer argument reaches the heal as the profile name', async () => {
    const root = hermesRoot({ 'apex-bot-2': managedConfig(OLD_KEY) })
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()

    registerProfileConfigIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, deps(root).deps)

    assert.deepEqual([...handlers.keys()], ['hermes:apex:healProfileConfig'])
    const result: any = await handlers.get('hermes:apex:healProfileConfig')!({}, 'apex-bot-2')
    assert.equal(result.ok, true)
    assert.equal(result.profile, 'apex-bot-2')
  })
})
