// hc-1106 wiring guards on main.ts. Hard rule 12: every process the desktop
// hands the relay key at spawn is stamped and listed in the stale-key restart,
// every key change reaches that restart, and the 401 self-heal compares the
// running engines with the stored key instead of only probing the key on disk.

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

function enclosingFunction(index: number): string {
  const fn = [...code.slice(0, index).matchAll(/^(?:async )?function (\w+)\(/gm)].at(-1)

  // A top-level function ends at the first column-0 brace after it.
  return fn && !code.slice(fn.index, index).includes('\n}\n') ? fn[1] : '(module scope)'
}

function owners(pattern: RegExp): string[] {
  return [...code.matchAll(pattern)].map(match => enclosingFunction(match.index ?? 0))
}

describe('every process spawned with the relay key is stamped', () => {
  // The platform-tool fragment carries TOOLS_GATEWAY_KEY (apex-platform-tools.ts). A new spawn
  // with it turns this red: stamp it and add it to the holders before adding it here.
  test('the spawns that carry the platform-tool key are the primary, the pool and the messaging gateway', () => {
    assert.deepEqual(owners(/\.\.\.desktopPlatformToolSpawnEnv\(\)/g), [
      'runPoolBackendStart',
      'runHermesStart',
      'startMessagingGateway'
    ])
    assert.doesNotMatch(code, /TOOLS_GATEWAY_KEY/, 'no spawn sets the key by hand')
  })

  test.each([
    ['runHermesStart', /\n\s+\)\n\s+stampKeyHolderProcess\(hermesProcess, resolveManagedConfig\(\)\.key\)/],
    [
      'runPoolBackendStart',
      /entry\.token = token\n\s+stampPoolEngine\(entry, profile, resolveManagedConfig\(\)\.key\)/
    ],
    [
      'startMessagingGateway',
      /messagingGatewayRuntime\.profile = profile \|\| null\n\s+stampKeyHolderProcess\(child, resolveManagedConfig\(\)\.key\)/
    ]
  ])('%s stamps its child right after the spawn, with the key the env was built from', (fn, stamp) => {
    const spawned = body(`function ${fn}(`)

    assert.match(spawned, stamp)
    // Nothing awaits between building the env and the stamp, so both read the same stored key.
    const between = spawned.slice(spawned.indexOf('...desktopPlatformToolSpawnEnv()'), spawned.search(stamp))
    assert.doesNotMatch(between, /\bawait\b/)
  })
})

