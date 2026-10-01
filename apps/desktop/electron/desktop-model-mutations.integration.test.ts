import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import yaml from 'js-yaml'
import { test, vi } from 'vitest'

import { persistRelayKeyToConfigYaml } from './apex-managed'
import { managedRuntimeNeedsRepair } from './desktop-legacy-managed'
import {
  completeManagedModelAssignment, DesktopModelMutationCoordinator, ManagedAuthIntent,
  ManagedModelReceiptRegistry, modelMutationCapability, ModelMutationMetadataStore,
  prepareManagedModelMutation, type ResolvedModelTarget
} from './desktop-model-mutations'

// Deliberate separate smoke: this executes the actual Python HTTP consumer.
// The standard Native lane has no obligation to install Python Runtime deps.
const python = process.env.HC903_MODEL_RUNTIME_PYTHON
const run = python ? test : test.skip
const root = path.resolve(__dirname, '../../..')
const AUTHORITY = '11111111-1111-4111-8111-111111111111'
const scope = { connectionId: 'local', profile: 'default' }

function assertIndependentResolver(home: string, directory: string, provider: string, key: string, url: string) {
  const resolved = spawnSync(python!, ['-c', `import json,socket
from hermes_cli.runtime_provider import resolve_runtime_provider
socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('No network in resolver proof'))
r=resolve_runtime_provider(requested=${JSON.stringify(provider)},target_model='owner-b')
print(json.dumps({'key_ok':r['api_key']==${JSON.stringify(key)},'url_ok':r['base_url']==${JSON.stringify(url)}}))`], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: directory,
      HERMES_HOME: home, PYTHONPATH: root, LANG: 'en_US.UTF-8' }
  })

  assert.equal(resolved.status, 0, resolved.stderr)
  assert.deepEqual(JSON.parse(resolved.stdout.trim()), { key_ok: true, url_ok: true })
}

