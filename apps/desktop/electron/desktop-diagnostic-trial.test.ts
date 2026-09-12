import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import diagnosticTrialPolicy from '../diagnostic-trial-policy.json'

import {
  canonicalizePathThroughExistingParent,
  DIAGNOSTIC_TRIAL_MARKER,
  DIAGNOSTIC_TRIAL_ROOT_ENV,
  initializeDesktopLaunchEnvironment,
  PRODUCTION_DESKTOP_IDENTITY,
  productionHermesHomeFromEnvironment,
  registerOsLoginProtocolForPolicy,
  resolveDesktopLaunchPolicy,
  runDesktopMaintenanceForPolicy,
  updatesAllowedByPolicy
} from './desktop-diagnostic-trial'

const runtimeSourceCommit = 'a'.repeat(40)
const embeddedDiagnosticPolicy = Object.freeze({ ...diagnosticTrialPolicy, runtimeSourceCommit })

function diagnosticPackageJson(metadata: unknown = embeddedDiagnosticPolicy) {
  return {
    name: 'apex-diagnostic-trial',
    productName: diagnosticTrialPolicy.productName,
    build: { appId: diagnosticTrialPolicy.appId },
    apexnodes: { desktopTrial: metadata }
  }
}

function diagnosticHarness(overrides: Record<string, unknown> = {}) {
  const root = path.resolve('/tmp/apex-hc826-trial')
  const runtimeRoot = path.resolve('/tmp/apex-hc826-runtime')
  const pythonPath = path.resolve('/tmp/apex-hc826-shared-python/bin/python')
  const modulePath = path.join(runtimeRoot, 'hermes_cli', 'main.py')
  const events: string[] = []

  const directories = new Set([
    root,
    path.join(root, 'user-data'),
    path.join(root, 'hermes-home'),
    path.join(root, 'workspace'),
    runtimeRoot
  ])

  const files = new Set([pythonPath, modulePath])

  const marker = {
    appId: diagnosticTrialPolicy.appId,
    mode: diagnosticTrialPolicy.mode,
    runtimeSourceCommit,
    schemaVersion: diagnosticTrialPolicy.schemaVersion
  }

  const dependencies = {
    additionalProtectedRoots: [] as string[],
    appDataDir: path.resolve('/tmp/app-data'),
    canonicalizePath: (candidate: string) => path.resolve(candidate),
    directoryExists: (candidate: string) => directories.has(candidate),
    env: {
      [DIAGNOSTIC_TRIAL_ROOT_ENV]: root,
      HERMES_DESKTOP_HERMES_ROOT: runtimeRoot,
      HERMES_DESKTOP_PYTHON: pythonPath
    },
    fileExists: (candidate: string) => files.has(candidate),
    homeDir: path.resolve('/tmp/home'),
    localAppDataDir: path.resolve('/tmp/local-app-data'),
    mkdirUserData: (candidate: string) => events.push(`mkdir:${candidate}`),
    packageJson: diagnosticPackageJson(),
    platform: process.platform,
    readDiagnosticMarker: (candidate: string) => {
      events.push(`marker:${candidate}`)

      return marker
    },
    readRuntimeBinding: (python: string, runtime: string) => {
      events.push(`binding:${python}:${runtime}`)

      return { modulePath }
    },
    readRuntimeCommit: (candidate: string) => {
      events.push(`commit:${candidate}`)

      return runtimeSourceCommit
    },
    runtimeAppName: 'apex-diagnostic-trial',
    setUserDataPath: (candidate: string) => events.push(`set:${candidate}`),
    ...overrides
  }

  return { dependencies, events, marker, modulePath, pythonPath, root, runtimeRoot }
}

test('formal packages keep the current APEX identity, protocol and update defaults', () => {
  const policy = resolveDesktopLaunchPolicy({ apexnodes: { minEngineVersion: 'v1' } }, { runtimeAppName: 'hermes-agent-desktop' })

  assert.deepEqual(PRODUCTION_DESKTOP_IDENTITY, {
    appId: 'com.apexnodes.desktop',
    productName: 'APEX'
  })
  assert.equal(policy.mode, 'production')
  assert.equal(policy.protocolRegistration, 'enabled')
  assert.equal(updatesAllowedByPolicy(policy), true)
})

