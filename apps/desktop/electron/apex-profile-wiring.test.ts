// hc-1080 wiring guards on main.ts: every APEX config.yaml writer runs over the
// managed profile homes, pooled engines follow a key rotation, the idle reaper
// asks before it stops, and the side that was already right — what a pooled
// engine inherits at spawn — stays pinned to the primary's.

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

/** Top-level entries of the object literal that opens at `open` ('{'): spreads and keys, in order. */
function objectEntries(source: string, open: number): string[] {
  const entries: string[] = []
  let depth = 0
  let current = ''

  for (let index = open; index < source.length; index += 1) {
    const char = source[index]

    if ('({['.includes(char)) {
      depth += 1

      if (depth === 1) {
        continue
      }
    } else if (')}]'.includes(char)) {
      depth -= 1

      if (depth === 0) {
        break
      }
    } else if (char === ',' && depth === 1) {
      entries.push(current.trim())
      current = ''

      continue
    }

    current += char
  }

  if (current.trim()) {
    entries.push(current.trim())
  }

  return entries.map(entry => (entry.startsWith('...') ? entry.replace(/\s+/g, '') : entry.split(':')[0].trim()))
}

function spawnEnv(fnBody: string, marker: string): string[] {
  const at = fnBody.indexOf(marker)

  assert.ok(at >= 0, `${marker} not found`)

  return objectEntries(fnBody, fnBody.indexOf('{', at))
}

