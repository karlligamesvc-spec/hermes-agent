import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { normalizeDesktopPlatform } from './apexnodes-telemetry'
import {
  buildPinArgs,
  buildPosixPinArgs,
  bundledInstallScript,
  cachedScriptPath,
  cnInstallEnv,
  commitKeysMatch,
  describeCnMirrorMode,
  evaluateTreeIntegrity,
  hasExistingGitCheckout,
  installedAgentInstallScript,
  installRefForStamp,
  isPinnedCommit,
  readSourceCommitStamp,
  resolveInstallScript,
  resolveMarkerPinnedCommit,
  runBootstrap,
  runtimeKeyFromStamp,
  SOURCE_COMMIT_STAMP
} from './bootstrap-runner'

// hc-473: keep this suite hermetic -- runBootstrap's DEFAULT sendTelemetry must
// never touch the real network from a test. Tests that assert on beacon content
// inject their own fake sendTelemetry, which always takes priority over this.
// isTelemetryDisabled() reads process.env lazily, so setting it here (after the
// hoisted imports, before any test body runs) is enough.
process.env.APEXNODES_TELEMETRY = 'off'

const SCRIPT_NAME = process.platform === 'win32' ? 'install.ps1' : 'install.sh'
const ZERO_COMMIT = '0000000000000000000000000000000000000000'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bootstrap-test-'))
}

// Minimal posix installer stub: understands --manifest (one stage) and
// --stage complete --non-interactive --json. Enough to drive runBootstrap's
// real fetchManifest -> runStage -> writeMarker path without the full
// 3000+-line real install.sh. `stageFrame` is the JSON the stage reports.
//
// Must live at <sourceRepoRoot>/scripts/install.sh -- resolveLocalInstallScript
// (the "dev shortcut" tier runBootstrap tries first) hardcodes that path.
function writeFakeInstallSh(
  sourceRepoRoot,
  stageFrame = '{"ok":true,"stage":"complete","skipped":false}',
  stagePrelude = []
) {
  const scriptsDir = path.join(sourceRepoRoot, 'scripts')
  fs.mkdirSync(scriptsDir, { recursive: true })
  const scriptPath = path.join(scriptsDir, 'install.sh')

  fs.writeFileSync(
    scriptPath,
    [
      '#!/bin/bash',
      'set -e',
      'if [ "$1" = "--manifest" ]; then',
      '  echo \'{"protocol_version":1,"stages":[{"name":"complete","title":"Finish install","category":"runtime","needs_user_input":false}]}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "--stage" ] && [ "$2" = "complete" ]; then',
      ...stagePrelude,
      `  echo '${stageFrame}'`,
      '  exit 0',
      'fi',
      'echo "unexpected args: $*" >&2',
      'exit 1',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )

  return scriptPath
}

// Skipped on win32: bootstrap-runner spawns 'bash' unconditionally for a
// posix-kind installer, which isn't necessarily on PATH in a bare Windows CI
// shell. The other tests here cover the non-spawning code paths cross-platform.
const testManifestFlow = process.platform === 'win32' ? test.skip : test

test('runBootstrap bails immediately when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()

  const events = []

  const result = await runBootstrap({
    installStamp: null,
    activeRoot: '/tmp/hermes-runner-test',
    sourceRepoRoot: null,
    hermesHome: '/tmp/hermes-runner-test',
    logRoot: '/tmp/hermes-runner-test',
    onEvent: ev => events.push(ev),
    abortSignal: controller.signal
  })

  // Cancelled before any install script is spawned.
  assert.deepEqual(result, { ok: false, cancelled: true })
  assert.ok(
    events.some(ev => ev.type === 'failed' && /cancelled/i.test(ev.error)),
    'should emit a cancelled failure event'
  )
})