test('diagnostic policy is package metadata, not an environment-selected mode', () => {
  assert.equal(resolveDesktopLaunchPolicy({}).mode, 'production')
  assert.equal(
    resolveDesktopLaunchPolicy(diagnosticPackageJson(), { runtimeAppName: 'apex-diagnostic-trial' }).mode,
    'isolated-diagnostic'
  )
})

test('missing, unknown, incomplete or identity-downgraded diagnostic metadata fails closed', () => {
  const diagnosticIdentityWithoutPolicy = diagnosticPackageJson()
  delete diagnosticIdentityWithoutPolicy.apexnodes.desktopTrial
  assert.equal(
    resolveDesktopLaunchPolicy(diagnosticIdentityWithoutPolicy, { runtimeAppName: 'apex-diagnostic-trial' }).mode,
    'invalid'
  )
  assert.equal(resolveDesktopLaunchPolicy(diagnosticPackageJson({ mode: 'isolated-diagnostic' })).mode, 'invalid')
  assert.equal(
    resolveDesktopLaunchPolicy(diagnosticPackageJson({ ...embeddedDiagnosticPolicy, futureField: true })).mode,
    'invalid'
  )
  assert.equal(
    resolveDesktopLaunchPolicy(
      diagnosticPackageJson({ ...embeddedDiagnosticPolicy, appId: PRODUCTION_DESKTOP_IDENTITY.appId })
    ).mode,
    'invalid'
  )
  assert.equal(
    resolveDesktopLaunchPolicy(diagnosticPackageJson(), { runtimeAppName: 'APEX' }).mode,
    'invalid'
  )
})

test('diagnostic launch validates every isolation input before the first userData write', () => {
  const { dependencies, events, pythonPath, root, runtimeRoot } = diagnosticHarness()
  const result = initializeDesktopLaunchEnvironment(dependencies)

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'isolated-diagnostic')
  assert.equal(result.pythonPath, pythonPath)
  assert.deepEqual(events, [
    `marker:${path.join(root, DIAGNOSTIC_TRIAL_MARKER)}`,
    `commit:${runtimeRoot}`,
    `binding:${pythonPath}:${runtimeRoot}`,
    `mkdir:${path.join(root, 'user-data')}`,
    `set:${path.join(root, 'user-data')}`
  ])
})

test('missing launcher root refuses without touching userData', () => {
  const { dependencies, events } = diagnosticHarness({
    env: {
      HERMES_DESKTOP_HERMES_ROOT: '/tmp/apex-hc826-runtime',
      HERMES_DESKTOP_PYTHON: '/tmp/apex-hc826-shared-python/bin/python'
    }
  })

  const result = initializeDesktopLaunchEnvironment(dependencies)

  assert.equal(result.ok, false)
  assert.equal(result.mode, 'refused')
  assert.match(result.message, /paired isolated launcher/)
  assert.deepEqual(events, [])
})

test('missing marker, wrong Runtime commit or wrong Python binding all refuse before writes', () => {
  const refusalCases = [
    diagnosticHarness({ readDiagnosticMarker: () => null }),
    diagnosticHarness({ readRuntimeCommit: () => '0'.repeat(40) }),
    diagnosticHarness({ readRuntimeBinding: () => ({ modulePath: '/tmp/unpaired/hermes_cli/main.py' }) })
  ]

  for (const harness of refusalCases) {
    assert.equal(initializeDesktopLaunchEnvironment(harness.dependencies).ok, false)
    assert.deepEqual(harness.events.filter(event => event.startsWith('mkdir:') || event.startsWith('set:')), [])
  }
})

test('shared Python is allowed only when it imports hermes_cli.main from the pinned Runtime', () => {
  const { dependencies, pythonPath, runtimeRoot } = diagnosticHarness()
  assert.equal(path.relative(runtimeRoot, pythonPath).startsWith('..'), true)

  const result = initializeDesktopLaunchEnvironment(dependencies)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'isolated-diagnostic')
  assert.equal(result.pythonPath, pythonPath)
})

test('launcher-derived HERMES_HOME is isolated while a different environment home stays protected', () => {
  const root = path.resolve('/tmp/apex-hc826-trial')
  assert.equal(
    productionHermesHomeFromEnvironment(path.join(root, 'hermes-home'), root),
    null
  )
  assert.equal(
    productionHermesHomeFromEnvironment('/tmp/existing-production-home', root),
    '/tmp/existing-production-home'
  )
})