describe('every APEX config.yaml writer covers the managed profiles', () => {
  test('the relay-key sync writes the root first, then each managed profile, then restarts stale pooled engines', () => {
    const sync = body('function syncManagedRelayKeyToConfig(')
    const rootWrite = sync.indexOf('const result = persistRelayKeyInHome(root, managed, reason, rememberLog)')

    const profileWrites = sync.indexOf(
      'profiles.forEach(home => persistRelayKeyInHome(home, managed, reason, rememberLog))'
    )

    const restart = sync.indexOf('void restartPoolEnginesOnStaleRelayKey(reason)')

    assert.match(sync, /const \[root, \.\.\.profiles\] = apexConfigHomes\(managed\)/)
    assert.ok(rootWrite > 0 && profileWrites > rootWrite && restart > profileWrites, 'root → profiles → pooled engines')
    assert.match(sync, /return result\n\}/, 'the root result is what callers gate on')
    assert.doesNotMatch(
      sync,
      /persistRelayKeyToConfigYaml\(|HERMES_HOME, 'config\.yaml'/,
      'no second, root-only writer'
    )
  })

  test('the 401 self-heal reload syncs the profiles and pooled engines before the primary goes down', () => {
    const reload = body('async function reloadBackendForRelayKey(')
    const sync = reload.indexOf('syncManagedRelayKeyToConfig(reason)')

    assert.ok(sync > 0 && sync < reload.indexOf('teardownPrimaryBackendAndWait'), 'sync first')
    assert.ok(sync < reload.indexOf('if (!backendConnectionState.getProcess())'), 'also when no primary is live')
  })

  test('the stale-key restart covers exactly the managed homes and goes through the pool stopper', () => {
    const restart = body('async function restartPoolEnginesOnStaleRelayKey(')

    assert.match(
      restart,
      /poolKeysOnStaleRelayKey\(backendPool\.entries\(\), apexConfigHomes\(managed\)\.map\(home => home\.profile\), managed\.key\)/
    )
    assert.match(restart, /await Promise\.all\(stale\.map\(key => stopPoolBackend\(key\)\)\)/)
  })

  test('the product-block guard runs over apexConfigHomes and nothing heals the root alone', () => {
    const guard = body('function guardConfigYamlProductBlocks(')
    const context = body('function productBlocksContext(')

    assert.match(
      guard,
      /const context = productBlocksContext\(\)\n\s+if \(context\) \{guardProductBlocksInHomes\(apexConfigHomes\(context\.managed\), context, reason, rememberLog\)\}/
    )
    assert.match(
      context,
      /^\s+if \(modelMutationMetadata\.pending\(\)\.length > 0\) \{return null\}$/m,
      'no heal while a Native model write is unresolved'
    )
    assert.doesNotMatch(code, /function healConfigYamlProductBlocks\(/)
    assert.match(
      body('function apexConfigHomes('),
      /managedProfileHomes\(HERMES_HOME, managed\.baseUrl \|\| resolveApexEndpoints\(process\.env\)\.relayBaseUrl\)/
    )
  })

  test('hc-1078 can heal one new profile now: the IPC shares the guard context, homes and pool restart', () => {
    const registration = code.slice(code.indexOf('registerProfileConfigIpc(ipcMain, {'))

    assert.match(
      registration.slice(0, registration.indexOf('})\n') + 3),
      /^registerProfileConfigIpc\(ipcMain, \{ root: HERMES_HOME, homes: managed => apexConfigHomes\(managed\), context: productBlocksContext,\n\s+afterHeal: reason => restartPoolEnginesOnStaleRelayKey\(reason\), log: rememberLog \}\)\n$/m,
      'registered at module scope, so the handler is live from startup'
    )

    // The name and argument hc-1078 calls (agreed between the M2 and M4 sessions).
    const preload = readFileSync(join(import.meta.dirname, 'preload.ts'), 'utf8')

    assert.match(
      preload,
      /^ {2}healApexProfileConfig: profile => ipcRenderer\.invoke\('hermes:apex:healProfileConfig', profile\),$/m
    )
  })

  // Hard rule 12: the census of every root config.yaml path in main.ts, by function. A new one
  // turns this red; decide whether it must run over apexConfigHomes() before adding it here.
  test('every remaining root config.yaml path is a reviewed root-only one', () => {
    const owners: string[] = []
    const pattern = /path\.join\(HERMES_HOME, 'config\.yaml'\)/g

    for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
      const before = code.slice(0, match.index)
      const fn = [...before.matchAll(/^(?:async )?function (\w+)\(/gm)].at(-1)
      owners.push(fn ? fn[1] : '(module scope)')
    }

    assert.deepEqual(owners, [
      // Creates config.yaml when the root has none; a named profile is never invented.
      'seedDefaultModelConfig',
      // fs.watch on the root; the per-home guard it triggers covers the profiles.
      'watchConfigYamlProductBlocks',
      // Root absent at boot; profiles are healed by the guard it triggers.
      'guardConfigYamlWhenItArrives',
      // Platform config_yaml keys; v2–v4 payloads only carry APEX_PRODUCT_DEFAULTS keys, which the per-home heal fills.
      'applyClientConfigToRuntime',
      // The 401 self-heal's reconcileManagedRelayKey on the root; its applyToBackend
      // (reloadBackendForRelayKey) covers the profiles.
      'reconcileCurrentManagedRelay'
    ])
  })
})

describe('pooled engines', () => {
  test('a pooled child is stamped with its profile and relay key right at spawn', () => {
    const start = body('async function runPoolBackendStart(')

    assert.match(
      start,
      /entry\.process = child\n\s+entry\.token = token\n\s+stampPoolEngine\(entry, profile, resolveManagedConfig\(\)\.key\)/
    )
  })

  // hc-1080: with several assistants on, a user's open makes room by retiring idle engines and fails
  // with the shared all-busy result; switch off, background dials and limit changes keep upstream eviction.
  test('opening one more assistant than the pool holds retires an idle engine, only with several assistants on', () => {
    const evict = body('async function evictLruPoolBackends(')
    const gate = evict.indexOf("if (spawnPriority === 'foreground' && isMultiBotActive(process.env)) {")

    assert.ok(gate > 0, 'gated on a user open and the several-assistants switch')
    assert.match(evict, /const made = await makeRoomInPool\(\{ entries: backendPool\.entries\(\), keep,/)
    assert.match(evict, /stillPooled: \(key, entry\) => backendPool\.get\(key\) === entry \}\)/)
    assert.match(evict, /if \(!made\.room\) \{throw poolAllBusyError\(made, poolMaxBackends\(\)\)\}/)
    assert.ok(evict.indexOf('return evictPoolEntries(') > gate, 'the upstream path stays for everything else')

    // The two local spawn paths pass the dial's priority; the remote-registry one and a limit change do not.
    assert.equal(code.match(/await evictLruPoolBackends\(poolMaxBackends\(\) - 1, spawnPriority\)/g)?.length, 2)
    assert.equal(code.match(/await evictLruPoolBackends\(poolMaxBackends\(\) - 1\)\n/g)?.length, 1)
    assert.match(code, /void evictLruPoolBackends\(poolMaxBackends\(\)\)/)
    assert.match(
      body('async function ensureBackend('),
      /await evictLruPoolBackends\(poolMaxBackends\(\) - 1, spawnPriority\)/
    )
  })

  // hc-1093: a user open that joined a background dial's claim only promoted the queued slot request,
  // and waited 30 s. The slot coordinator now hands every foreground waiter it cannot seat to the same
  // eviction, under the same switch (behaviour: apex-pool-foreground.test.ts).
  test('a user open queued behind a background dial makes room the same way', () => {
    assert.match(
      code,
      /new LocalBackendSpawnCoordinator\(poolLimits\.maxBackends, \{ onForegroundWait: \(\) => isMultiBotActive\(process\.env\) && evictLruPoolBackends\(poolMaxBackends\(\) - 1, 'foreground'\) \}\)/
    )

    // The two ways a click reaches a spawn it did not start both end in a foreground slot request.
    assert.match(body('function promotePoolEntry('), /entry\.localBackendSpawnRequest\?\.promote\?\.\('foreground'\)/)

    const start = body('async function runPoolBackendStart(')

    assert.match(start, /if \(takeForegroundSpawn\(poolKey, profile\)\) \{\n\s+entry\.spawnPriority = 'foreground'\n\s+\}/)
    assert.match(
      start,
      /localBackendSpawnCoordinator\.request\(poolKey, \{\n\s+timeoutMs: POOL_SLOT_WAIT_MS,\n\s+priority: spawnPriority\n\s+\}\)/
    )
  })

  // hc-1102: the reaper's deps moved into poolRetirement, which the LRU cap shares (apex-engine-stop-wiring.test.ts).
  test('the idle reaper asks the engine before it stops it', () => {
    const reaper = body('function startPoolIdleReaper(')
    const retirement = body('function poolRetirement(')

    assert.match(reaper, /void reapIdlePoolEngine\(poolRetirement\(profile, entry\)\)/)
    assert.doesNotMatch(reaper, /stopPoolBackend\(/, 'the only stop is the one reapIdlePoolEngine decides on')
    assert.match(
      retirement,
      /stillPooled: \(\) => backendPool\.get\(profile\) === entry, stop: \(\) => stopPoolBackend\(profile\),/
    )
    assert.equal(retirement.match(/stopPoolBackend\(/g)?.length, 1)
    assert.match(
      retirement,
      /fetchJson\(`http:\/\/127\.0\.0\.1:\$\{entry\.port\}\$\{route\}`, entry\.token, \{ method: 'POST', body, timeoutMs: 5_000 \}\)/
    )
  })

  // Already right before hc-1080, pinned so it stays right: a pooled engine gets the same
  // spawn env as the primary — the parent env (desktop_features switches included), the
  // platform-tool, Feishu and IM credentials — so a second assistant has the same tools.
  test('a pooled engine inherits the same spawn env as the primary', () => {
    const pool = spawnEnv(body('async function runPoolBackendStart('), 'env: desktopBackendSpawnEnv(')
    const primary = spawnEnv(body('async function runHermesStart('), 'env: desktopBackendSpawnEnv(')

    assert.deepEqual(pool, primary)

    for (const required of [
      '...process.env',
      'HERMES_HOME',
      '...backend.env',
      '...desktopFeishuSpawnEnv()',
      '...desktopImEntrySpawnEnv()',
      '...desktopPlatformToolSpawnEnv()'
    ]) {
      assert.ok(pool.includes(required), `${required} missing from the pooled spawn env`)
    }

    assert.ok(
      pool.indexOf('...desktopImEntrySpawnEnv()') > pool.indexOf('...desktopFeishuSpawnEnv()'),
      'hc-417 binding wins the FEISHU_* keys'
    )
    assert.equal(pool[0], '...process.env', 'the parent env comes first, so nothing after it is shadowed by it')
  })
})