test('installedAgentInstallScript resolves the installer in the agent checkout', () => {
  const home = mkTmpHome()

  try {
    assert.equal(installedAgentInstallScript(home), null, 'absent before the checkout exists')

    const scriptsDir = path.join(home, 'hermes-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const scriptPath = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi\n')

    assert.equal(installedAgentInstallScript(home), scriptPath)
    assert.equal(installedAgentInstallScript(null), null, 'null home -> null')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('existing checkout detection requires git metadata', () => {
  const home = mkTmpHome()

  try {
    const activeRoot = path.join(home, 'hermes-agent')
    assert.equal(hasExistingGitCheckout(activeRoot), false)

    fs.mkdirSync(path.join(activeRoot, '.git'), { recursive: true })
    assert.equal(hasExistingGitCheckout(activeRoot), true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('fresh bootstrap args include the packaged commit pin', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp), ['-Commit', installStamp.commit, '-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/hermes-agent',
      hermesHome: '/tmp/hermes'
    }),
    ['--dir', '/tmp/hermes-agent', '--hermes-home', '/tmp/hermes', '--branch', 'main', '--commit', installStamp.commit]
  )
})

test('existing-checkout bootstrap args keep branch but skip the packaged commit pin', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp, { pinCommit: false }), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/hermes-agent',
      hermesHome: '/tmp/hermes',
      pinCommit: false
    }),
    ['--dir', '/tmp/hermes-agent', '--hermes-home', '/tmp/hermes', '--branch', 'main']
  )
})

test('fallback install stamps use an unpinned branch ref', () => {
  const stamp = { commit: ZERO_COMMIT, branch: 'main' }

  assert.equal(isPinnedCommit(ZERO_COMMIT), false)
  assert.deepEqual(installRefForStamp(stamp), {
    ref: 'main',
    cacheKey: 'fallback-main',
    pinned: false
  })
  // Must NOT pass -Commit / --commit for the all-zero placeholder.
  assert.deepEqual(buildPinArgs(stamp), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp: stamp,
      activeRoot: '/tmp/hermes',
      hermesHome: '/tmp/home'
    }),
    ['--dir', '/tmp/hermes', '--hermes-home', '/tmp/home', '--branch', 'main']
  )
})

test('resolveMarkerPinnedCommit prefers real HEAD over fallback stamp zeros', () => {
  const realHead = 'c'.repeat(40)
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    realHead
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: 'd'.repeat(40), branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    'd'.repeat(40),
    'packaged real pin wins over checkout HEAD'
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/missing', {
      resolveHead: () => null
    }),
    null
  )
})

test('resolveInstallScript downloads fallback stamps by branch instead of zero commit', async () => {
  const home = mkTmpHome()

  try {
    const logs = []
    const refs = []

    const result = await resolveInstallScript({
      installStamp: { commit: ZERO_COMMIT, branch: 'main' },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev),
      _download: async (ref, destPath) => {
        refs.push(ref)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, '#!/bin/sh\necho fallback branch\n')

        return destPath
      }
    })

    assert.deepEqual(refs, ['main'])
    assert.equal(result.source, 'download')
    assert.equal(result.commit, null)
    assert.equal(result.path, cachedScriptPath(home, 'fallback-main'))
    assert.ok(
      logs.some(ev => /fallback, unpinned/.test(ev.line || '')),
      'emits an unpinned fallback log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript prefers a cached script without touching the network', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    const cached = cachedScriptPath(home, commit)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, '#!/bin/sh\necho cached\n')

    const logs = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev)
    })

    assert.equal(result.source, 'cache')
    assert.equal(result.path, cached)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript falls back to the installed agent checkout on a 404', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // Seed the installed agent checkout so the fallback has something to resolve.
    const scriptsDir = path.join(home, 'hermes-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const installed = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(installed, '#!/bin/sh\necho fallback\n')

    const logs = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev),
      // Simulate GitHub returning a 404 for the pinned commit.
      _download: async () => {
        throw new Error('Failed to download install.sh: HTTP 404')
      }
    })

    assert.equal(result.source, 'installed-agent')
    // It should have copied the installer into the bootstrap cache.
    assert.equal(result.path, cachedScriptPath(home, commit))
    assert.ok(fs.existsSync(result.path), 'fallback script copied into cache')
    assert.ok(
      logs.some(ev => /falling back to installed agent/.test(ev.line || '')),
      'emits a fallback log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript rethrows when the 404 fallback is unavailable', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // No installed agent checkout seeded -> nothing to fall back to.
    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit },
        sourceRepoRoot: null,
        hermesHome: home,
        emit: () => {},
        _download: async () => {
          throw new Error('Failed to download install.sh: HTTP 404')
        }
      }),
      /HTTP 404|Failed to download/
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Bundled installer: the packaged app ships install.sh/.ps1 in resourcesPath so
// a network-restricted (mainland-China) machine never has to reach
// raw.githubusercontent.com to bootstrap.
// ---------------------------------------------------------------------------