test('canonical path overlap catches a symlink into production APEX data', () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-hc826-realpath-'))

  try {
    const productionRoot = path.join(temporaryHome, '.apexnodes')
    const launcherParent = path.join(temporaryHome, 'launcher')
    fs.mkdirSync(productionRoot)
    fs.mkdirSync(launcherParent)
    fs.symlinkSync(productionRoot, path.join(launcherParent, 'trial-link'), 'dir')

    const throughSymlink = path.join(launcherParent, 'trial-link', 'not-created-yet')

    const canonical = canonicalizePathThroughExistingParent(throughSymlink, {
      exists: fs.existsSync,
      realpath: fs.realpathSync
    })

    assert.equal(canonical, path.join(fs.realpathSync(productionRoot), 'not-created-yet'))

    const harness = diagnosticHarness()
    harness.dependencies.additionalProtectedRoots = [productionRoot]
    const directoryExists = harness.dependencies.directoryExists
    harness.dependencies.directoryExists = (candidate: string) =>
      candidate.startsWith(productionRoot) || directoryExists(candidate)
    harness.dependencies.canonicalizePath = (candidate: string) =>
      candidate.startsWith(harness.root)
        ? candidate.replace(harness.root, path.join(productionRoot, 'trial'))
        : path.resolve(candidate)
    const result = initializeDesktopLaunchEnvironment(harness.dependencies)
    assert.equal(result.ok, false)
    assert.match(result.message, /overlaps protected APEX data/)
    assert.deepEqual(harness.events.filter(event => event.startsWith('mkdir:') || event.startsWith('set:')), [])
  } finally {
    fs.rmSync(temporaryHome, { force: true, recursive: true })
  }
})

test('diagnostic protocol decision skips before the registrar can be called', () => {
  const diagnostic = resolveDesktopLaunchPolicy(diagnosticPackageJson(), {
    runtimeAppName: 'apex-diagnostic-trial'
  })

  if (diagnostic.mode === 'invalid') {
    throw new Error(diagnostic.error)
  }

  let calls = 0

  const result = registerOsLoginProtocolForPolicy(diagnostic, () => {
    calls += 1

    return true
  })

  assert.deepEqual(result, { attempted: false, registered: false })
  assert.equal(calls, 0)
  assert.equal(updatesAllowedByPolicy(diagnostic), false)
})

test('formal protocol decision still calls the registrar exactly once', () => {
  const production = resolveDesktopLaunchPolicy({})

  if (production.mode === 'invalid') {
    throw new Error(production.error)
  }

  let calls = 0

  const result = registerOsLoginProtocolForPolicy(production, () => {
    calls += 1

    return true
  })

  assert.deepEqual(result, { attempted: true, registered: true })
  assert.equal(calls, 1)
})

test('diagnostic maintenance refuses before uninstall, repair or quit side effects', async () => {
  const diagnostic = resolveDesktopLaunchPolicy(diagnosticPackageJson(), {
    runtimeAppName: 'apex-diagnostic-trial'
  })

  if (diagnostic.mode === 'invalid') {
    throw new Error(diagnostic.error)
  }

  const effects = {
    quit: 0,
    runtimeWrite: 0,
    spawn: 0,
    unlink: 0
  }

  const sideEffects = () => {
    effects.spawn += 1
    effects.unlink += 1
    effects.quit += 1
    effects.runtimeWrite += 1

    return { ok: true }
  }

  for (const operation of ['uninstall-summary', 'uninstall-run', 'bootstrap-repair']) {
    assert.deepEqual(await runDesktopMaintenanceForPolicy(diagnostic, operation, sideEffects), {
      error: 'diagnostic-trial-maintenance-disabled',
      ok: false,
      operation
    })
  }

  assert.deepEqual(effects, { quit: 0, runtimeWrite: 0, spawn: 0, unlink: 0 })

  const production = resolveDesktopLaunchPolicy({})

  if (production.mode === 'invalid') {
    throw new Error(production.error)
  }

  assert.deepEqual(
    await runDesktopMaintenanceForPolicy(production, 'uninstall-run', sideEffects),
    { ok: true }
  )
  assert.deepEqual(effects, { quit: 1, runtimeWrite: 1, spawn: 1, unlink: 1 })
})
