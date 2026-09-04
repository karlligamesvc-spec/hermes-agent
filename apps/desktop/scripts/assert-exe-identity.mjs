#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isMain } from './utils.mjs'
import { assertWindowsExeIdentity } from './windows-exe-identity.mjs'

const readVersionInfoScript = String.raw`
$ErrorActionPreference = 'Stop'
$info = (Get-Item -LiteralPath $args[0]).VersionInfo
[ordered]@{
  ProductName = $info.ProductName
  FileDescription = $info.FileDescription
  CompanyName = $info.CompanyName
  FileVersion = $info.FileVersion
  ProductVersion = $info.ProductVersion
} | ConvertTo-Json -Compress
`

function readWindowsExeIdentity(exe) {
  if (process.platform !== 'win32') {
    throw new Error('PE metadata readback must run on Windows')
  }
  if (!exe || !existsSync(exe)) {
    throw new Error(`target exe not found: ${exe}`)
  }

  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', readVersionInfoScript, exe],
    { encoding: 'utf8', windowsHide: true }
  )
  return JSON.parse(output.trim())
}

function readDesktopPackageVersion(packageJsonPath) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (!packageJson.version) {
    throw new Error(`desktop package version missing: ${packageJsonPath}`)
  }
  return packageJson.version
}

function assertPackagedExeIdentity(exe, packageJsonPath) {
  const actual = readWindowsExeIdentity(exe)
  const packageVersion = readDesktopPackageVersion(packageJsonPath)
  const expected = assertWindowsExeIdentity(actual, packageVersion)
  console.log(
    `[assert-exe-identity] verified ${exe}: ${expected.ProductName}, ${expected.CompanyName}, ${expected.FileVersion}`
  )
  return actual
}

export { assertPackagedExeIdentity, readDesktopPackageVersion, readWindowsExeIdentity }

if (isMain(import.meta.url)) {
  const exe = process.argv[2]
  const packageJsonPath = resolve(process.argv[3] || resolve(import.meta.dirname, '..', 'package.json'))
  if (!exe) {
    console.error('[assert-exe-identity] usage: assert-exe-identity.mjs <path-to-exe> [package.json]')
    process.exit(2)
  }

  try {
    assertPackagedExeIdentity(resolve(exe), packageJsonPath)
  } catch (error) {
    console.error(`[assert-exe-identity] ${error.message}`)
    process.exit(1)
  }
}
