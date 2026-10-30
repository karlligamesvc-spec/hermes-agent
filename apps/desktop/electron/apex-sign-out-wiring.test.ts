// hc-1114 wiring guards on main.ts. Hard rule 12: every way the stored relay
// credential leaves this computer — the sign-out, a sign-in as another account,
// and a sign-out on an older version found at boot — ends with no copy of the
// key on disk and a desktop.log line. Comments are stripped first, so a
// mention in a comment never passes for the call.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

const code = readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/ \/\/ hc-\d+.*$/gm, '')

function enclosingFunction(index: number): string {
  const fn = [...code.slice(0, index).matchAll(/^(?:async )?function (\w+)\(/gm)].at(-1)

  return fn && !code.slice(fn.index, index).includes('\n}\n') ? fn[1] : '(module scope)'
}

function owners(pattern: RegExp): string[] {
  return [...code.matchAll(pattern)].map(match => enclosingFunction(match.index ?? 0))
}

function block(start: string, end = '\n})\n'): string {
  const from = code.indexOf(start)

  assert.ok(from >= 0, `${start} is missing from main.ts`)

  return code.slice(from, code.indexOf(end, from) + end.length)
}

describe('the sign-out', () => {
  const handler = block("ipcMain.handle('hermes:managed:signOut', async () => {")

  test('reads the credential before anything clears it, and hands it to the clean-up', () => {
    assert.match(
      handler,
      /^ipcMain\.handle\('hermes:managed:signOut', async \(\) => \{\n\s+const managed = resolveManagedConfig\(\)\n/
    )
    assert.match(
      handler,
      /\n\s+afterClear: \(\) => cleanUpAfterSignOut\(\{ root: HERMES_HOME, managed, defaultRelayBaseUrl: endpoints\.relayBaseUrl, restartHolders: restartEnginesOnStaleRelayKey \}\),\n/
    )
    assert.match(handler, /\n\s+envKey, log: rememberLog,\n/)
  })

  test('is the only caller of signOutManagedDevice', () => {
    assert.equal([...code.matchAll(/\bsignOutManagedDevice\(/g)].length, 1)
  })

  // Another way to drop the stored credential would leave every copy behind again: route it through
  // the sign-out (or clean up the same way) before changing this census.
  test('is the only place the stored credential is removed', () => {
    assert.deepEqual(owners(/fs\.rmSync\(DESKTOP_MANAGED_CONFIG_PATH/g), ['clearManagedRelayCredential'])
    // Its one use besides the definition is the sign-out's clearCredential.
    assert.equal([...code.matchAll(/(?<!function )\bclearManagedRelayCredential\b/g)].length, 1)
    assert.match(handler, /\n\s+clearCredential: clearManagedRelayCredential,\n/)
  })
})

describe('the boot while nobody is signed in', () => {
  // The boot runs syncManagedRelayKeyToConfig('boot-seed'); signed out, it returns before writing a key.
  test('the signed-out key sync sweeps, and the module decides from managed on, the key and the stored file', () => {
    assert.deepEqual(owners(/\bsweepSignedOutRelayKeys\(/g), ['syncManagedRelayKeyToConfig'])
    assert.match(
      code,
      /\n {2}if \(!managed\.key \|\| !managed\.baseUrl\) \{\n {4}sweepSignedOutRelayKeys\(\{ root: HERMES_HOME, managedEnabled: isManagedEnabled\(process\.env\), key: managed\.key, credentialStored: fs\.existsSync\(DESKTOP_MANAGED_CONFIG_PATH\), baseUrls: \[resolveApexEndpoints\(process\.env\)\.relayBaseUrl\], log: rememberLog \}\)\n\n {4}return \{ ok: false, changed: false, reason: 'signed-out'/
    )
    assert.deepEqual(owners(/syncManagedRelayKeyToConfig\('boot-seed'\)/g), ['runEnsureRuntime'])
  })
})

describe('a sign-in as another account', () => {
  const provision = block('async function provisionManagedFromAccessToken(', '\n}\n')

  test("revokes the previous account's key once the new credential is committed", () => {
    assert.deepEqual(owners(/\brevokePreviousAccountKey\(/g), ['provisionManagedFromAccessToken'])
    const previous = provision.indexOf('const previous = resolveManagedConfig()')
    const write = provision.indexOf('writeManagedConfig({ ...provisioned')
    const committed = provision.indexOf('onCommitted?.(generation)')

    const revoke = provision.indexOf(
      'void revokePreviousAccountKey({ previous, nextAccessToken: token, deviceInstanceId: deviceBody.device_instance_id, log: rememberLog,'
    )

    assert.ok(previous >= 0 && previous < write, 'the previous credential is read before the new one is written')
    assert.ok(committed >= 0 && committed < revoke, 'and revoked only after the commit')
    assert.match(
      provision.slice(revoke),
      /^void revokePreviousAccountKey\(\{[^\n]*\n\s+post: \(bearer, body\) => apexAuthPostJson\(provisionKeyRevokeUrl\(endpoints\.provisionKeyUrl\), \{ bearer, body \}\) \}\)\n/
    )
    assert.match(provision, /managedProvisionCommitToken\(token, previous\.accessToken, purpose\)/)
  })
})