test('bundledInstallScript resolves the installer shipped in resourcesPath', () => {
  const dir = mkTmpHome()

  try {
    assert.equal(bundledInstallScript(dir), null, 'absent before the script exists')
    assert.equal(bundledInstallScript(null), null, 'null resourcesPath -> null')

    const scriptPath = path.join(dir, SCRIPT_NAME)
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho bundled\n')
    assert.equal(bundledInstallScript(dir), scriptPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveInstallScript prefers the bundled installer over the GitHub download', async () => {
  const home = mkTmpHome()
  const resources = mkTmpHome()

  try {
    const bundled = path.join(resources, SCRIPT_NAME)
    fs.writeFileSync(bundled, '#!/bin/sh\necho bundled\n')

    let downloadCalled = false
    const logs = []

    const result = await resolveInstallScript({
      installStamp: { commit: SHA_A },
      sourceRepoRoot: null,
      resourcesPath: resources,
      hermesHome: home,
      emit: ev => logs.push(ev),
      _download: async () => {
        downloadCalled = true
        throw new Error('bundled script must short-circuit before any download')
      }
    })

    assert.equal(result.source, 'bundled')
    assert.equal(result.path, bundled)
    assert.equal(downloadCalled, false, 'a bundled script must not trigger a network download')
    assert.ok(
      logs.some(ev => /using bundled/.test(ev.line || '')),
      'emits a "using bundled" log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(resources, { recursive: true, force: true })
  }
})

test('cnInstallEnv decouples the COS base from the mirror flag for auto-detection', () => {
  const savedFlag = process.env.HERMES_CN_MIRRORS
  const savedBase = process.env.HERMES_RUNTIME_COS_BASE

  try {
    delete process.env.HERMES_CN_MIRRORS
    delete process.env.HERMES_RUNTIME_COS_BASE

    // No opt-in, no env, no COS base -> spawn env untouched.
    assert.deepEqual(cnInstallEnv(), {})
    assert.deepEqual(cnInstallEnv({ cnMirrors: false }), {})

    // A packaged build passes runtimeCosBase WITHOUT forcing the mirror flag.
    // The COS base must still be threaded through (so install.sh's own
    // auto-detection can fetch from COS when it picks CN), and the mirror flag
    // must be OMITTED so install.sh runs its region auto-detection.
    assert.deepEqual(cnInstallEnv({ cnMirrors: false, runtimeCosBase: 'https://cos.example/runtime' }), {
      HERMES_RUNTIME_COS_BASE: 'https://cos.example/runtime'
    })

    // Caller forces CN on (e.g. an explicit user/region choice upstream).
    assert.deepEqual(cnInstallEnv({ cnMirrors: true, runtimeCosBase: 'https://cos.example/runtime' }), {
      HERMES_CN_MIRRORS: '1',
      HERMES_RUNTIME_COS_BASE: 'https://cos.example/runtime'
    })

    // Escape hatch: an explicit env flag of '0' is forwarded verbatim (install.sh
    // treats a set flag as authoritative and stays on upstream defaults without
    // probing) even when the caller opts in. The COS base still rides along.
    process.env.HERMES_CN_MIRRORS = '0'
    assert.deepEqual(cnInstallEnv({ cnMirrors: true, runtimeCosBase: 'https://cos.example/runtime' }), {
      HERMES_CN_MIRRORS: '0',
      HERMES_RUNTIME_COS_BASE: 'https://cos.example/runtime'
    })
    // ...and with no COS base, just the forwarded flag.
    delete process.env.HERMES_RUNTIME_COS_BASE
    assert.deepEqual(cnInstallEnv({ cnMirrors: true }), { HERMES_CN_MIRRORS: '0' })

    // Escape hatch: an explicit env flag of '1' forces it on and the env COS
    // base wins over a passed value.
    process.env.HERMES_CN_MIRRORS = '1'
    process.env.HERMES_RUNTIME_COS_BASE = 'https://override.example/r'
    assert.deepEqual(cnInstallEnv({ cnMirrors: false, runtimeCosBase: 'https://passed/r' }), {
      HERMES_CN_MIRRORS: '1',
      HERMES_RUNTIME_COS_BASE: 'https://override.example/r'
    })
  } finally {
    if (savedFlag === undefined) {
      delete process.env.HERMES_CN_MIRRORS
    } else {
      process.env.HERMES_CN_MIRRORS = savedFlag
    }

    if (savedBase === undefined) {
      delete process.env.HERMES_RUNTIME_COS_BASE
    } else {
      process.env.HERMES_RUNTIME_COS_BASE = savedBase
    }
  }
})

test('runtimeKeyFromStamp: prefers commit, then branch, then version; null for no stamp', () => {
  assert.equal(runtimeKeyFromStamp({ commit: SHA_A, branch: 'main', version: 'v1' }), SHA_A)
  assert.equal(runtimeKeyFromStamp({ branch: 'main', version: 'v1' }), 'main')
  assert.equal(runtimeKeyFromStamp({ version: 'v1' }), 'v1')
  assert.equal(runtimeKeyFromStamp({}), null)
  assert.equal(runtimeKeyFromStamp(null), null)
})

// ---------------------------------------------------------------------------
// hc-452: updateInfo threading. main.ts resolves {isUpdate, toVersion,
// fromVersion} BEFORE calling runBootstrap and expects it to ride along on the
// 'manifest' event unmodified, so the renderer can show "updating to vX"
// instead of "one-time install" during an opt-in runtime version update.
// Driven end-to-end against the fake install.sh stub so the threading is
// verified through the real spawn/parse path, not just a direct function call.
// ---------------------------------------------------------------------------

testManifestFlow('runBootstrap threads updateInfo through onto the manifest event (update)', async () => {
  const home = mkTmpHome()

  try {
    writeFakeInstallSh(home)
    const events = []

    const result = await runBootstrap({
      installStamp: null,
      activeRoot: path.join(home, 'hermes-agent'),
      sourceRepoRoot: home,
      hermesHome: home,
      logRoot: home,
      updateInfo: { isUpdate: true, toVersion: '2026.7.2', fromVersion: '2026.7.1' },
      onEvent: ev => events.push(ev),
      writeMarker: payload => payload
    })

    assert.equal(result.ok, true, `bootstrap should succeed against the fake stub: ${JSON.stringify(result)}`)
    const manifestEvents = events.filter(ev => ev.type === 'manifest')
    assert.equal(manifestEvents.length, 1)
    assert.deepEqual(manifestEvents[0].updateInfo, { isUpdate: true, toVersion: '2026.7.2', fromVersion: '2026.7.1' })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

testManifestFlow('runBootstrap defaults updateInfo to a first-install shape when the caller omits it', async () => {
  const home = mkTmpHome()

  try {
    writeFakeInstallSh(home)
    const events = []

    const result = await runBootstrap({
      installStamp: null,
      activeRoot: path.join(home, 'hermes-agent'),
      sourceRepoRoot: home,
      hermesHome: home,
      logRoot: home,
      // updateInfo intentionally omitted -- covers a caller (test, dev
      // shortcut, or an older code path) that hasn't been updated to pass it.
      onEvent: ev => events.push(ev),
      writeMarker: payload => payload
    })

    assert.equal(result.ok, true, `bootstrap should succeed against the fake stub: ${JSON.stringify(result)}`)
    const manifestEvents = events.filter(ev => ev.type === 'manifest')
    assert.equal(manifestEvents.length, 1)
    assert.deepEqual(manifestEvents[0].updateInfo, { isUpdate: false, toVersion: null, fromVersion: null })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

testManifestFlow('runBootstrap emits activity for raw child output before a line-framed log exists', async () => {
  const home = mkTmpHome()

  try {
    writeFakeInstallSh(home, undefined, [
      "  printf 'Downloading package without a newline' >&2",
      '  sleep 0.05',
      '  touch "$HERMES_HOME/raw-activity-delay-finished"'
    ])
    const events = []
    const activityAfterDelayFlags = []
    const delayFinishedMarker = path.join(home, 'raw-activity-delay-finished')

    const result = await runBootstrap({
      installStamp: null,
      activeRoot: path.join(home, 'hermes-agent'),
      sourceRepoRoot: home,
      hermesHome: home,
      logRoot: home,
      onEvent: ev => {
        events.push(ev)

        if (ev.type === 'activity' && ev.stage === 'complete') {
          activityAfterDelayFlags.push(fs.existsSync(delayFinishedMarker))
        }
      },
      writeMarker: payload => payload
    })

    assert.equal(result.ok, true, `bootstrap should succeed against the fake stub: ${JSON.stringify(result)}`)

    const stageStartedAt = events.findIndex(
      ev => ev.type === 'stage' && ev.name === 'complete' && ev.state === 'running'
    )

    const rawActivityAt = events.findIndex(
      (ev, index) => index > stageStartedAt && ev.type === 'activity' && ev.stage === 'complete'
    )

    const unterminatedLogAt = events.findIndex(
      ev => ev.type === 'log' && ev.stream === 'stderr' && ev.line === 'Downloading package without a newline'
    )

    assert.ok(stageStartedAt >= 0, 'the stage must enter running state')
    assert.ok(rawActivityAt > stageStartedAt, 'raw child output must publish activity while the stage is running')
    assert.equal(
      activityAfterDelayFlags[0],
      false,
      'the first stage activity must come from the unterminated bytes before the delayed JSON line exists'
    )
    assert.ok(
      unterminatedLogAt > rawActivityAt,
      'activity must arrive before the unterminated bytes flush as a log on close'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// hc-473: per-stage + bootstrap-level install-chain telemetry.
// ---------------------------------------------------------------------------

testManifestFlow('runBootstrap success: fires bootstrap+stage start/success beacons in order', async () => {
  const home = mkTmpHome()

  try {
    writeFakeInstallSh(home)
    const telemetryEvents = []

    const result = await runBootstrap({
      installStamp: { commit: SHA_A, version: '2026.7.1' },
      activeRoot: path.join(home, 'hermes-agent'),
      sourceRepoRoot: home,
      hermesHome: home,
      logRoot: home,
      appVersion: '0.17.0',
      onEvent: () => {},
      writeMarker: payload => payload,
      sendTelemetry: ev => telemetryEvents.push(ev)
    })

    assert.equal(result.ok, true, `bootstrap should succeed against the fake stub: ${JSON.stringify(result)}`)

    const expectedBase = {
      platform: normalizeDesktopPlatform(process.platform),
      arch: process.arch,
      app_version: '0.17.0',
      runtime_key: SHA_A
    }

    assert.deepEqual(telemetryEvents, [
      { ...expectedBase, stage: 'bootstrap', status: 'start' },
      { ...expectedBase, stage: 'complete', status: 'start' },
      { ...expectedBase, stage: 'complete', status: 'success' },
      { ...expectedBase, stage: 'bootstrap', status: 'success' }
    ])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

testManifestFlow(
  'runBootstrap failure: stage failure fires BOTH a per-stage AND a bootstrap-rollup failure beacon',
  async () => {
    const home = mkTmpHome()

    try {
      // The stage reports ok:false with a reason that classifies as
      // checksum_mismatch (apexnodes-telemetry classifyErrorCategory).
      writeFakeInstallSh(home, '{"ok":false,"stage":"complete","reason":"sha256 mismatch on 3 files"}')
      const telemetryEvents = []

      const result = await runBootstrap({
        installStamp: null,
        activeRoot: path.join(home, 'hermes-agent'),
        sourceRepoRoot: home,
        hermesHome: home,
        logRoot: home,
        onEvent: () => {},
        writeMarker: payload => payload,
        sendTelemetry: ev => telemetryEvents.push(ev)
      })

      assert.equal(result.ok, false)
      assert.equal(result.failedStage, 'complete')

      const stageStart = telemetryEvents.find(ev => ev.stage === 'complete' && ev.status === 'start')
      const stageFailure = telemetryEvents.find(ev => ev.stage === 'complete' && ev.status === 'failure')
      const bootstrapStart = telemetryEvents.find(ev => ev.stage === 'bootstrap' && ev.status === 'start')
      const bootstrapFailure = telemetryEvents.find(ev => ev.stage === 'bootstrap' && ev.status === 'failure')

      assert.ok(stageStart, 'the stage still fires its start beacon')
      assert.ok(stageFailure, 'the stage fires a failure beacon')
      assert.equal(stageFailure.error_code, 'complete:checksum_mismatch')
      assert.ok(bootstrapStart, 'the whole run still fires a start beacon')
      assert.ok(bootstrapFailure, 'the whole run rolls up to a bootstrap-level failure beacon too')
      assert.equal(bootstrapFailure.error_code, 'bootstrap:stage_failed:complete')
      // No bootstrap-level success beacon on a failed run.
      assert.ok(!telemetryEvents.some(ev => ev.stage === 'bootstrap' && ev.status === 'success'))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

testManifestFlow('runBootstrap: omitting sendTelemetry still succeeds (real default, network suppressed)', async () => {
  const home = mkTmpHome()

  try {
    writeFakeInstallSh(home)

    const result = await runBootstrap({
      installStamp: null,
      activeRoot: path.join(home, 'hermes-agent'),
      sourceRepoRoot: home,
      hermesHome: home,
      logRoot: home,
      onEvent: () => {},
      writeMarker: payload => payload
      // sendTelemetry intentionally omitted -- must fall back to the real
      // emitter without throwing or otherwise affecting the result. This file
      // sets APEXNODES_TELEMETRY=off, so the real emitter is a fast no-op.
    })

    assert.equal(result.ok, true, `bootstrap should succeed with no sendTelemetry override: ${JSON.stringify(result)}`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// hc-543: engine-update integrity — verify the on-disk tree reached the target
// commit BEFORE stamping the bootstrap-complete marker, so a botched .git-less
// COS update can no longer report a phantom "engine updated" success.
// ---------------------------------------------------------------------------

test('evaluateTreeIntegrity: consistent (stamp matches target) -> ok/match', () => {
  assert.deepEqual(evaluateTreeIntegrity({ treeCommit: SHA_A, targetCommit: SHA_A }), {
    ok: true,
    reason: 'match',
    treeCommit: SHA_A,
    targetCommit: SHA_A
  })
})

test('evaluateTreeIntegrity: inconsistent (stamp is a DIFFERENT commit) -> FAIL/commit_mismatch', () => {
  const r = evaluateTreeIntegrity({ treeCommit: SHA_A, targetCommit: SHA_B })

  assert.equal(r.ok, false)
  assert.equal(r.reason, 'commit_mismatch')
  assert.equal(r.treeCommit, SHA_A)
  assert.equal(r.targetCommit, SHA_B)
})

test('evaluateTreeIntegrity: git dead-end / legacy tree (no stamp) -> ok/unverifiable (fail open)', () => {
  const r = evaluateTreeIntegrity({ treeCommit: null, targetCommit: SHA_B })

  assert.equal(r.ok, true)
  assert.equal(r.reason, 'unverifiable')
})

test('evaluateTreeIntegrity: no target commit (branch pin / dev) -> ok/no_target', () => {
  const r = evaluateTreeIntegrity({ treeCommit: null, targetCommit: null })

  assert.equal(r.ok, true)
  assert.equal(r.reason, 'no_target')
})

test('evaluateTreeIntegrity: short pin stamped against a full SHA still matches (prefix-aware)', () => {
  const r = evaluateTreeIntegrity({ treeCommit: SHA_A.slice(0, 12), targetCommit: SHA_A })

  assert.equal(r.ok, true)
  assert.equal(r.reason, 'match')
})

test('evaluateTreeIntegrity: empty-string stamp never matches a real target', () => {
  // Guards against a truncated/blank stamp being treated as "matches" via a
  // vacuous prefix. Both null -> no_target (ok), but a blank stamp with a real
  // target must be unverifiable, never a false match.
  assert.equal(evaluateTreeIntegrity({ treeCommit: '', targetCommit: SHA_A }).reason, 'unverifiable')
})

test('commitKeysMatch: exact, prefix (both directions), and non-matches', () => {
  assert.equal(commitKeysMatch(SHA_A, SHA_A), true)
  assert.equal(commitKeysMatch(SHA_A, SHA_A.slice(0, 8)), true)
  assert.equal(commitKeysMatch(SHA_A.slice(0, 8), SHA_A), true)
  assert.equal(commitKeysMatch(SHA_A, SHA_B), false)
  assert.equal(commitKeysMatch(SHA_A, ''), false)
  assert.equal(commitKeysMatch(null, SHA_A), false)
  // A too-short (<7) shared prefix must NOT match — avoids collisions on stubs.
  assert.equal(commitKeysMatch('abc', 'abcdef0'), false)
})

test('readSourceCommitStamp: reads + trims the stamp, null when absent', () => {
  const dir = mkTmpHome()

  try {
    assert.equal(readSourceCommitStamp(dir), null)
    fs.writeFileSync(path.join(dir, SOURCE_COMMIT_STAMP), `  ${SHA_A}\n`)
    assert.equal(readSourceCommitStamp(dir), SHA_A)
    assert.equal(readSourceCommitStamp(null), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function seedTreeStamp(activeRoot, commit) {
  fs.mkdirSync(activeRoot, { recursive: true })

  if (commit !== null) {
    fs.writeFileSync(path.join(activeRoot, SOURCE_COMMIT_STAMP), `${commit}\n`)
  }
}

testManifestFlow(
  'runBootstrap: REFUSES the marker when the tree stamp is a different commit than the target',
  async () => {
    const home = mkTmpHome()

    try {
      writeFakeInstallSh(home)
      const activeRoot = path.join(home, 'hermes-agent')
      // Simulate the bug: every install stage "succeeds" but the repository
      // stage left the OLD tree in place (stamp still points at SHA_A) while
      // the update targets SHA_B.
      seedTreeStamp(activeRoot, SHA_A)
      let markerWritten = false
      const events = []

      const result = await runBootstrap({
        installStamp: { commit: SHA_B, version: '2026.7.15' },
        activeRoot,
        sourceRepoRoot: home,
        hermesHome: home,
        logRoot: home,
        onEvent: ev => events.push(ev),
        writeMarker: payload => {
          markerWritten = true

          return payload
        }
      })

      assert.equal(result.ok, false, `must fail closed on a stale tree: ${JSON.stringify(result)}`)
      assert.equal(result.failedStage, 'verify')
      assert.equal(markerWritten, false, 'the bootstrap-complete marker must NOT be written on a stale tree')
      assert.ok(
        events.some(ev => ev.type === 'failed' && ev.stage === 'verify'),
        'a verify-stage failed event must be emitted'
      )
      assert.ok(
        !events.some(ev => ev.type === 'complete'),
        'no complete event on a refused update'
      )
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

testManifestFlow('runBootstrap: writes the marker when the tree stamp matches the target commit', async () => {
  const home = mkTmpHome()

  try {
    writeFakeInstallSh(home)
    const activeRoot = path.join(home, 'hermes-agent')
    seedTreeStamp(activeRoot, SHA_B) // extract landed the target tree
    let marker: any = null

    const result = await runBootstrap({
      installStamp: { commit: SHA_B, version: '2026.7.15' },
      activeRoot,
      sourceRepoRoot: home,
      hermesHome: home,
      logRoot: home,
      onEvent: () => {},
      writeMarker: payload => {
        marker = payload

        return payload
      }
    })

    assert.equal(result.ok, true, `matching tree must succeed: ${JSON.stringify(result)}`)
    assert.equal(marker && marker.pinnedCommit, SHA_B, 'marker stamped with the target commit')
    assert.equal(marker && marker.version, '2026.7.15', 'marker carries the runtime version label')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

testManifestFlow(
  'runBootstrap: fails OPEN (writes marker) when the tree has no stamp — git checkout / legacy tree',
  async () => {
    const home = mkTmpHome()

    try {
      writeFakeInstallSh(home)
      const activeRoot = path.join(home, 'hermes-agent')
      seedTreeStamp(activeRoot, null) // no .hermes-source-commit (git/legacy)
      let markerWritten = false
      const events = []

      const result = await runBootstrap({
        installStamp: { commit: SHA_B, version: '2026.7.15' },
        activeRoot,
        sourceRepoRoot: home,
        hermesHome: home,
        logRoot: home,
        onEvent: ev => events.push(ev),
        writeMarker: payload => {
          markerWritten = true

          return payload
        }
      })

      assert.equal(result.ok, true, `no stamp must fail open, not brick: ${JSON.stringify(result)}`)
      assert.equal(markerWritten, true)
      assert.ok(
        events.some(ev => ev.type === 'log' && /cannot verify commit, proceeding \(fail-open\)/.test(ev.line || '')),
        'a fail-open log line must explain why verification was skipped'
      )
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

testManifestFlow(
  'runBootstrap: an all-zero fallback stamp is not a verification target (upstream non-git build)',
  async () => {
    const home = mkTmpHome()

    try {
      writeFakeInstallSh(home)
      const activeRoot = path.join(home, 'hermes-agent')
      // A real tree stamp plus the all-zero placeholder commit an upstream
      // non-git build carries: the placeholder names no tree, so comparing
      // against it would be a false mismatch that bricks the install.
      seedTreeStamp(activeRoot, SHA_A)

      const result = await runBootstrap({
        installStamp: { commit: ZERO_COMMIT, branch: 'main' },
        activeRoot,
        sourceRepoRoot: home,
        hermesHome: home,
        logRoot: home,
        onEvent: () => {},
        writeMarker: payload => payload
      })

      assert.equal(result.ok, true, `a fallback stamp must not trip the integrity gate: ${JSON.stringify(result)}`)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

// ── hc-642: the bootstrap log's cn= field ──────────────────────────────────
// HERMES_CN_MIRRORS has three states and the old renderer collapsed two of
// them: an UNSET flag printed `cn=off`, i.e. "China mirrors disabled", when it
// actually means "not forced — the installer auto-detects". cnInstallEnv omits
// the flag on purpose (see its rule #2), so UNSET is the DEFAULT state for a
// packaged build: the log lied on every ordinary install. It said cn=off on a
// mainland machine whose installer was printing "region: cn (auto-detected)".

test('hc-642: unset HERMES_CN_MIRRORS renders as auto, not off', () => {
  assert.equal(describeCnMirrorMode(undefined), 'auto')
  // The default packaged path really does leave it unset — guard the pairing so
  // the renderer and the env builder cannot drift apart.
  assert.equal(cnInstallEnv().HERMES_CN_MIRRORS, undefined)
  assert.equal(describeCnMirrorMode(cnInstallEnv().HERMES_CN_MIRRORS), 'auto')
})

test('hc-642: forced states stay distinguishable from auto', () => {
  assert.equal(describeCnMirrorMode('1'), 'forced-on')
  assert.equal(describeCnMirrorMode('0'), 'forced-off(0)')

  // Whatever it renders, a forced value must never read as "auto".
  for (const v of ['1', '0', 'true', '']) {
    assert.notEqual(describeCnMirrorMode(v), 'auto', `forced ${JSON.stringify(v)} must not read as auto`)
  }
})

test('hc-642: cnMirrors:true forces on and renders as forced-on', () => {
  assert.equal(cnInstallEnv({ cnMirrors: true }).HERMES_CN_MIRRORS, '1')
  assert.equal(describeCnMirrorMode(cnInstallEnv({ cnMirrors: true }).HERMES_CN_MIRRORS), 'forced-on')
})