async function server(mode: 'pricing' | 'write' | 'legacy') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hc903-native-real-http-'))
  const home = path.join(directory, 'home')
  const ready = path.join(directory, 'ready.json')
  fs.mkdirSync(home)
  // All credentials are explicit fiction, and there is no real HOME/config.
  fs.writeFileSync(path.join(home, 'config.yaml'), yaml.dump({ model: { provider: 'custom:prior', default: 'prior',
    base_url: mode === 'legacy' ? 'http://127.0.0.1:2/v1' : 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-prior' }, custom_providers: [{ name: 'prior',
    base_url: mode === 'legacy' ? 'http://127.0.0.1:2/v1' : 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-prior', models: ['prior'] }] }))
  const stderr = fs.openSync(path.join(directory, 'server.log'), 'w', 0o600)

  const child = spawn(python!, [path.join(root, 'tests/fixtures/model_mutation_runtime.py'), home, ready, mode], {
    cwd: root, stdio: ['ignore', 'ignore', stderr], env: { PATH: process.env.PATH || '', HOME: directory,
      HERMES_HOME: home, PYTHONPATH: root, PYTHONUNBUFFERED: '1', LANG: 'en_US.UTF-8' }
  })

  fs.closeSync(stderr)

  try {
    await vi.waitFor(() => {
      assert.equal(child.exitCode, null)
      assert.equal(fs.existsSync(ready), true)
      const port = JSON.parse(fs.readFileSync(ready, 'utf8')).port
      assert.equal(Number.isInteger(port) && port > 0 && port < 65536, true)
    }, { timeout: 10_000, interval: 20 })
  } catch (error) {
    child.kill()
    throw error
  }

  const address = `http://127.0.0.1:${JSON.parse(fs.readFileSync(ready, 'utf8')).port}`

  const http = async (route: string, body?: unknown, headers: Record<string, string> = {}, method?: string) => {
    const response = await fetch(address + route, { method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'X-Hermes-Session-Token': 'hc903-fixture-session', 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

    const text = await response.text()

    if (!response.ok) {
      if (response.status === 500) {fs.copyFileSync(path.join(directory, 'server.log'), path.join(os.tmpdir(), 'hc903-native-integration-last500.log'))}

      throw Object.assign(new Error(`fixture HTTP ${response.status}`), { statusCode: response.status })
    }

    return JSON.parse(text)
  }

  const targetId = modelMutationCapability(await http('/api/model/mutation'))

  const target: ResolvedModelTarget = { scope, targetId, localRuntime: true, transportIdentity: address,
    request: (route, body, headers, method) => http(route, body, headers, method) }

  const metadataPath = path.join(directory, 'native-mutations.json')
  const metadata = () => new ModelMutationMetadataStore(metadataPath, () => AUTHORITY)

  const assignment = (owner: 'a' | 'b') => ({ scope: 'main', provider: 'custom', model: `owner-${owner}`,
    base_url: 'http://127.0.0.1:1/v1', api_key: `hc903-fixture-key-${owner}` })

  const readIndependent = () => yaml.load(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')) as any

  const syncLocal = () => {
    const config = path.join(home, 'config.yaml')

    const synced = persistRelayKeyToConfigYaml({ read: () => fs.readFileSync(config, 'utf8'),
      write: value => fs.writeFileSync(config, value), baseUrl: 'http://127.0.0.1:1/v1', key: 'hc903-fixture-key-b' })

    assert.equal(synced.ok, true)
  }

  return { directory, home, child, target, http, metadata, assignment, readIndependent, syncLocal,
    close: async () => {
      try {await http('/__fixture/release', {})} catch { /* Startup failure or already stopped. */ }

      if (child.exitCode === null) {
        const exit = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exit
      }

      fs.rmSync(directory, { recursive: true, force: true })
    } }
}

run('real Native timeout→restart→fence settles B before releasing A pricing and without renderer apply', async () => {
  const fixture = await server('pricing')

  try {
    const intent = new ManagedAuthIntent()
    const currentA = intent.begin()
    const coordinatorA = new DesktopModelMutationCoordinator(fixture.metadata(), async () => fixture.target)
    let timeout!: (error: unknown) => void
    let oldHttp!: Promise<unknown>
    const lostReceipt = new Promise<never>((_resolve, reject) => {timeout = reject})

    const requestA = coordinatorA.run(fixture.target, currentA, headers => {
      oldHttp = fixture.target.request('/api/model/set', fixture.assignment('a'), headers)

      return Promise.race([oldHttp, lostReceipt])
    })

    const failureA = assert.rejects(requestA, /fixture client deadline/)
    await vi.waitFor(async () => assert.equal((await fixture.http('/__fixture/state')).pricing_entered, true))
    const late409 = assert.rejects(oldHttp, error => (error as any).statusCode === 409)
    timeout(new Error('fixture client deadline'))
    await failureA
    assert.equal(fixture.metadata().pending().length, 1)
    const currentB = intent.begin()
    const coordinatorB = new DesktopModelMutationCoordinator(fixture.metadata(), async () => fixture.target)
    const prepared = await prepareManagedModelMutation({ coordinator: coordinatorB, scope, isCurrent: currentB, requiresRevision: true })
    const credential = path.join(fixture.directory, 'native-owner.json')
    await completeManagedModelAssignment({ coordinator: coordinatorB, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: currentB, syncLocal: fixture.syncLocal,
      finalize: () => fs.writeFileSync(credential, JSON.stringify({ owner: 'b', runtimePending: false })) })
    assert.equal((await fixture.http('/__fixture/state')).pricing_entered, true)
    assert.equal(fixture.readIndependent().model.api_key, 'hc903-fixture-key-b')
    assert.equal(JSON.parse(fs.readFileSync(credential, 'utf8')).owner, 'b')
    // A is still held at pricing while B is already durably successful.
    await fixture.http('/__fixture/release', {})
    await late409
    const disk = fixture.readIndependent()
    assert.equal(disk.model.default, 'owner-b')
    assert.equal(disk.model.api_key, 'hc903-fixture-key-b')
    assert.match(disk.model.provider, /^custom:/)
    assert.equal(disk.custom_providers.find((entry: any) => entry.base_url === disk.model.base_url).api_key, 'hc903-fixture-key-b')
    assert.equal(fixture.metadata().pending().length, 0)
  } finally {await fixture.close()}
}, 30_000)

run('real HTTP500 from cancellation retains an active write until B fence drains its actual worker', async () => {
  const fixture = await server('write')

  try {
    const coordinatorA = new DesktopModelMutationCoordinator(fixture.metadata(), async () => fixture.target)

    const requestA = coordinatorA.run(fixture.target, () => true,
      headers => fixture.target.request('/api/model/set', fixture.assignment('a'), headers))

    const failureA = assert.rejects(requestA, error => (error as any).statusCode === 500)
    await vi.waitFor(async () => assert.equal((await fixture.http('/__fixture/state')).write_entered, true))
    await fixture.http('/__fixture/cancel', {})
    await failureA
    assert.equal((await fixture.http('/__fixture/state')).worker_finished, false)
    assert.equal(fixture.metadata().pending().length, 1)
    const coordinatorB = new DesktopModelMutationCoordinator(fixture.metadata(), async () => fixture.target)
    let provisionAllowed = false

    const prepared = prepareManagedModelMutation({ coordinator: coordinatorB, scope, isCurrent: () => true, requiresRevision: true })
      .then(target => {provisionAllowed = true;

 return target})

    await vi.waitFor(async () => assert.equal((await fixture.http('/__fixture/state')).admit_entered, true))
    assert.equal(provisionAllowed, false)
    await fixture.http('/__fixture/release', {})
    const target = await prepared
    assert.equal(provisionAllowed, true)
    assert.equal((await fixture.http('/__fixture/state')).worker_finished, true)
    await completeManagedModelAssignment({ coordinator: coordinatorB, target, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: fixture.syncLocal, finalize: () => {} })
    assert.equal(fixture.readIndependent().model.api_key, 'hc903-fixture-key-b')
    assert.equal(fixture.metadata().pending().length, 0)
  } finally {await fixture.close()}
}, 30_000)


run('real legacy remote login selects its own named endpoint, verifies credentials and survives Native restart', async () => {
  const fixture = await server('legacy')

  try {
    // Deliberately exercise released no-tag consumer behavior even though this
    // isolated server also advertises v1 to other tests. There is no owned PID.
    const target = { ...fixture.target, targetId: null, localRuntime: false }
    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)
    const before = fixture.readIndependent().custom_providers[0]

    const first = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true, requiresRevision: false,
      managedBaseUrl: 'http://127.0.0.1:1/v1' })

    const result = await completeManagedModelAssignment({ coordinator, target: first, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {} })

    assert.match(result.modelAssignment.provider, /^apexnodes-desktop-/)
    assert.deepEqual(fixture.readIndependent().custom_providers[0], before)
    assert.equal(fixture.readIndependent().model.base_url, 'http://127.0.0.1:1/v1')
    const restarted = new DesktopModelMutationCoordinator(fixture.metadata(), async () => ({ ...target }))

    assert.equal(await managedRuntimeNeedsRepair(target,
      { ...fixture.assignment('b'), api_key: 'hc903-fixture-key-c' }, restarted), true)

    const second = await prepareManagedModelMutation({ coordinator: restarted, scope, isCurrent: () => true, requiresRevision: true,
      managedBaseUrl: 'http://127.0.0.1:1/v1' })

    const assignment = { ...fixture.assignment('b'), model: 'owner-c', api_key: 'hc903-fixture-key-c' }

    const completed = await completeManagedModelAssignment({ coordinator: restarted, target: second, receipts: new ManagedModelReceiptRegistry(),
      assignment, isCurrent: () => true, syncLocal: () => {}, finalize: () => {} })

    assert.equal(completed.modelAssignment.provider, result.modelAssignment.provider)
    assert.deepEqual(fixture.readIndependent().custom_providers[0], before)
    assert.equal(fixture.metadata().pending().length, 0)

    // This uses the actual production resolver in a fresh isolated interpreter,
    // independently of Native's YAML patcher and the HTTP response serializer.
    const resolved = spawnSync(python!, ['-c', `import json,socket
from hermes_cli.runtime_provider import resolve_runtime_provider
socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('No network in resolver proof'))
r=resolve_runtime_provider(requested=${JSON.stringify(completed.modelAssignment.provider)},target_model='owner-c')
print(json.dumps({'key_ok':r['api_key']=='hc903-fixture-key-c','url_ok':r['base_url']=='http://127.0.0.1:1/v1'}))`], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: fixture.directory,
        HERMES_HOME: fixture.home, PYTHONPATH: root, LANG: 'en_US.UTF-8' }
    })

    assert.equal(resolved.status, 0, resolved.stderr)
    assert.deepEqual(JSON.parse(resolved.stdout.trim()), { key_ok: true, url_ok: true })
  } finally {await fixture.close()}
}, 30_000)

run('an existing healthy Native key repairs only the captured managed profile and the actual resolver consumes it', async () => {
  const fixture = await server('legacy')

  try {
    const profile = 'managed-profile'
    const profileHome = path.join(fixture.home, 'profiles', profile)
    const byokHome = path.join(fixture.home, 'profiles', 'byok-profile')
    fs.mkdirSync(profileHome, { recursive: true })
    fs.mkdirSync(byokHome, { recursive: true })
    const defaultBefore = fs.readFileSync(path.join(fixture.home, 'config.yaml'))
    fs.writeFileSync(path.join(byokHome, 'config.yaml'), defaultBefore)
    // The selected named provider is the real consumer even when model itself
    // contains neither URL nor key. Merely inspecting model.api_key would miss it.
    fs.writeFileSync(path.join(profileHome, 'config.yaml'), yaml.dump({ model: { provider: 'custom:managed', default: 'owner-a' },
      providers: { 'custom:managed': { api: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', default_model: 'owner-a' } } }))

    const request: ResolvedModelTarget['request'] = (route, body, headers, method) => {
      const url = new URL(route, 'http://fixture.invalid')
      url.searchParams.set('profile', profile)

      return fixture.http(url.pathname + url.search, body, headers, method)
    }

    const target: ResolvedModelTarget = { ...fixture.target, scope: { connectionId: 'local', profile }, runtimeProfile: profile,
      targetId: modelMutationCapability(await request('/api/model/mutation', undefined, {})), request }

    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)
    const assignment = fixture.assignment('b')
    assert.equal(await managedRuntimeNeedsRepair(target, assignment), true)
    const prepared = await prepareManagedModelMutation({ coordinator, scope: target.scope, isCurrent: () => true, requiresRevision: true })

    const completed = await completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment, isCurrent: () => true, syncLocal: () => {}, finalize: () => {} })

    assert.equal(await managedRuntimeNeedsRepair(target, assignment), false)
    assert.deepEqual(fs.readFileSync(path.join(fixture.home, 'config.yaml')), defaultBefore)
    assert.deepEqual(fs.readFileSync(path.join(byokHome, 'config.yaml')), defaultBefore)

    const resolved = spawnSync(python!, ['-c', `import json,socket
from hermes_cli.runtime_provider import resolve_runtime_provider
socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('No network in resolver proof'))
r=resolve_runtime_provider(requested=${JSON.stringify(completed.modelAssignment.provider)},target_model='owner-b')
print(json.dumps({'key_ok':r['api_key']=='hc903-fixture-key-b','url_ok':r['base_url']=='http://127.0.0.1:1/v1'}))`], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: fixture.directory,
        HERMES_HOME: profileHome, PYTHONPATH: root, LANG: 'en_US.UTF-8' }
    })

    assert.equal(resolved.status, 0, resolved.stderr)
    assert.deepEqual(JSON.parse(resolved.stdout.trim()), { key_ok: true, url_ok: true })
    assert.equal(fixture.metadata().pending().length, 0)
  } finally {await fixture.close()}
}, 30_000)

run('released legacy inline recovery normalizes a spaced named catalog before grant and its actual resolver consumes the new key', async () => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')
    const prior = fixture.readIndependent().custom_providers[0]
    fs.writeFileSync(configPath, yaml.dump({ model: { provider: 'custom:managed-endpoint', default: 'owner-a',
      base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a' }, custom_providers: [prior,
      { name: 'Managed endpoint', base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', models: ['owner-a'] }] }))

    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, localRuntime: false,
      request: (route, body, headers, method) => {
        if (route === '/api/providers/custom-endpoints' && method === 'GET') {
          return Promise.reject(Object.assign(new Error('released legacy route absent'), { statusCode: 404 }))
        }

        return fixture.target.request(route, body, headers, method)
      } }

    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)

    const prepared = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
      requiresRevision: false, managedBaseUrl: 'http://127.0.0.1:1/v1' })

    assert.equal(prepared.legacyManagedBinding?.provider, 'custom:managed-endpoint')

    const completed = await completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {} })

    assert.equal(completed.modelAssignment.provider, 'custom:managed-endpoint')
    assert.deepEqual(fixture.readIndependent().custom_providers[0], prior)

    const resolved = spawnSync(python!, ['-c', `import json,socket
from hermes_cli.runtime_provider import resolve_runtime_provider
socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('No network in resolver proof'))
r=resolve_runtime_provider(requested='custom:managed-endpoint',target_model='owner-b')
print(json.dumps({'key_ok':r['api_key']=='hc903-fixture-key-b','url_ok':r['base_url']=='http://127.0.0.1:1/v1'}))`], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: fixture.directory,
        HERMES_HOME: fixture.home, PYTHONPATH: root, LANG: 'en_US.UTF-8' }
    })

    assert.equal(resolved.status, 0, resolved.stderr)
    assert.deepEqual(JSON.parse(resolved.stdout.trim()), { key_ok: true, url_ok: true })
  } finally {await fixture.close()}
}, 30_000)

