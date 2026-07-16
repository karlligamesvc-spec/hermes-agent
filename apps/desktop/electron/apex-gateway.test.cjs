/**
 * Tests for electron/apex-gateway.cjs (hc-417 messaging-gateway lifecycle).
 *
 * Run with: node --test electron/apex-gateway.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * These are the pure decisions behind the fix: the `gateway run` argv builder
 * (the --replace / no---force / --profile contract) and the "is any channel
 * bound?" gate that decides whether the gateway should run at all. The
 * electron-coupled spawn/stop/reconcile lifecycle + credential env injection
 * live in main.cjs; here we lock the deterministic argv + gating logic that the
 * lifecycle is built on.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildGatewayRunArgs, imEntryStoreHasBinding } = require('./apex-gateway.cjs')

test('buildGatewayRunArgs: default (no profile) is `gateway run --replace`', () => {
  assert.deepEqual(buildGatewayRunArgs(), ['gateway', 'run', '--replace'])
  assert.deepEqual(buildGatewayRunArgs(null), ['gateway', 'run', '--replace'])
  assert.deepEqual(buildGatewayRunArgs(undefined), ['gateway', 'run', '--replace'])
})

test('buildGatewayRunArgs: blank / whitespace profile is treated as no profile', () => {
  for (const blank of ['', '   ', '\t', '\n']) {
    assert.deepEqual(
      buildGatewayRunArgs(blank),
      ['gateway', 'run', '--replace'],
      `blank profile ${JSON.stringify(blank)} must not emit --profile`
    )
  }
})

test('buildGatewayRunArgs: a named profile is passed as the global --profile flag before the subcommand', () => {
  assert.deepEqual(buildGatewayRunArgs('work'), ['--profile', 'work', 'gateway', 'run', '--replace'])
  // Trimmed so a stored " work " never leaks whitespace into argv.
  assert.deepEqual(buildGatewayRunArgs('  work  '), ['--profile', 'work', 'gateway', 'run', '--replace'])
})

test('buildGatewayRunArgs: always --replace, NEVER --force (SQLite WAL corruption safety)', () => {
  // --force would let a foreground gateway stack on top of an actively-running
  // supervised service (two dispatchers on one HERMES_HOME → WAL corruption,
  // upstream #35240). The desktop must always defer to a running service, so
  // --force must never appear; --replace (reap a stale foreground PID) always does.
  for (const profile of [undefined, null, '', 'default', 'work']) {
    const args = buildGatewayRunArgs(profile)
    assert.ok(args.includes('--replace'), `--replace missing for profile=${JSON.stringify(profile)}`)
    assert.ok(!args.includes('--force'), `--force must never be emitted (profile=${JSON.stringify(profile)})`)
    // The subcommand is always exactly `gateway run`, in order.
    const runIdx = args.indexOf('run')
    assert.equal(args[runIdx - 1], 'gateway')
  }
})

test('imEntryStoreHasBinding: empty / non-object stores → false', () => {
  assert.equal(imEntryStoreHasBinding(null), false)
  assert.equal(imEntryStoreHasBinding(undefined), false)
  assert.equal(imEntryStoreHasBinding('nope'), false)
  assert.equal(imEntryStoreHasBinding(42), false)
  assert.equal(imEntryStoreHasBinding({}), false)
})

test('imEntryStoreHasBinding: a channel with at least one field value → true', () => {
  assert.equal(
    imEntryStoreHasBinding({ feishu: { channelId: 'feishu', fields: { appId: 'cli_x' }, boundAt: 1 } }),
    true
  )
  assert.equal(
    imEntryStoreHasBinding({ weixin: { channelId: 'weixin', fields: { accountId: 'a', token: 't' }, boundAt: 1 } }),
    true
  )
})

test('imEntryStoreHasBinding: malformed / empty-field entries do NOT keep a ghost gateway alive', () => {
  // A decrypt-blanked record (no fields) or a garbage entry must read as "not
  // bound" so the gateway is stopped rather than run idle against nothing.
  assert.equal(imEntryStoreHasBinding({ feishu: null }), false)
  assert.equal(imEntryStoreHasBinding({ feishu: {} }), false)
  assert.equal(imEntryStoreHasBinding({ feishu: { fields: {} } }), false)
  assert.equal(imEntryStoreHasBinding({ feishu: { fields: null } }), false)
  assert.equal(imEntryStoreHasBinding({ feishu: { fields: 'x' } }), false)
})

test('imEntryStoreHasBinding: true when ANY channel is bound, even beside an empty one', () => {
  assert.equal(
    imEntryStoreHasBinding({
      feishu: { fields: {} },
      weixin: { fields: { accountId: 'a', token: 't' } }
    }),
    true
  )
})
