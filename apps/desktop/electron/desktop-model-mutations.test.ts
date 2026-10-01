import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildSync } from 'esbuild'
import { afterEach, test, vi } from 'vitest'

import { signOutManagedDevice } from './desktop-device-key'
import { managedRuntimeNeedsRepair } from './desktop-legacy-managed'
import {
  commitRotatedManagedCredential, completeManagedModelAssignment, DesktopModelMutationCoordinator,
  isModelConfigurationMutation, legacyModelMutationSettled, legacyTransportFingerprint, ManagedAuthIntent, ManagedModelReceiptRegistry, modelMutationCapability, modelMutationConfirmation, ModelMutationMetadataStore, modelMutationNoWriteResult, modelMutationRequestProfile,
  prepareManagedModelMutation, type ResolvedModelTarget
} from './desktop-model-mutations'

const AUTHORITY = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const OTHER_TARGET = '33333333-3333-4333-8333-333333333333'
const SCOPE = { connectionId: 'local', profile: 'default' }
const directories: string[] = []

test('mutation target profile follows the real body, query and captured routing precedence with canonical aliases', () => {
  assert.equal(modelMutationRequestProfile({ body: { profile: ' BODY-A ' }, path: '/api/env?profile=query-b', profile: 'route-c' }, 'ambient-d'), 'body-a')
  assert.equal(modelMutationRequestProfile({ path: '/api/env?profile=QUERY-B', profile: 'route-c' }, 'ambient-d'), 'query-b')
  assert.equal(modelMutationRequestProfile({ profile: 'route-c' }, 'ambient-d'), 'route-c')
  assert.equal(modelMutationRequestProfile({}, null), 'default')
  assert.equal(modelMutationRequestProfile({ profile: 'Default' }, 'ambient-d'), 'default')
})

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hc903-native-mutation-'))
  directories.push(directory)
  const file = path.join(directory, 'metadata.json')

  return { directory, file, metadata: new ModelMutationMetadataStore(file, () => AUTHORITY) }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })

  return { promise, resolve, reject }
}

function target(overrides: Partial<ResolvedModelTarget> = {}): ResolvedModelTarget {
  return { scope: SCOPE, targetId: TARGET, transportIdentity: 'http://fixture.invalid',
    request: async () => {throw new Error('unexpected HTTP request')}, ...overrides }
}

afterEach(() => {for (const directory of directories.splice(0)) {fs.rmSync(directory, { recursive: true, force: true })}})

test('healthy Native key recovery inspects the captured main and catalog consumers including env pointers', async () => {
  const assignment = { scope: 'main', provider: 'custom', model: 'owner-b',
    base_url: 'https://fixture.invalid/relay/v1', api_key: 'hc903-fixture-b' }

  const model = { provider: 'custom', base_url: assignment.base_url, api_key: assignment.api_key }
  let raw = JSON.stringify({ model, custom_providers: [{ ...model, name: 'custom', api_key: 'hc903-fixture-a' }] })
  let pointerKey = assignment.api_key
  const requests: string[] = []

  const captured = target({ scope: { connectionId: 'remote-a', profile: 'profile-a' }, request: async route => {
    requests.push(route)

    if (route === '/api/config/raw') {return { yaml: raw }}

    if (route === '/api/env/reveal') {return { key: 'HC903_FIXTURE_KEY', value: pointerKey }}
    throw new Error('unexpected mutation')
  } })

  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), true)
  raw = JSON.stringify({ model, custom_providers: [{ ...model, name: 'custom' }] })
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), false)
  raw = JSON.stringify({ model: { provider: 'custom:managed', default: 'owner-a' },
    providers: { 'custom:managed': { api: assignment.base_url, api_key: 'hc903-fixture-a', default_model: 'owner-a' } } })
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), true)
  raw = JSON.stringify({ model: { provider: 'custom:byok', default: 'owner-a' }, providers: {
    'custom:managed': { api: assignment.base_url, api_key: 'hc903-fixture-a' },
    'custom:byok': { url: 'https://byok.invalid/v1', api_key: 'hc903-fixture-byok' } } })
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), false)
  const pointed = { ...model, key_env: 'HC903_FIXTURE_KEY' }
  raw = JSON.stringify({ model: pointed, custom_providers: [{ ...pointed, name: 'custom' }] })
  pointerKey = 'hc903-fixture-a'
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), true)
  pointerKey = assignment.api_key
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), false)
  raw = JSON.stringify({ model: { ...model, base_url: 'https://byok.invalid/v1', key_cmd: 'user-chosen-command' } })
  requests.length = 0
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), false)
  assert.deepEqual(requests, ['/api/config/raw'])
  raw = JSON.stringify({ model, custom_providers: [{ ...model, name: 'custom', key_cmd: 'user-chosen-command' }] })
  await assert.rejects(managedRuntimeNeedsRepair(captured, assignment), /MODEL_RUNTIME_UPDATE_REQUIRED/)
})

test.each(['legacy', 'keyed'])('healthy literal-custom recovery selects only its actual %s catalog identity', async family => {
  const assignment = { scope: 'main', provider: 'custom', model: 'owner-b',
    base_url: 'https://fixture.invalid/relay/v1', api_key: 'hc903-fixture-b' }

  const row = { base_url: assignment.base_url, api_key: 'hc903-fixture-a', default_model: 'owner-a' }
  let name = 'custom'

  const captured = target({ request: async route => {
    assert.equal(route, '/api/config/raw')

    return { yaml: JSON.stringify({ model: { provider: 'custom', default: 'owner-a' },
      ...(family === 'keyed' ? { providers: { [name]: row } } : { custom_providers: [{ name, ...row }] }) }) }
  } })

  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), true)
  name = 'other'
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), false)
})

