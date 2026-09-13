#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import trialPolicy from '../diagnostic-trial-policy.json' with { type: 'json' }
import { assertMacPackageArchitecture } from './assert-macos-package-arch.mjs'

const require = createRequire(import.meta.url)

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

export function assertDiagnosticPackageMetadata(packageJson) {
  const metadata = packageJson?.apexnodes?.desktopTrial
  assertEqual(packageJson?.name, 'apex-diagnostic-trial', 'package name')
  assertEqual(packageJson?.productName, trialPolicy.productName, 'package productName')
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('embedded diagnostic policy must be an object')
  }
  const expectedKeys = [...Object.keys(trialPolicy), 'runtimeSourceCommit'].sort()
  assertEqual(JSON.stringify(Object.keys(metadata).sort()), JSON.stringify(expectedKeys), 'embedded diagnostic policy keys')
  for (const [key, value] of Object.entries(trialPolicy)) {
    assertEqual(metadata[key], value, `embedded diagnostic policy ${key}`)
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.runtimeSourceCommit || '')) {
    throw new Error('embedded diagnostic policy runtimeSourceCommit must be a full lowercase SHA')
  }

  const protocols = packageJson?.build?.protocols
  if (Array.isArray(protocols) && protocols.length !== 0) {
    throw new Error(`embedded build declares OS protocols: ${JSON.stringify(protocols)}`)
  }
  const publish = packageJson?.build?.publish
  if (Array.isArray(publish) && publish.length !== 0) {
    throw new Error(`embedded build declares an update feed: ${JSON.stringify(publish)}`)
  }

  return metadata
}

export function assertDiagnosticMacIdentity(info) {
  assertEqual(info.CFBundleIdentifier, trialPolicy.appId, 'CFBundleIdentifier')
  assertEqual(info.CFBundleDisplayName, trialPolicy.productName, 'CFBundleDisplayName')
  assertEqual(info.CFBundleName, trialPolicy.productName, 'CFBundleName')
  assertEqual(info.CFBundleExecutable, trialPolicy.executableName, 'CFBundleExecutable')

  const urlTypes = info.CFBundleURLTypes
  if (urlTypes !== undefined && (!Array.isArray(urlTypes) || urlTypes.length !== 0)) {
    throw new Error(`diagnostic bundle declares URLTypes: ${JSON.stringify(urlTypes)}`)
  }

  return info
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`)
  }
  return String(result.stdout).trim()
}

function readAsarPackage(asarPath) {
  const asar = require('@electron/asar')
  return JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
}

export function auditDiagnosticMacPackage({ appPath, expectedArch, expectedSourceHead }) {
  const contents = path.join(appPath, 'Contents')
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')]))
  const packageJson = readAsarPackage(path.join(contents, 'Resources', 'app.asar'))
  const installStamp = JSON.parse(
    fs.readFileSync(path.join(contents, 'Resources', 'install-stamp.json'), 'utf8')
  )

  assertDiagnosticMacIdentity(info)
  const policy = assertDiagnosticPackageMetadata(packageJson)
  assertEqual(packageJson.version, info.CFBundleShortVersionString, 'package/Info.plist version')
  assertEqual(info.CFBundleVersion, packageJson.version, 'CFBundleVersion')
  assertEqual(installStamp.commit, expectedSourceHead, 'install stamp source HEAD')
  assertEqual(installStamp.dirty, false, 'install stamp dirty flag')

  const architecture = assertMacPackageArchitecture({ appPath, expectedArch })
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const codeSignature = run('/usr/bin/codesign', ['-dvvv', appPath])

  return {
    appId: info.CFBundleIdentifier,
    appPath,
    architecture,
    codeSignature,
    executableName: info.CFBundleExecutable,
    productName: info.CFBundleDisplayName,
    protocolCount: Array.isArray(info.CFBundleURLTypes) ? info.CFBundleURLTypes.length : 0,
    runtimeSourceCommit: policy.runtimeSourceCommit,
    sourceHead: installStamp.commit,
    version: packageJson.version
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  try {
    const result = auditDiagnosticMacPackage({
      appPath: process.argv[2],
      expectedArch: process.argv[3],
      expectedSourceHead: process.argv[4]
    })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
