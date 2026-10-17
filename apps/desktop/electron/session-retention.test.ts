import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { keepSessionHistoryInEveryProfile, writeConfigIfUnchanged } from './session-retention'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function home(configs: Record<string, string | null>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-session-retention-'))
  roots.push(root)

  for (const [name, body] of Object.entries(configs)) {
    const dir = name === 'default' ? root : path.join(root, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })

    if (body !== null) {
      fs.writeFileSync(path.join(dir, 'config.yaml'), body)
    }
  }

  return root
}

const read = (root: string, name: string) =>
  fs.readFileSync(path.join(name === 'default' ? root : path.join(root, 'profiles', name), 'config.yaml'), 'utf8')

test('every local profile keeps its history; a user who opted in stays opted in', () => {
  const root = home({
    default: 'model:\n  default: x\n',
    bot: 'sessions:\n  retention_days: 30\n# a bot profile\n',
    keen: 'sessions:\n  auto_prune: true\n',
    fresh: null
  })

  const logs: string[] = []
  const filled = keepSessionHistoryInEveryProfile(root, line => logs.push(line))

  assert.deepEqual(filled.map(file => path.relative(root, file)).sort(), ['config.yaml', path.join('profiles', 'bot', 'config.yaml')].sort())
  assert.match(read(root, 'default'), /^sessions:\n {2}auto_prune: false$/m)
  // Both keys inside the one sessions block (order inside the block is the writer's business).
  assert.match(read(root, 'bot'), /^sessions:\n(?: {2}\S+: \S+\n)*? {2}auto_prune: false$/m)
  assert.match(read(root, 'bot'), /^sessions:\n(?: {2}\S+: \S+\n)*? {2}retention_days: 30$/m)
  assert.equal((read(root, 'bot').match(/^sessions:$/gm) || []).length, 1)
  assert.match(read(root, 'bot'), /^# a bot profile$/m)
  assert.equal(read(root, 'keen'), 'sessions:\n  auto_prune: true\n')
  assert.ok(!fs.existsSync(path.join(root, 'profiles', 'fresh', 'config.yaml')), 'a profile without a config.yaml is left alone')
  // Only the one key: no other APEX product default is pushed onto a profile.
  assert.doesNotMatch(read(root, 'bot'), /language|approvals|max_turns/)

  assert.equal(logs.length, 2, 'each fill is logged')
  assert.deepEqual(keepSessionHistoryInEveryProfile(root), [], 'a second pass is a no-op')
})

test('a config rewritten after it was read is skipped, and the file mode survives a fill', () => {
  const root = home({ default: 'model:\n  default: x\n', other: 'agent:\n  max_turns: 9\n' })
  const otherPath = path.join(root, 'profiles', 'other', 'config.yaml')
  fs.chmodSync(otherPath, 0o600)

  const filled = keepSessionHistoryInEveryProfile(root, () => {}, (configPath, expected, next) => {
    if (configPath !== otherPath) {
      // Another writer lands between the read and the write.
      fs.writeFileSync(configPath, expected + 'timezone: UTC\n')
    }

    return writeConfigIfUnchanged(configPath, expected, next)
  })

  assert.deepEqual(filled, [otherPath])
  assert.equal(read(root, 'default'), 'model:\n  default: x\ntimezone: UTC\n', 'the concurrent write wins')
  assert.match(read(root, 'other'), /^sessions:\n {2}auto_prune: false$/m)

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(otherPath).mode & 0o777, 0o600)
  }
})

test('every product-guard pass fills all profiles, and the boot pass precedes any backend', () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8')
  const guard = main.slice(main.indexOf('function guardConfigYamlProductBlocks(reason) {'),
    main.indexOf('function healConfigYamlProductBlocks'))
  const boot = main.indexOf("guardConfigYamlProductBlocks('boot')")
  const firstSpawn = main.indexOf('if (!backend.bootstrap) {', boot)

  assert.match(guard, /^ {2}keepSessionHistoryInEveryProfile\(HERMES_HOME, rememberLog\)$/m, 'the guard must fill every profile')
  assert.ok(boot >= 0 && firstSpawn > boot, 'the boot guard pass must run before the backend is resolved and started')
})