test.each(['legacy', 'keyed'])('healthy recovery follows the selected %s catalog before a conflicting inline URL', async family => {
  const assignment = { scope: 'main', provider: 'custom', model: 'owner-b',
    base_url: 'https://fixture.invalid/relay/v1', api_key: 'hc903-fixture-b' }

  const other = 'https://byok.invalid/v1'

  const rows = { managed: { base_url: assignment.base_url, api_key: 'hc903-fixture-a' },
    byok: { base_url: other, api_key: 'hc903-fixture-byok' } }

  let selected = 'byok'

  const captured = target({ request: async route => {
    assert.equal(route, '/api/config/raw')

    return { yaml: JSON.stringify({ model: { provider: `custom:${selected}`, default: 'owner-a',
      base_url: selected === 'byok' ? assignment.base_url : other, api_key: 'hc903-fixture-inline' },
    ...(family === 'keyed' ? { providers: rows } : { custom_providers: Object.entries(rows).map(([name, row]) => ({ name, ...row })) }) }) }
  } })

  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), false)
  selected = 'managed'
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment), true)
})

test.each(['', 'auto', 'anthropic', 'openrouter', 'deepseek', 'unknown', 'custom:missing', 'custom'])(
  'healthy recovery does not infer a managed choice from an unproven inline URL for %s', async provider => {
    const assignment = { scope: 'main', provider: 'custom', model: 'owner-b',
      base_url: 'https://fixture.invalid/relay/v1', api_key: 'hc903-fixture-b' }

    const requests: string[] = []

    const captured = target({ request: async route => {
      requests.push(route)

      return { yaml: JSON.stringify({ model: { provider, default: 'owner-a', base_url: assignment.base_url,
        api_key: 'hc903-fixture-a' }, providers: { [provider || 'other']: { api: assignment.base_url,
        api_key: 'hc903-fixture-a', enabled: false } } }) }
    } })

    assert.equal(await managedRuntimeNeedsRepair(captured, assignment), false)
    assert.deepEqual(requests, ['/api/config/raw'])
  })

test('healthy recovery refuses ambiguous selected aliases even when their URLs are the same', async () => {
  const assignment = { scope: 'main', provider: 'custom', model: 'owner-b',
    base_url: 'https://fixture.invalid/relay/v1', api_key: 'hc903-fixture-b' }

  const captured = target({ request: async route => {
    assert.equal(route, '/api/config/raw')

    return { yaml: JSON.stringify({ model: { provider: 'custom:chosen', default: 'owner-a' }, providers: {
      chosen: { api: assignment.base_url, api_key: 'hc903-fixture-a' },
      other: { name: 'chosen', api: assignment.base_url, api_key: 'hc903-fixture-other' } } }) }
  } })

  await assert.rejects(managedRuntimeNeedsRepair(captured, assignment), /MODEL_RUNTIME_UPDATE_REQUIRED/)
})

test('healthy recovery accepts a Native raw endpoint identity only with durable target ownership', async () => {
  const { metadata } = fixture()
  const id = metadata.managedEndpointId()

  const assignment = { scope: 'main', provider: 'custom', model: 'owner-b',
    base_url: 'https://fixture.invalid/relay/v1', api_key: 'hc903-fixture-b' }

  const captured = target({ request: async route => {
    assert.equal(route, '/api/config/raw')

    return { yaml: JSON.stringify({ model: { provider: id, default: 'owner-a' }, providers: {
      [id]: { api: assignment.base_url, api_key: 'hc903-fixture-a' } } }) }
  } })

  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => captured)

  assert.equal(await managedRuntimeNeedsRepair(captured, assignment, coordinator), false)
  metadata.ownLegacyEndpoint(captured, id)
  assert.equal(await managedRuntimeNeedsRepair(captured, assignment, coordinator), true)
  assert.equal(await managedRuntimeNeedsRepair({ ...captured, scope: { ...SCOPE, profile: 'other' } }, assignment, coordinator), false)
  assert.equal(await managedRuntimeNeedsRepair({ ...captured, transportIdentity: 'https://different.invalid' }, assignment, coordinator), false)
})

test('fresh metadata initializes, restarts retain monotonic counter, and deleted established counter fails closed', () => {
  const { file, metadata } = fixture()
  assert.equal(metadata.reserve(SCOPE, TARGET).revision, 1)
  const restarted = new ModelMutationMetadataStore(file, () => AUTHORITY)
  assert.equal(restarted.reserve(SCOPE, TARGET).revision, 2)
  assert.equal(restarted.pending().length, 2)
  const snapshot = restarted.pending()
  snapshot[0].scope.profile = 'edited'
  assert.equal(restarted.pending()[0].scope.profile, 'default')
  fs.unlinkSync(file)
  assert.throws(() => restarted.reserve(SCOPE, TARGET), /MODEL_RUNTIME_UNAVAILABLE/)
  assert.equal(fs.existsSync(file), false)
})

