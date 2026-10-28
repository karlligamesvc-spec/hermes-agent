// hc-1102 census: every way main.ts stops a local engine ends what that engine started outside
// its process group (apex-engine-children.ts), not only the quit. main.ts cannot be imported, so
// this reads it: each engine stop must reach one of the two swept paths, and a new way to signal
// an engine that bypasses them turns a test here red. Behaviour: apex-engine-children.test.ts
// (real processes) and local-backend-lifecycle.test.ts (order: snapshot, signal, exit, end).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

const code = readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '')

function body(signature: string): string {
  const start = code.indexOf(signature)

  assert.ok(start >= 0, `${signature} is missing from main.ts`)

  return code.slice(start, code.indexOf('\n}\n', start) + 2)
}

/** Every main.ts function (top-level `function`/`async function`) whose body contains `needle`. */
function functionsCalling(needle: string): string[] {
  const names: string[] = []

  for (const match of code.matchAll(/^(?:async )?function (\w+)\(/gm)) {
    const start = match.index!
    const text = code.slice(start, code.indexOf('\n}\n', start) + 2)

    if (text.includes(needle)) {
      names.push(match[1])
    }
  }

  return names
}

describe('every local engine stop in main.ts ends what the engine started', () => {
  test('the lifecycle every owned engine stops through sweeps it (pool reap and eviction, delete, re-home, update, failed start, quit)', () => {
    const lifecycle = code.slice(code.indexOf('const localBackendLifecycle = createLocalBackendLifecycle'))

    assert.match(
      lifecycle.slice(0, lifecycle.indexOf('\n})\n')),
      /\n {2}sweepOnStop: child => sweepEngineOnStop\(child, rememberLog\),/
    )
    assert.match(
      body('function stopBackendChild(child)'),
      /^function stopBackendChild\(child\) \{\n\s+void localBackendLifecycle\.stop\(child\)\.catch\(/
    )

    // The platform signal itself is sent from nowhere else: every stop reaches it through the lifecycle.
    assert.equal(code.match(/stopBackendChildImpl\(/g)?.length, 1)
    assert.ok(lifecycle.indexOf('stopBackendChildImpl(') < lifecycle.indexOf('\n})\n'))
  })

  test('both engine spawns are owned by the lifecycle, the messaging gateway is not', () => {
    assert.deepEqual(
      functionsCalling('spawnOwnedBackend('),
      ['spawnOwnedBackend', 'runPoolBackendStart', 'runHermesStart'].sort(
        (a, b) => code.indexOf(`function ${a}(`) - code.indexOf(`function ${b}(`)
      )
    )
    assert.doesNotMatch(body('async function startMessagingGateway('), /spawnOwnedBackend\(/)
  })

  test('the only direct group signal is the reap of an earlier Desktop’s engine, and it sweeps too', () => {
    assert.deepEqual(functionsCalling('process.kill(-'), ['stopOwnedBackend'])
    assert.equal(code.match(/stopOwnedBackend\b/g)?.length, 2, 'its definition and the ownership stop below')
    assert.match(
      code,
      /\n {2}stop: entry => stopEndingChildren\(entry, \(\) => processIdentityMatches\(entry, REAP_PROBE_TIMEOUT_MS\), \(\) => stopOwnedBackend\(entry\), rememberLog\),/
    )
  })

  // Windows needs no sweep: taskkill /T /F walks the engine's whole tree (backend-child.ts).
  test('a direct tree kill is Windows-only', () => {
    assert.deepEqual(functionsCalling('forceKillProcessTree('), ['killHermesOwnedVenvDaemons', 'stopOwnedBackend'])
    assert.match(
      body('async function stopOwnedBackend('),
      /if \(IS_WINDOWS\) \{\n\s+forceKillProcessTree\(identity\.pid\)\n\s+\} else \{/
    )
    assert.match(body('function killHermesOwnedVenvDaemons('), /if \(!IS_WINDOWS\) \{\n\s+return\n\s+\}/)
  })

  // A stop the user did not ask for must not cut off work: the idle reaper and the LRU cap both ask
  // the engine first, and its idle proof counts running background commands (hermes_cli/web_server_idle_exit.py).
  test('the idle reaper and the LRU cap stop a pooled engine only after it retires', () => {
    assert.match(body('function startPoolIdleReaper('), /void reapIdlePoolEngine\(poolRetirement\(profile, entry\)\)/)

    const evict = body('async function evictLruPoolBackends(')

    assert.match(
      evict,
      /async profile => void \(await reapIdlePoolEngine\(\{ \.\.\.poolRetirement\(profile\), what: `Evicting idle profile backend/
    )
    assert.doesNotMatch(evict, /stopPoolBackend\(/, 'no stop that skips the engine’s answer')
    assert.match(body('function poolRetirement('), /stop: \(\) => stopPoolBackend\(profile\)/)
  })
})