run.each(['api', 'url', 'base_url'])('released legacy keyed %s endpoint recovers its actual credential without changing a different API target', async field => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')

    const unrelated = { api: 'http://127.0.0.1:2/v1', url: 'http://127.0.0.1:1/v1',
      base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-byok', default_model: 'byok' }

    fs.writeFileSync(configPath, yaml.dump({ model: { provider: 'custom', default: 'owner-a',
      base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a' }, providers: {
      'custom:managed': { [field]: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', default_model: 'owner-a' }, other: unrelated
    } }))

    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, localRuntime: false,
      request: (route, body, headers, method) => {
        if (route === '/api/providers/custom-endpoints' && method === 'GET') {
          return Promise.reject(Object.assign(new Error('released legacy route absent'), { statusCode: 404 }))
        }

        return fixture.target.request(route, body, headers, method)
      } }

    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)

    const prepared = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
      requiresRevision: false, managedBaseUrl: 'http://127.0.0.1:1/v1' })

    assert.equal(prepared.legacyManagedBinding?.provider, 'custom:managed')

    const completed = await completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {} })

    assert.equal(completed.modelAssignment.provider, 'custom:managed')
    assert.deepEqual(fixture.readIndependent().providers.other, unrelated)

    const resolved = spawnSync(python!, ['-c', `import json,socket
from hermes_cli.runtime_provider import resolve_runtime_provider
socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('No network in resolver proof'))
r=resolve_runtime_provider(requested='custom:managed',target_model='owner-b')
b=resolve_runtime_provider(requested='custom:other',target_model='byok')
print(json.dumps({'key_ok':r['api_key']=='hc903-fixture-key-b','url_ok':r['base_url']=='http://127.0.0.1:1/v1',
'byok_key_ok':b['api_key']=='hc903-fixture-byok','byok_url_ok':b['base_url']=='http://127.0.0.1:2/v1'}))`], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: fixture.directory,
        HERMES_HOME: fixture.home, PYTHONPATH: root, LANG: 'en_US.UTF-8' }
    })

    assert.equal(resolved.status, 0, resolved.stderr)
    assert.deepEqual(JSON.parse(resolved.stdout.trim()), { key_ok: true, url_ok: true, byok_key_ok: true, byok_url_ok: true })
  } finally {await fixture.close()}
}, 30_000)