test('metadata flush uses a writable staging handle and publishes the same bytes', () => {
  const { file, metadata } = fixture()
  const open = fs.openSync
  const sync = fs.fsyncSync
  const stagingHandles = new Set<number>()
  let verified = 0

  const opened = vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
    const handle = open(name, flags, mode)

    if (String(name).startsWith(`${file}.`) && String(name).endsWith('.tmp')) {stagingHandles.add(handle)}

    return handle
  })

  const synced = vi.spyOn(fs, 'fsyncSync').mockImplementation(handle => {
    if (stagingHandles.has(handle)) {
      stagingHandles.delete(handle)
      // Restore the actual first JSON byte through this descriptor. A read-only
      // handle rejects this write even on POSIX, which allows read-only fsync.
      assert.equal(fs.writeSync(handle, Buffer.from('{'), 0, 1, 0), 1)
      verified++
    }

    sync(handle)
  })

  try {
    assert.equal(metadata.nextProvisionRevision(), 1)
    assert.equal(verified, 1)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 1)
    assert.equal(new ModelMutationMetadataStore(file, () => AUTHORITY).nextProvisionRevision(), 2)
    assert.equal(verified, 2)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 2)
  } finally {synced.mockRestore(); opened.mockRestore()}
})

test.each(['write', 'fsync'])('failed staging %s keeps the established counter and releases owned temporary files', fault => {
  const { directory, file, metadata } = fixture()
  assert.equal(metadata.nextProvisionRevision(), 1)
  const before = fs.readFileSync(file)
  const open = fs.openSync
  const write = fs.writeFileSync
  const sync = fs.fsyncSync
  const stagingHandles = new Set<number>()
  const failure = Object.assign(new Error(`owned staging ${fault} failure`), { code: 'EIO' })

  const opened = vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
    const handle = open(name, flags, mode)

    if (String(name).startsWith(`${file}.`) && String(name).endsWith('.tmp')) {stagingHandles.add(handle)}

    return handle
  })

  const written = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
    if (fault === 'write' && typeof target === 'number' && stagingHandles.has(target)) {throw failure}
    write(target, data, options)
  })

  const synced = vi.spyOn(fs, 'fsyncSync').mockImplementation(handle => {
    if (fault === 'fsync' && stagingHandles.has(handle)) {throw failure}
    sync(handle)
  })

  try {
    assert.throws(() => metadata.nextProvisionRevision(), error => error === failure)
    assert.deepEqual(fs.readFileSync(file), before)
    assert.deepEqual(fs.readdirSync(directory).sort(), ['metadata.json', 'metadata.json.initialized'])
  } finally {synced.mockRestore(); written.mockRestore(); opened.mockRestore()}

  assert.equal(new ModelMutationMetadataStore(file, () => AUTHORITY).nextProvisionRevision(), 2)
})

test('corrupt or exhausted metadata never resets the published revision or writes a request', () => {
  const { file, metadata } = fixture()
  metadata.reserve(SCOPE, TARGET)

  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    value.pending = []
    value.revision = revision
    fs.writeFileSync(file, JSON.stringify(value))
    const before = fs.readFileSync(file)
    assert.throws(() => metadata.reserve(SCOPE, TARGET), /MODEL_RUNTIME_UNAVAILABLE/)
    assert.deepEqual(fs.readFileSync(file), before)
  }

  fs.writeFileSync(file, '{broken-json')
  assert.throws(() => metadata.pending())
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken-json')
})

test('two real Native processes publish distinct revisions under the same installation authority', async () => {
  const { file, directory } = fixture()
  const script = path.join(directory, 'publisher.mjs')
  buildSync({ stdin: { contents: `import {ModelMutationMetadataStore} from ${JSON.stringify(path.resolve(__dirname, 'desktop-model-mutations.ts'))};
    process.send('ready'); process.once('message', () => {
      const result = new ModelMutationMetadataStore(process.argv[2], () => process.argv[3]).reserve({connectionId:'local',profile:'default'}, process.argv[4]);
      process.send({revision:result.revision}); process.disconnect();
    });`, resolveDir: __dirname, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: script })
  const processes = [0, 1].map(() => spawn(process.execPath, [script, file, AUTHORITY, TARGET], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))

  const ready = processes.map(child => new Promise<void>((resolve, reject) => {
    child.once('message', message => message === 'ready' ? resolve() : reject(new Error('unexpected ready message')))
    child.once('error', reject)
    child.once('exit', code => {if (code) {reject(new Error(`publisher exited ${code}`))}})
  }))

  await Promise.all(ready)

  const revisions = processes.map(child => new Promise<number>((resolve, reject) => {
    child.once('message', message => resolve((message as { revision: number }).revision))
    child.once('error', reject)
    child.send('publish')
  }))

  assert.deepEqual((await Promise.all(revisions)).sort(), [1, 2])
  await Promise.all(processes.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))))
  const restarted = new ModelMutationMetadataStore(file, () => AUTHORITY)
  assert.equal(restarted.reserve(SCOPE, TARGET).revision, 3)
  assert.equal(JSON.stringify(restarted.pending()).includes('api_key'), false)
})

test('queued stale owner never dispatches, and a rejected request does not strand the next owner', async () => {
  const { metadata } = fixture()
  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => target())
  const intent = new ManagedAuthIntent()
  const a = intent.begin()
  const barrier = deferred()
  const entered = deferred()
  const first = coordinator.run(target(), a, async () => {entered.resolve(); await barrier.promise; throw new Error('response lost')})
  const firstFailure = assert.rejects(first, /response lost/)
  await entered.promise
  let oldDispatches = 0
  const queued = coordinator.run(target(), a, async () => {oldDispatches++})
  const queuedFailure = assert.rejects(queued, /MODEL_MUTATION_SUPERSEDED/)
  const b = intent.begin()

  const newest = coordinator.run(target(), b, async headers => ({ value: headers['X-Apex-Model-Revision'],
    model_mutation: { target_id: TARGET, revision: Number(headers['X-Apex-Model-Revision']) } }))

  barrier.resolve()
  await Promise.all([firstFailure, queuedFailure])
  assert.equal((await newest).value, '2')
  assert.equal(oldDispatches, 0)
  assert.equal(metadata.pending().length, 1)
})

