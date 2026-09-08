import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import trialPolicy from '../diagnostic-trial-policy.json' with { type: 'json' }
import {
  assertDiagnosticMacIdentity,
  assertDiagnosticPackageMetadata
} from './assert-diagnostic-trial-package.mjs'

const require = createRequire(import.meta.url)
const formalPackage = require('../package.json')
const { createDiagnosticTrialBuildConfig } = require('./diagnostic-trial-build-config.cjs')
const runtimeSourceCommit = 'a'.repeat(40)
const diagnosticBuild = createDiagnosticTrialBuildConfig({
  baseBuild: formalPackage.build,
  packageJson: formalPackage,
  runtimeSourceCommit,
  trialPolicy
})

test('diagnostic builder identity and output namespace are distinct from formal APEX', () => {
  assert.equal(formalPackage.build.appId, 'com.apexnodes.desktop')
  assert.equal(formalPackage.build.productName, 'APEX')
  assert.deepEqual(formalPackage.build.protocols, [{ name: 'APEX Protocol', schemes: ['apexnodes'] }])

  assert.equal(diagnosticBuild.appId, trialPolicy.appId)
  assert.equal(diagnosticBuild.productName, trialPolicy.productName)
  assert.equal(diagnosticBuild.executableName, trialPolicy.executableName)
  assert.equal(diagnosticBuild.artifactName, trialPolicy.artifactName)
  assert.equal(diagnosticBuild.directories.output, 'release-diagnostic-trial')
  assert.notEqual(diagnosticBuild.appId, formalPackage.build.appId)
  assert.notEqual(diagnosticBuild.productName, formalPackage.build.productName)
  assert.equal(diagnosticBuild.extraMetadata.apexnodes.desktopTrial.runtimeSourceCommit, runtimeSourceCommit)
})

test('diagnostic builder refuses a missing or abbreviated Runtime pin', () => {
  for (const candidate of ['', 'abc1234']) {
    assert.throws(
      () =>
        createDiagnosticTrialBuildConfig({
          baseBuild: formalPackage.build,
          packageJson: formalPackage,
          runtimeSourceCommit: candidate,
          trialPolicy
        }),
      /full SHA/
    )
  }
})

test('macOS and Windows diagnostic packaging declare no OS login protocol', () => {
  assert.deepEqual(diagnosticBuild.protocols, [])
  assert.equal(diagnosticBuild.mac.identity, '-')
  assert.deepEqual(diagnosticBuild.mac.extendInfo.CFBundleURLTypes, [])
  assert.deepEqual(diagnosticBuild.publish, [])
  assert.equal(diagnosticBuild.extraMetadata.build, undefined)
})

test('Windows installer and executable names stay in the diagnostic namespace', () => {
  assert.equal(diagnosticBuild.nsis.shortcutName, trialPolicy.productName)
  assert.equal(diagnosticBuild.nsis.uninstallDisplayName, trialPolicy.productName)
  assert.equal(diagnosticBuild.win.legalTrademarks, trialPolicy.productName)
  assert.equal(diagnosticBuild.executableName, trialPolicy.executableName)
})

test('packaged metadata gate accepts only the complete embedded policy and no protocol/feed', () => {
  const { build: _build, ...formalRuntimePackage } = formalPackage
  const packageJson = {
    ...formalRuntimePackage,
    ...diagnosticBuild.extraMetadata
  }
  assert.deepEqual(assertDiagnosticPackageMetadata(packageJson), {
    ...trialPolicy,
    runtimeSourceCommit
  })

  assert.throws(
    () => assertDiagnosticPackageMetadata({ ...packageJson, apexnodes: { desktopTrial: null } }),
    /embedded diagnostic policy/
  )
  const { apexnodes: _removed, ...withoutPolicy } = packageJson
  assert.throws(
    () => assertDiagnosticPackageMetadata(withoutPolicy),
    /embedded diagnostic policy/
  )
  assert.throws(
    () => assertDiagnosticPackageMetadata({ ...packageJson, build: { protocols: [{ schemes: ['apexnodes'] }] } }),
    /declares OS protocols/
  )
  assert.throws(
    () => assertDiagnosticPackageMetadata({ ...packageJson, name: formalPackage.name }),
    /package name/
  )
})

test('macOS package identity gate rejects formal identity or any URL declaration', () => {
  const info = {
    CFBundleDisplayName: trialPolicy.productName,
    CFBundleExecutable: trialPolicy.executableName,
    CFBundleIdentifier: trialPolicy.appId,
    CFBundleName: trialPolicy.productName
  }
  assert.equal(assertDiagnosticMacIdentity(info), info)
  assert.throws(
    () => assertDiagnosticMacIdentity({ ...info, CFBundleIdentifier: formalPackage.build.appId }),
    /CFBundleIdentifier/
  )
  assert.throws(
    () => assertDiagnosticMacIdentity({ ...info, CFBundleURLTypes: [{ CFBundleURLSchemes: ['apexnodes'] }] }),
    /declares URLTypes/
  )
})

test('main process resolves the diagnostic gate before writable paths and wraps the only protocol registrar', () => {
  const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const gate = mainSource.indexOf('const DESKTOP_LAUNCH = initializeDesktopLaunchEnvironment({')
  const resolvedUserData = mainSource.indexOf('const RESOLVED_USER_DATA_DIR =')
  const userDataConsumer = mainSource.indexOf("const DESKTOP_ZOOM_STATE_PATH = path.join(app.getPath('userData')")
  const policyRegistration = mainSource.indexOf(
    'registerOsLoginProtocolForPolicy(DESKTOP_LAUNCH_POLICY, () =>'
  )
  const osRegistration = mainSource.indexOf('registerApexDesktopProtocol(app, developmentLaunch)')

  assert.notEqual(gate, -1)
  assert.notEqual(resolvedUserData, -1)
  assert.notEqual(userDataConsumer, -1)
  assert.ok(gate < resolvedUserData)
  assert.ok(gate < userDataConsumer)
  assert.notEqual(policyRegistration, -1)
  assert.notEqual(osRegistration, -1)
  assert.ok(policyRegistration < osRegistration)
  assert.equal(mainSource.match(/registerApexDesktopProtocol\(app, developmentLaunch\)/g)?.length, 1)
})