run('released legacy admission rejects an unrelated keyed catalog before provision and preserves its real resolver', async () => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')
    fs.writeFileSync(configPath, yaml.dump({ model: { provider: 'custom', default: 'owner-a',
      base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a' }, providers: {
      other: { api: 'http://127.0.0.1:2/v1', api_key: 'hc903-fixture-byok', default_model: 'byok' }
    } }))
    const before = fs.readFileSync(configPath, 'utf8')

    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, localRuntime: false,
      request: (route, body, headers, method) => {
        if (route === '/api/providers/custom-endpoints' && method === 'GET') {
          return Promise.reject(Object.assign(new Error('released legacy route absent'), { statusCode: 404 }))
        }

        return fixture.target.request(route, body, headers, method)
      } }

    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)
    let provisionCalls = 0

    await assert.rejects(async () => {
      await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
        requiresRevision: false, managedBaseUrl: 'http://127.0.0.1:1/v1' })
      provisionCalls += 1
    }, (error: any) => error.code === 'MODEL_RUNTIME_UPDATE_REQUIRED')
    assert.equal(provisionCalls, 0)
    assert.equal(fs.readFileSync(configPath, 'utf8'), before)

    const resolved = spawnSync(python!, ['-c', `import json,socket
from hermes_cli.runtime_provider import resolve_runtime_provider
from hermes_cli.web_server_config import _normalize_main_model_assignment
socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('No network in resolver proof'))
p,m=_normalize_main_model_assignment('custom','owner-a')
r=resolve_runtime_provider(requested=p,target_model=m)
print(json.dumps({'provider':p,'key_ok':r['api_key']=='hc903-fixture-byok','url_ok':r['base_url']=='http://127.0.0.1:2/v1'}))`], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: fixture.directory,
        HERMES_HOME: fixture.home, PYTHONPATH: root, LANG: 'en_US.UTF-8' }
    })

    assert.equal(resolved.status, 0, resolved.stderr)
    assert.deepEqual(JSON.parse(resolved.stdout.trim()), { provider: 'custom:other', key_ok: true, url_ok: true })
  } finally {await fixture.close()}
}, 30_000)