test('pending HTTP outcome survives Native restart and is fenced on its original profile before key rotation', async () => {
  const { file, metadata } = fixture()
  metadata.reserve({ connectionId: 'remote-one', profile: 'profile-a' }, TARGET)
  const scopes: unknown[] = []
  const restarted = new ModelMutationMetadataStore(file, () => AUTHORITY)

  const coordinator = new DesktopModelMutationCoordinator(restarted, async scope => {
    scopes.push(scope)

    return target({ scope, request: async (route, _body, headers) => {
      assert.equal(route, '/api/model/mutation/fence')
      assert.equal(headers['X-Apex-Model-Target'], TARGET)

      return { ok: true, target_id: TARGET, revision: Number(headers['X-Apex-Model-Revision']) }
    } })
  })

  await prepareManagedModelMutation({ coordinator, scope: SCOPE, isCurrent: () => true, requiresRevision: true })
  assert.deepEqual(scopes, [SCOPE, { connectionId: 'remote-one', profile: 'profile-a' }])
  assert.equal(restarted.pending().length, 0)
})

test('new target or unavailable old connection cannot erase unknown pending writes', async () => {
  for (const resolved of [async () => target({ targetId: OTHER_TARGET }), async () => {throw new Error('old connection offline')}]) {
    const { metadata } = fixture()
    const original = metadata.reserve(SCOPE, TARGET)
    const coordinator = new DesktopModelMutationCoordinator(metadata, resolved)
    await assert.rejects(coordinator.fence(() => true))
    assert.deepEqual(metadata.pending().map(item => item.id), [original.id])
  }
})

test('HTTP 500 and malformed or mismatched acknowledgements retain the old target until a confirmed fence', async () => {
  for (const failure of [async () => {throw Object.assign(new Error('500 worker still active'), { statusCode: 500 })},
    async () => ({ ok: true }), async () => ({ ok: true, model_mutation: { target_id: OTHER_TARGET, revision: 1 } }),
    async () => ({ ok: true, model_mutation: { target_id: TARGET, revision: 999 } })]) {
    const { file, metadata } = fixture()
    const coordinator = new DesktopModelMutationCoordinator(metadata, async () => target())
    await assert.rejects(coordinator.run(target(), () => true, failure))
    assert.equal(metadata.pending()[0].targetId, TARGET)
    const restarted = new ModelMutationMetadataStore(file, () => AUTHORITY)
    let fenced = false

    const recovering = new DesktopModelMutationCoordinator(restarted, async () => target({ request: async (_path, _body, headers) => {
      fenced = true

      return { ok: true, revision: Number(headers['X-Apex-Model-Revision']), target_id: TARGET }
    } }))

    await prepareManagedModelMutation({ coordinator: recovering, scope: SCOPE, isCurrent: () => true, requiresRevision: true })
    assert.equal(fenced, true)
    assert.equal(restarted.pending().length, 0)
  }
})

test('a proven legacy first login stays compatible, but malformed legacy success retains its unknown worker', async () => {
  const { metadata, file } = fixture()
  const assignment = { scope: 'main', provider: 'custom', model: 'fixture-legacy', base_url: 'http://fixture.invalid/v1', api_key: 'hc903-fixture-legacy' }
  const remoteScope = { connectionId: 'remote-proven', profile: 'profile-a' }

  const destination = target({ targetId: null, scope: remoteScope, transportIdentity: 'https://fixture.invalid/proxy?tenant=a',
    transportAuthIdentity: 'hc903-fixture-auth-a', request: async () => ({ ok: true, scope: 'main', provider: 'custom', model: assignment.model, base_url: assignment.base_url }) })

  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => destination)
  const prepared = await prepareManagedModelMutation({ coordinator, scope: remoteScope, isCurrent: () => true, requiresRevision: false })
  await completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
    isCurrent: () => true, assignment, syncLocal: () => {}, finalize: () => {} })
  assert.equal(metadata.pending().length, 0)
  const restarted = new DesktopModelMutationCoordinator(new ModelMutationMetadataStore(file, () => AUTHORITY), async () => destination)
  let provisions = 0
  await prepareManagedModelMutation({ coordinator: restarted, scope: remoteScope, isCurrent: () => true, requiresRevision: true })
  provisions++
  assert.equal(provisions, 1)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).legacySettled[0].provider, 'custom')

  for (const patch of [
    { transportIdentity: 'https://fixture.invalid/other?tenant=a' },
    { transportIdentity: 'https://fixture.invalid/proxy?tenant=b' },
    { transportIdentity: 'https://user-b:hc903-fiction@fixture.invalid/proxy?tenant=a' },
    { transportAuthIdentity: 'hc903-fixture-auth-b' },
    { scope: { ...remoteScope, profile: 'profile-b' } },
    { scope: { ...remoteScope, connectionId: 'remote-other' } }
  ]) {
    const changed = new DesktopModelMutationCoordinator(metadata, async () => ({ ...destination, ...patch }))
    await assert.rejects(prepareManagedModelMutation({ coordinator: changed, scope: patch.scope || remoteScope,
      isCurrent: () => true, requiresRevision: true }).then(() => {provisions++}), /MODEL_RUNTIME_UPDATE_REQUIRED/)
    assert.equal(provisions, 1)
  }

  const persisted = fs.readFileSync(file, 'utf8')
  assert.equal(persisted.includes('fixture.invalid'), false)
  assert.equal(persisted.includes('tenant='), false)
  assert.equal(persisted.includes('hc903-fixture-auth'), false)
  assert.equal(legacyTransportFingerprint({ ...destination, transportIdentity: destination.transportIdentity + '#ignored' }), legacyTransportFingerprint(destination))
  await assert.rejects(coordinator.run(destination, () => true, async () => ({ ok: true })), /MODEL_RUNTIME_UNAVAILABLE/)
  assert.equal(metadata.pending().length, 1)
  await assert.rejects(prepareManagedModelMutation({ coordinator: restarted, scope: remoteScope, isCurrent: () => true, requiresRevision: true }), /MODEL_RUNTIME_UPDATE_REQUIRED/)
  assert.equal(provisions, 1)
})