describe('the stale-key restart covers every holder', () => {
  const holders = code.slice(
    code.indexOf('const staleRelayKeys = new StaleRelayKeyRestarts('),
    code.indexOf('function restartEnginesOnStaleRelayKey(')
  )

  test('pooled engines, the messaging gateway and the primary engine, against the stored key', () => {
    assert.match(holders, /relayKey: \(\) => resolveManagedConfig\(\)\.key/)
    assert.match(holders, /\.\.\.poolKeyHolders\(backendPool\.entries\(\), \{ stop: stopPoolBackend,/)
    assert.match(
      holders,
      /\.\.\.gatewayKeyHolder\(\(\) => \(messagingGatewayChildAlive\(\) \? messagingGatewayRuntime\.process : null\),\n\s+gatewayStatePath\(HERMES_HOME, messagingGatewayRuntime\.profile\), \{ restart: restartMessagingGateway \}\)/
    )
    // In place: torn down and respawned without the connection-switch broadcast (sendConnectionApplied),
    // whose softSwitch wipes the session lists and leaves the open conversation on a spinner.
    assert.match(
      holders,
      /\.\.\.primaryKeyHolder\(\(\) => backendConnectionState\.getProcess\(\), primaryProfileKey\(\), \{ restart: \(\) => teardownPrimaryBackendAndWait\(\{ soft: true \}\)\.then\(\(\) => ensureBackend\(primaryProfileKey\(\)\)\),/
    )
    assert.doesNotMatch(holders, /sendConnectionApplied|reloadBackendForRelayKey/)
    // The primary's fence is asked on the live connection (its served token), not a guessed port.
    assert.match(
      holders,
      /post: async \(route, body\) => fetchJsonForBackend\(await backendConnectionState\.getPromise\(\), route,/
    )
  })

  test('every caller of the restart, by function', () => {
    assert.deepEqual(owners(/restartEnginesOnStaleRelayKey\b(?!\(reason: string\))/g), [
      // Every key write (boot, sign-in, self-heal) goes through here (hc-1080's config.yaml census).
      'syncManagedRelayKeyToConfig',
      // registerProfileConfigIpc's afterHeal (hc-1078 creating a profile).
      '(module scope)',
      // The 401 self-heal, when the relay accepts the stored key.
      'reconcileCurrentManagedRelay',
      // The sign-in completion waits for it.
      'finishManagedModelRuntime',
      // hc-1114: the sign-out handler's clean-up, onto no key (apex-sign-out-wiring.test.ts).
      '(module scope)'
    ])
    assert.equal(code.match(/void restartEnginesOnStaleRelayKey\(reason\)/g)?.length, 1)
  })

  // The renderer probes the runtime right after a sign-in (onboarding's checkRuntime); a primary
  // re-homing underneath that probe would read as 「连不上」.
  // The primary's restart above respawns it (ensureBackend) before the run settles.
  test('a sign-in returns only after the engines on the old key restarted and the primary is back', () => {
    assert.match(
      body('async function finishManagedModelRuntime('),
      /\}\)\.then\(completed => restartEnginesOnStaleRelayKey\('managed-runtime-complete'\)(?: \/\/[^\n]*)?\n\s+\.catch\(\(\) => undefined\)\.then\(\(\) => completed\)\)\n\}/
    )
  })
})

describe('the 401 self-heal looks at the running engines', () => {
  // A re-provision runs the sign-in completion, which already restarts the primary off the old key
  // once idle; the unconditional re-home after it would be a second restart. Key drift (config.yaml
  // out of step with a primary stamped with the stored key) still always re-homes.
  test('a re-provision does not re-home a primary already on the new key; key drift always does', () => {
    const reload = body('async function reloadBackendForRelayKey(')

    assert.match(
      reload,
      /if \(!backendConnectionState\.getProcess\(\) \|\| \(reason === 'key-rotation' && holdsRelayKey\(backendConnectionState\.getProcess\(\), resolveManagedConfig\(\)\.key\)\)\) \{\n\s+return false/
    )
    assert.doesNotMatch(reload, /key-drift/)
  })

  test('it goes through reconcileRelayKeyAndEngines with the stale-key restart, nowhere around it', () => {
    const reconcile = body('async function reconcileCurrentManagedRelay(')

    assert.match(reconcile, /const outcome = await reconcileRelayKeyAndEngines\(\{/)
    assert.match(
      reconcile,
      /log: rememberLog\n\s+\}, restartEnginesOnStaleRelayKey, \(\) => resolveManagedConfig\(\)\.runtimePending\)/
    )
    assert.doesNotMatch(code, /reconcileManagedRelayKey\(/, 'no caller skips the engine check')
  })

  // The selfHeal handler's existing path then hands the renderer an assignment, and
  // managed-recovery.ts retries the failed turn (runtimeRestored) on the restarted engine.
  test('a restarted engine completes the managed runtime, which hands the renderer an assignment', () => {
    const reconcile = body('async function reconcileCurrentManagedRelay(')

    assert.match(
      reconcile,
      /if \(outcome\.completeRuntime\) \{\n\s+const target = await desktopModelMutations\.resolveTarget\(scope\)\n\s+completion = await finishManagedModelRuntime\(target, isCurrent\)/
    )
    assert.match(reconcile, /\.\.\.\(completion \? \{ completionScope: scope, assignment: managedSignInResultPayload/)
  })
})