run.each(['legacy', 'keyed'])('healthy Native recovery follows a literal custom identity in the %s catalog without a main URL', async family => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')

    const config = { model: { provider: 'custom', default: 'owner-a' },
      ...(family === 'keyed' ? { providers: { custom: { api: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', default_model: 'owner-a' } } }
        : { custom_providers: [{ name: 'custom', base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', model: 'owner-a' }] }) }

    fs.writeFileSync(configPath, yaml.dump(config))
    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, legacyOwnedPid: fixture.child.pid }

    assert.equal(await managedRuntimeNeedsRepair(target, fixture.assignment('b')), true)
    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)

    const prepared = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
      requiresRevision: true, managedBaseUrl: 'http://127.0.0.1:1/v1' })

    const completed = await completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {} })

    const resolved = spawnSync(python!, ['-c', `import json,socket
from hermes_cli.runtime_provider import resolve_runtime_provider
socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('No network in resolver proof'))
r=resolve_runtime_provider(requested=${JSON.stringify(completed.modelAssignment.provider)},target_model='owner-b')
print(json.dumps({'key_ok':r['api_key']=='hc903-fixture-key-b','url_ok':r['base_url']=='http://127.0.0.1:1/v1'}))`], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: fixture.directory,
        HERMES_HOME: fixture.home, PYTHONPATH: root, LANG: 'en_US.UTF-8' }
    })

    assert.equal(resolved.status, 0, resolved.stderr)
    assert.deepEqual(JSON.parse(resolved.stdout.trim()), { key_ok: true, url_ok: true })

    // A different catalog name is not the selected literal-custom identity.
    // Do not infer a managed selection from its URL or first-entry position.
    const unrelated = { model: { provider: 'custom', default: 'owner-a' },
      ...(family === 'keyed' ? { providers: { other: { api: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-byok', default_model: 'owner-a' } } }
        : { custom_providers: [{ name: 'other', base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-byok', model: 'owner-a' }] }) }

    fs.writeFileSync(configPath, yaml.dump(unrelated))
    const before = fs.readFileSync(configPath, 'utf8')

    assert.equal(await managedRuntimeNeedsRepair(target, fixture.assignment('b')), false)
    assert.equal(fs.readFileSync(configPath, 'utf8'), before)
  } finally {await fixture.close()}
}, 30_000)

run.each(['legacy', 'keyed'])('healthy Native recovery respects the selected %s consumer over conflicting inline URLs in both directions', async family => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')
    const managedUrl = 'http://127.0.0.1:1/v1'
    const byokUrl = 'http://127.0.0.1:2/v1'

    const rows = { managed: { base_url: managedUrl, api_key: 'hc903-fixture-key-a', model: 'owner-a' },
      byok: { base_url: byokUrl, api_key: 'hc903-fixture-byok', model: 'byok' } }

    const catalog = family === 'keyed' ? { providers: rows }
      : { custom_providers: Object.entries(rows).map(([name, row]) => ({ name, ...row })) }

    fs.writeFileSync(configPath, yaml.dump({ model: { provider: 'custom:byok', default: 'byok',
      base_url: managedUrl, api_key: 'hc903-fixture-inline-a' }, ...catalog }))
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:byok', 'hc903-fixture-byok', byokUrl)
    const before = fs.readFileSync(configPath, 'utf8')
    const requests: { route: string; method: string }[] = []

    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, legacyOwnedPid: fixture.child.pid,
      request: (route, body, headers, method) => {
        requests.push({ route, method: method || (body === undefined ? 'GET' : 'POST') })

        return fixture.target.request(route, body, headers, method)
      } }

    let finalized = 0

    assert.equal(await managedRuntimeNeedsRepair(target, fixture.assignment('b')), false)
    assert.deepEqual(requests, [{ route: '/api/config/raw', method: 'GET' }])
    assert.equal(finalized, 0)
    assert.equal(fs.readFileSync(configPath, 'utf8'), before)
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:byok', 'hc903-fixture-byok', byokUrl)

    // The inverse conflict must recover the selected managed catalog, even
    // though the unused inline mirror still points at the BYOK host.
    fs.writeFileSync(configPath, yaml.dump({ model: { provider: 'custom:managed', default: 'owner-a',
      base_url: byokUrl, api_key: 'hc903-fixture-inline-a' }, ...catalog }))
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:managed', 'hc903-fixture-key-a', managedUrl)
    assert.equal(await managedRuntimeNeedsRepair(target, fixture.assignment('b')), true)
    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)

    const prepared = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
      requiresRevision: true, managedBaseUrl: managedUrl })

    const completed = await completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {finalized++} })

    assert.equal(finalized, 1)
    assert.equal(requests.some(request => request.route.includes('provision-key')), false)
    assertIndependentResolver(fixture.home, fixture.directory, completed.modelAssignment.provider, 'hc903-fixture-key-b', managedUrl)
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:byok', 'hc903-fixture-byok', byokUrl)
    const disk = fixture.readIndependent()

    if (family === 'keyed') {assert.deepEqual(disk.providers.byok, rows.byok)}
    else {assert.deepEqual(disk.custom_providers.find((row: any) => row.name === 'byok'), { name: 'byok', ...rows.byok })}
  } finally {await fixture.close()}
}, 30_000)