test('legacy owned worker must actually exit; metadata restart and a healthy new connection are insufficient', async () => {
  const { file, metadata } = fixture()
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise(resolve => child.stdout.once('data', resolve))
  const pending = metadata.reserve(SCOPE, null, child.pid)
  const restarted = new ModelMutationMetadataStore(file, () => AUTHORITY)
  const coordinator = new DesktopModelMutationCoordinator(restarted, async () => target())

  try {
    await assert.rejects(coordinator.fence(() => true), /MODEL_RUNTIME_UPDATE_REQUIRED/)
    assert.equal(restarted.pending()[0].id, pending.id)

    const freshPort = target({ targetId: null, localRuntime: true, legacyOwnedPid: child.pid,
      transportIdentity: 'http://127.0.0.1:9992' })

    let dispatches = 0
    await assert.rejects(coordinator.run(freshPort, () => true, async () => {dispatches++;

 return { ok: true }}), /MODEL_RUNTIME_UPDATE_REQUIRED/)
    assert.equal(dispatches, 0)
    const independentProfile = { ...freshPort, scope: { ...SCOPE, profile: 'independent' }, runtimeProfile: 'independent' }
    await coordinator.run(independentProfile, () => true, async () => {dispatches++;

 return { ok: true }}, result => result.ok)
    assert.equal(dispatches, 1)
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await exited
    await coordinator.fence(() => true)
    assert.equal(restarted.pending().length, 0)
  } finally {if (child.exitCode === null) {child.kill()}}

  const remote = restarted.reserve({ connectionId: 'borrowed-remote', profile: 'default' }, null)
  await assert.rejects(coordinator.fence(() => true), /MODEL_RUNTIME_UPDATE_REQUIRED/)
  assert.equal(restarted.pending()[0].id, remote.id)
})

test('unsafe or unsupported Runtime preflight never sends a rotating cloud provision request', async () => {
  for (const resolve of [async () => target({ targetId: null }), async () => {throw new Error('capability 503')}]) {
    const { metadata, directory } = fixture()
    const credential = path.join(directory, 'managed.json')
    fs.writeFileSync(credential, JSON.stringify({ key: 'hc903-old-fixture-key' }))
    let cloudKey = 'hc903-old-fixture-key'
    let provisions = 0
    const coordinator = new DesktopModelMutationCoordinator(metadata, resolve)

    const signIn = async () => {
      await prepareManagedModelMutation({ coordinator, scope: SCOPE, isCurrent: () => true, requiresRevision: true })
      provisions++
      cloudKey = 'hc903-new-fixture-key'
    }

    await assert.rejects(signIn())
    assert.equal(provisions, 0)
    assert.equal(cloudKey, 'hc903-old-fixture-key')
    assert.equal(JSON.parse(fs.readFileSync(credential, 'utf8')).key, cloudKey)
  }

  assert.throws(() => modelMutationCapability({ version: 2, target_id: TARGET }), /MODEL_RUNTIME_UNAVAILABLE/)
  assert.throws(() => modelMutationCapability({ version: 1, target_id: 'bad' }), /MODEL_RUNTIME_UNAVAILABLE/)
})

test('Native success completes Runtime before renderer ACK and retains its canonical provider identity', async () => {
  const { metadata, directory } = fixture()
  const runtime = path.join(directory, 'runtime.json')
  const credential = path.join(directory, 'managed.json')
  const assignment = { scope: 'main', provider: 'custom', model: 'owner-b', base_url: 'http://fixture.invalid/v1', api_key: 'hc903-fixture-b' }
  let dispatches = 0

  const destination = target({ request: async (_route, body, headers) => {
    dispatches++
    fs.writeFileSync(runtime, JSON.stringify({ ...(body as object), provider: 'custom:apex-fixture' }))

    return { ok: true, provider: 'custom:apex-fixture', model: 'owner-b', base_url: assignment.base_url,
      model_mutation: { target_id: TARGET, revision: Number(headers['X-Apex-Model-Revision']) } }
  } })

  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => destination)
  const receipts = new ManagedModelReceiptRegistry()
  const intent = new ManagedAuthIntent()
  const current = intent.begin()

  const completed = await completeManagedModelAssignment({ coordinator, receipts, target: destination, isCurrent: current,
    assignment, syncLocal: () => {}, finalize: () => fs.writeFileSync(credential, JSON.stringify({ owner: 'b', runtimePending: false })) })

  // No renderer step is needed for either durable write.
  assert.equal(JSON.parse(fs.readFileSync(runtime, 'utf8')).api_key, assignment.api_key)
  assert.equal(JSON.parse(fs.readFileSync(credential, 'utf8')).runtimePending, false)
  assert.equal(completed.modelAssignment.provider, 'custom:apex-fixture')
  receipts.acknowledge(completed.modelReceipt, SCOPE, completed.modelAssignment)
  receipts.acknowledge(completed.modelReceipt, SCOPE, completed.modelAssignment)
  assert.equal(dispatches, 1)
  assert.throws(() => receipts.acknowledge(completed.modelReceipt, SCOPE, assignment), /MODEL_MUTATION_SUPERSEDED/)
  assert.throws(() => receipts.acknowledge(completed.modelReceipt, { ...SCOPE, profile: 'other' }, completed.modelAssignment), /MODEL_MUTATION_SUPERSEDED/)
  intent.begin()
  assert.throws(() => receipts.acknowledge(completed.modelReceipt, SCOPE, completed.modelAssignment), /MODEL_MUTATION_SUPERSEDED/)
})

test('account change during fence never publishes a credential or dispatches model assignment', async () => {
  const { metadata } = fixture()
  metadata.reserve(SCOPE, TARGET)
  const intent = new ManagedAuthIntent()
  const a = intent.begin()
  const barrier = deferred<any>()
  const entered = deferred()

  const destination = target({ request: async (_route, _body, headers) => {entered.resolve(); await barrier.promise;

    return { ok: true, target_id: TARGET, revision: Number(headers['X-Apex-Model-Revision']) } } })

  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => destination)
  const pending = prepareManagedModelMutation({ coordinator, scope: SCOPE, isCurrent: a, requiresRevision: true })
  const failure = assert.rejects(pending, /MODEL_MUTATION_SUPERSEDED/)
  await entered.promise
  intent.begin()
  barrier.resolve(undefined)
  await failure
  assert.equal(metadata.pending().length, 2)
})

test('actual filesystem failure after cloud mint records recovery and cannot become successful login', () => {
  const { metadata, directory } = fixture()
  const blocked = path.join(directory, 'managed.json')
  fs.mkdirSync(blocked)
  fs.writeFileSync(path.join(blocked, 'existing.txt'), 'hc903-old-fixture-key')
  const staging = path.join(directory, 'managed.json.tmp')

  const persist = () => {
    fs.writeFileSync(staging, 'hc903-new-fixture-key')
    fs.renameSync(staging, blocked)

    return 1
  }

  assert.throws(() => commitRotatedManagedCredential(persist, () => metadata.markCredentialRecovery(true)), /MODEL_RUNTIME_UNAVAILABLE/)
  assert.equal(metadata.credentialRecovery(), true)
  assert.equal(fs.readFileSync(path.join(blocked, 'existing.txt'), 'utf8'), 'hc903-old-fixture-key')
  assert.equal(fs.readFileSync(staging, 'utf8'), 'hc903-new-fixture-key')
  fs.rmSync(blocked, { recursive: true })
  assert.equal(commitRotatedManagedCredential(persist, () => {}), 1)
  metadata.markCredentialRecovery(false)
  assert.equal(metadata.credentialRecovery(), false)
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'hc903-new-fixture-key')
})

test('late logout cannot clear newly committed owner; failed local removal remains a retryable failure', async () => {
  const { directory } = fixture()
  const credential = path.join(directory, 'credential.json')
  fs.writeFileSync(credential, 'hc903-fixture-a')
  const intent = new ManagedAuthIntent()
  const a = intent.begin()
  const barrier = deferred()
  const entered = deferred()

  const input = { accessToken: 'hc903-fixture-token-a', deviceInstanceId: AUTHORITY, envKey: '', managedKey: 'hc903-fixture-a',
    isCurrent: a, clearCredential: () => fs.rmSync(credential),
    revoke: async () => {entered.resolve(); await barrier.promise} }

  const pending = signOutManagedDevice(input)
  await entered.promise
  intent.begin()
  fs.writeFileSync(credential, 'hc903-fixture-b')
  barrier.resolve()
  assert.deepEqual(await pending, { ok: false, message: 'MODEL_MUTATION_SUPERSEDED' })
  assert.equal(fs.readFileSync(credential, 'utf8'), 'hc903-fixture-b')
  const b = intent.capture()
  const blocked = path.join(directory, 'blocked')
  fs.mkdirSync(blocked)
  fs.writeFileSync(path.join(blocked, 'credential.json'), 'hc903-fixture-b')
  assert.deepEqual(await signOutManagedDevice({ ...input, isCurrent: b, revoke: async () => {},
    clearCredential: () => fs.rmSync(blocked) }), { ok: false, message: 'SIGN_OUT_CLEAR_FAILED' })
  assert.equal(fs.readFileSync(path.join(blocked, 'credential.json'), 'utf8'), 'hc903-fixture-b')
})