run.each(['legacy', 'keyed'])('ambiguous %s catalog aliases refuse healthy recovery without any write', async family => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')
    const managedUrl = 'http://127.0.0.1:1/v1'
    const byokUrl = 'http://127.0.0.1:2/v1'

    const rows = { other: { name: 'chosen', base_url: byokUrl, api_key: 'hc903-fixture-byok', model: 'byok' },
      chosen: { name: 'chosen', base_url: managedUrl, api_key: 'hc903-fixture-key-a', model: 'owner-a' } }

    fs.writeFileSync(configPath, yaml.dump({ model: { provider: 'custom:chosen', default: 'owner-a',
      base_url: managedUrl, api_key: 'hc903-fixture-inline-a' },
    ...(family === 'keyed' ? { providers: rows } : { custom_providers: Object.values(rows) }) }))
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:chosen', 'hc903-fixture-byok', byokUrl)
    const before = fs.readFileSync(configPath, 'utf8')
    const requests: string[] = []

    const target: ResolvedModelTarget = { ...fixture.target, request: (route, body, headers, method) => {
      requests.push(route)

      return fixture.target.request(route, body, headers, method)
    } }

    await assert.rejects(managedRuntimeNeedsRepair(target, fixture.assignment('b')), /MODEL_RUNTIME_UPDATE_REQUIRED/)
    assert.deepEqual(requests, ['/api/config/raw'])
    assert.equal(fs.readFileSync(configPath, 'utf8'), before)
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:chosen', 'hc903-fixture-byok', byokUrl)
  } finally {await fixture.close()}
}, 30_000)

run.each(['托管', 'managed.endpoint'])('released legacy recovery verifies the real consumer for valid provider ID %s and leaves a different API route unchanged', async id => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')

    const byok = { api: 'http://127.0.0.1:2/v1', base_url: 'http://127.0.0.1:1/v1',
      api_key: 'hc903-fixture-byok', default_model: 'byok' }

    fs.writeFileSync(configPath, yaml.dump({ model: { provider: `custom:${id}`, default: 'owner-a',
      base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a' }, providers: {
      [id]: { api: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', default_model: 'owner-a' }, byok
    } }))

    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, localRuntime: false,
      request: (route, body, headers, method) => {
        if (route === '/api/providers/custom-endpoints' && method === 'GET') {
          return Promise.reject(Object.assign(new Error('released legacy route absent'), { statusCode: 404 }))
        }

        return fixture.target.request(route, body, headers, method)
      } }

    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)

    const prepared = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
      requiresRevision: false, managedBaseUrl: 'http://127.0.0.1:1/v1' })

    let finalized = false

    const completed = await completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {finalized = true} })

    assert.equal(finalized, true)
    assertIndependentResolver(fixture.home, fixture.directory, completed.modelAssignment.provider, 'hc903-fixture-key-b', 'http://127.0.0.1:1/v1')
    assert.deepEqual(fixture.readIndependent().providers.byok, byok)
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:byok', 'hc903-fixture-byok', 'http://127.0.0.1:2/v1')
    const changed = fixture.readIndependent()
    changed.model = { provider: 'custom:byok', default: 'byok' }
    fs.writeFileSync(configPath, yaml.dump(changed))
    const before = fs.readFileSync(configPath, 'utf8')

    assert.equal(await managedRuntimeNeedsRepair(target, fixture.assignment('b')), false)
    assert.equal(fs.readFileSync(configPath, 'utf8'), before)
  } finally {await fixture.close()}
}, 30_000)