test('exact pricing confirmation stays actionable without claiming a successful mutation', async () => {
  const assignment = { scope: 'main', provider: 'custom', model: 'hc903-priced', base_url: 'https://fixture.invalid/v1' }

  const confirmation = { ok: false, scope: 'main', provider: 'custom', model: assignment.model,
    confirm_required: true, confirm_message: 'hc903 fixture cost confirmation' }

  for (const targetId of [null, TARGET]) {
    const { metadata } = fixture()
    const coordinator = new DesktopModelMutationCoordinator(metadata, async () => target({ targetId }))

    const result = await coordinator.run(target({ targetId }), () => true, async () => confirmation,
      value => legacyModelMutationSettled('/api/model/set', assignment, value),
      value => modelMutationConfirmation('/api/model/set', assignment, value))

    assert.equal(result, confirmation)
    assert.equal(metadata.pending().length, targetId ? 1 : 0)
    assert.equal(coordinator.legacySafe(target({ targetId: null })), false)
  }

  for (const patch of [{ ok: true }, { confirm_required: false }, { scope: 'auxiliary' }, { model: 'other' },
    { provider: '' }, { confirm_message: '' }]) {
    assert.equal(modelMutationConfirmation('/api/model/set', assignment, { ...confirmation, ...patch }), false)
  }

  assert.equal(modelMutationConfirmation('/api/config', assignment, confirmation), false)
})

test('the Native selector covers provider env writers and excludes every read or validation route', () => {
  for (const method of ['PUT', 'DELETE']) {
    assert.equal(isModelConfigurationMutation({ method, path: '/api/env?profile=profile-a' }), true)
    assert.equal(legacyModelMutationSettled('/api/env', { key: 'HC903_FIXTURE_KEY' }, { ok: true }), true)
  }

  for (const path of ['/api/tools/toolsets/vision/model', '/api/tools/toolsets/vision/provider', '/api/tools/toolsets/vision/env']) {
    assert.equal(isModelConfigurationMutation({ method: 'PUT', path }), true)
    assert.equal(isModelConfigurationMutation({ method: 'GET', path }), false)
    assert.equal(isModelConfigurationMutation({ method: 'POST', path }), false)
    assert.equal(legacyModelMutationSettled(path, {}, { ok: true }), true)
  }

  for (const [path, method] of [['/api/env', 'GET'], ['/api/env/reveal', 'POST'], ['/api/env/validate', 'POST'],
    ['/api/providers/custom-endpoints/validate', 'POST'], ['/api/model/set', 'GET']]) {
    assert.equal(isModelConfigurationMutation({ path, method }), false)
  }
})


test('same UUID on another endpoint or authentication namespace cannot fence a captured tagged worker', async () => {
  for (const patch of [{ transportIdentity: 'https://other.invalid/proxy' }, { transportAuthIdentity: 'other-actor' }]) {
    const { metadata } = fixture()
    const original = target({ transportIdentity: 'https://fixture.invalid/proxy', transportAuthIdentity: 'actor-a' })
    metadata.reserve(SCOPE, TARGET, undefined, legacyTransportFingerprint(original))
    let requests = 0

    const coordinator = new DesktopModelMutationCoordinator(metadata, async () => target({ ...original, ...patch,
      request: async () => {requests++;

 return { ok: true }} }))

    await assert.rejects(coordinator.fence(() => true), /MODEL_RUNTIME_UPDATE_REQUIRED/)
    assert.equal(requests, 0)
    assert.equal(metadata.pending().length, 1)
  }
})


test('legacy conflicting command and env bindings or named ID collisions block before any cloud provision', async () => {
  for (const raw of [
    'model:\n  provider: custom\n  base_url: https://fixture.invalid/v1\n  key_cmd: hc903-command\n',
    'providers:\n  custom-fixture:\n    base_url: https://fixture.invalid/v1\n    key_env: HC903_UNKNOWN_KEY\n',
    'providers:\n  apexnodes-desktop-11111111-1111-4111-8111-111111111111:\n    name: unrelated BYOK\n    base_url: https://other.invalid/v1\n',
    'providers:\n  unrelated:\n    api: https://other.invalid/v1\n    key_env: HERMES_CUSTOM_APEXNODES_DESKTOP_11111111_1111_4111_8111_111111111111_API_KEY\n',
    'fallback_model:\n  provider: custom:other\n  base_url: https://other.invalid/v1\n  key_env: HERMES_CUSTOM_APEXNODES_DESKTOP_11111111_1111_4111_8111_111111111111_API_KEY\n',
    'fallback_model:\n  - provider: custom:other\n    base_url: https://other.invalid/v1\n    api_key: ${HERMES_CUSTOM_APEXNODES_DESKTOP_11111111_1111_4111_8111_111111111111_API_KEY}\n',
    'fallback_providers:\n  - provider: custom:other\n    base_url: https://other.invalid/v1\n    api_key_env: HERMES_CUSTOM_APEXNODES_DESKTOP_11111111_1111_4111_8111_111111111111_API_KEY\n'
  ]) {
    const { metadata } = fixture()
    let writes = 0
    let provisions = 0

    const destination = target({ targetId: null, request: async (route, _body, _headers, method) => {
      if (method !== 'GET') {writes++}

      if (route === '/api/config/raw') {return { yaml: raw }}

      return { endpoints: [] }
    } })

    const coordinator = new DesktopModelMutationCoordinator(metadata, async () => destination)
    await assert.rejects(prepareManagedModelMutation({ coordinator, scope: SCOPE, isCurrent: () => true,
      requiresRevision: false, managedBaseUrl: 'https://fixture.invalid/v1' }).then(() => {provisions++}), /MODEL_RUNTIME_UPDATE_REQUIRED/)
    assert.equal(writes, 0)
    assert.equal(provisions, 0)
    assert.equal(metadata.pending().length, 0)
  }
})