run('independent YAML consumer readback refuses a successful raw write that retained an old Unicode catalog key', async () => {
  const fixture = await server('legacy')

  try {
    const configPath = path.join(fixture.home, 'config.yaml')
    fs.writeFileSync(configPath, yaml.dump({ model: { provider: 'custom:托管', default: 'owner-a',
      base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a' }, providers: {
      托管: { api: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', default_model: 'owner-a' }
    } }))
    let alteredWrites = 0

    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, localRuntime: false,
      request: (route, body, headers, method) => {
        if (route === '/api/providers/custom-endpoints' && method === 'GET') {
          return Promise.reject(Object.assign(new Error('released legacy route absent'), { statusCode: 404 }))
        }

        if (route === '/api/config/raw' && method === 'PUT') {
          const corrupted = yaml.load((body as any).yaml_text) as any
          corrupted.providers.托管.api_key = 'hc903-fixture-key-a'
          alteredWrites++

          return fixture.target.request(route, { yaml_text: yaml.dump(corrupted) }, headers, method)
        }

        return fixture.target.request(route, body, headers, method)
      } }

    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)

    const prepared = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
      requiresRevision: false, managedBaseUrl: 'http://127.0.0.1:1/v1' })

    let finalized = 0

    await assert.rejects(completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {finalized++} }),
    (error: any) => error.code === 'MODEL_RUNTIME_UPDATE_REQUIRED')
    assert.equal(alteredWrites, 1, 'the fault reached the actual HTTP writer once')
    assert.equal(finalized, 0)
    assert.equal(fixture.readIndependent().model.api_key, 'hc903-fixture-key-b')
    assertIndependentResolver(fixture.home, fixture.directory, 'custom:托管', 'hc903-fixture-key-a', 'http://127.0.0.1:1/v1')
  } finally {await fixture.close()}
}, 30_000)

run('independent consumer guard rejects a legal catalog layout the YAML patcher cannot address instead of finalizing an old key', async () => {
  const fixture = await server('legacy')

  try {
    const id = '托管/独立'
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), yaml.dump({ model: { provider: `custom:${id}`, default: 'owner-a',
      base_url: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a' }, providers: {
      [id]: { api: 'http://127.0.0.1:1/v1', api_key: 'hc903-fixture-key-a', default_model: 'owner-a' }
    } }))

    const target: ResolvedModelTarget = { ...fixture.target, targetId: null, localRuntime: false,
      request: (route, body, headers, method) => {
        if (route === '/api/providers/custom-endpoints' && method === 'GET') {
          return Promise.reject(Object.assign(new Error('released legacy route absent'), { statusCode: 404 }))
        }

        return fixture.target.request(route, body, headers, method)
      } }

    const coordinator = new DesktopModelMutationCoordinator(fixture.metadata(), async () => target)

    const prepared = await prepareManagedModelMutation({ coordinator, scope, isCurrent: () => true,
      requiresRevision: false, managedBaseUrl: 'http://127.0.0.1:1/v1' })

    let finalized = 0

    await assert.rejects(completeManagedModelAssignment({ coordinator, target: prepared, receipts: new ManagedModelReceiptRegistry(),
      assignment: fixture.assignment('b'), isCurrent: () => true, syncLocal: () => {}, finalize: () => {finalized++} }),
    (error: any) => error.code === 'MODEL_RUNTIME_UPDATE_REQUIRED')
    assert.equal(finalized, 0)
    assert.equal(fixture.readIndependent().model.api_key, 'hc903-fixture-key-b')
    assertIndependentResolver(fixture.home, fixture.directory, `custom:${id}`, 'hc903-fixture-key-a', 'http://127.0.0.1:1/v1')
  } finally {await fixture.close()}
}, 30_000)