test('an unowned nonempty stable endpoint environment key is preserved before Cloud provision', async () => {
  const { metadata } = fixture()
  const key = 'HERMES_CUSTOM_APEXNODES_DESKTOP_11111111_1111_4111_8111_111111111111_API_KEY'
  const calls: string[] = []
  let provisions = 0

  const destination = target({ targetId: null, request: async (route, body, _headers, method) => {
    calls.push(`${method || 'POST'}:${route}`)

    if (route === '/api/config/raw') {return { yaml: 'model:\n  provider: custom\n  base_url: https://fixture.invalid/v1\n' }}

    if (route === '/api/providers/custom-endpoints') {return { endpoints: [] }}

    assert.equal(route, '/api/env/reveal')
    assert.deepEqual(body, { key })

    return { key, value: 'hc903-fixture-unrelated-env' }
  } })

  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => destination)

  await assert.rejects(prepareManagedModelMutation({ coordinator, scope: SCOPE, isCurrent: () => true,
    requiresRevision: false, managedBaseUrl: 'https://fixture.invalid/v1' }).then(() => {provisions++}), /MODEL_RUNTIME_UPDATE_REQUIRED/)
  assert.equal(provisions, 0)
  assert.deepEqual(calls, ['GET:/api/config/raw', 'GET:/api/providers/custom-endpoints', 'POST:/api/env/reveal'])
  assert.equal(metadata.pending().length, 0)
})


test('malformed or non-mapping legacy raw config fails closed without exposing its contents or rotating a key', async () => {
  for (const raw of ['!!unknown hc903-fixture-secret', 'null', '[one, two]', 'broken: [', '42']) {
    const { metadata } = fixture()

    const coordinator = new DesktopModelMutationCoordinator(metadata, async () => target({ targetId: null,
      request: async () => ({ yaml: raw }) }))

    let provisions = 0
    await assert.rejects(prepareManagedModelMutation({ coordinator, scope: SCOPE, isCurrent: () => true,
      requiresRevision: false, managedBaseUrl: 'https://fixture.invalid/v1' }).then(() => {provisions++}), /MODEL_RUNTIME_UNAVAILABLE/)
    assert.equal(provisions, 0)
  }
})

test('independent decoded legacy consumer refuses an unchanged legal key that the patcher and auditor cannot see', async () => {
  const { metadata } = fixture()
  const assignment = { scope: 'main', provider: 'custom', model: 'owner-b', base_url: 'https://fixture.invalid/v1', api_key: 'hc903-fixture-b' }

  const original = 'model:\n  provider: custom:托管/独立\n  base_url: https://fixture.invalid/v1\n  api_key: hc903-fixture-a\n' +
    'providers:\n  托管/独立:\n    api: https://fixture.invalid/v1\n    api_key: hc903-fixture-a\n'

  let raw = original

  const destination = target({ targetId: null, request: async (route, _body, _headers, method) => {
    if (route === '/api/config/raw' && method === 'GET') {return { yaml: raw }}

    if (route === '/api/providers/custom-endpoints') {throw Object.assign(new Error('legacy route absent'), { statusCode: 404 })}

    assert.equal(route, '/api/model/set')
    raw = original.replace('api_key: hc903-fixture-a', 'api_key: hc903-fixture-b')

    return { ...assignment, provider: 'custom:托管/独立', ok: true }
  } })

  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => destination)

  const prepared = await prepareManagedModelMutation({ coordinator, scope: SCOPE, isCurrent: () => true,
    requiresRevision: false, managedBaseUrl: assignment.base_url })

  let finalized = 0

  await assert.rejects(completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
    isCurrent: () => true, assignment, syncLocal: () => {}, finalize: () => {finalized++} }), /MODEL_RUNTIME_UPDATE_REQUIRED/)
  assert.equal(finalized, 0)
  assert.equal(raw, original.replace('api_key: hc903-fixture-a', 'api_key: hc903-fixture-b'))
})


test('precise blank tool env no-op stays successful without settling arbitrary missing acknowledgements', async () => {
  const route = '/api/tools/toolsets/image_gen/env'
  const body = { env: { OPENAI_API_KEY: ' ' } }
  const result = { ok: true, name: 'image_gen', saved: [], skipped: ['OPENAI_API_KEY'], is_set: { OPENAI_API_KEY: false } }
  assert.equal(modelMutationNoWriteResult(route, body, result), true)
  assert.equal(modelMutationNoWriteResult(route, { env: {} }, { ...result, skipped: [] }), true)

  for (const patch of [{ saved: ['OPENAI_API_KEY'] }, { skipped: [] }, { name: 'other' }, { ok: false }, { is_set: { OPENAI_API_KEY: 'bad' } }]) {
    assert.equal(modelMutationNoWriteResult(route, body, { ...result, ...patch }), false)
  }

  assert.equal(modelMutationNoWriteResult(route, { env: { OPENAI_API_KEY: 'hc903-fixture-value' } }, result), false)
  assert.equal(modelMutationNoWriteResult('/api/env', body, result), false)
  const { metadata } = fixture()
  const coordinator = new DesktopModelMutationCoordinator(metadata, async () => target())
  assert.equal(await coordinator.run(target(), () => true, async () => result, () => false,
    value => modelMutationNoWriteResult(route, body, value)), result)
  assert.equal(metadata.pending().length, 1)
})
