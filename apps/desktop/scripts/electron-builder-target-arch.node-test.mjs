import assert from 'node:assert/strict'
import test from 'node:test'

import { canReuseInstalledElectronDist, requestedMacTargetArch } from './electron-builder-target-arch.mjs'

test('reads the explicit macOS target architecture from electron-builder arguments', () => {
  assert.equal(requestedMacTargetArch(['--mac', 'dmg', '--arm64']), 'arm64')
  assert.equal(requestedMacTargetArch(['--mac', 'zip', '--x64']), 'x64')
  assert.equal(requestedMacTargetArch(['--mac', '--universal']), 'universal')
  assert.equal(requestedMacTargetArch(['--mac']), null)
})

test('rejects conflicting macOS target flags before packaging', () => {
  assert.throws(
    () => requestedMacTargetArch(['--mac', '--arm64', '--x64']),
    /Conflicting macOS target architecture flags: arm64, x64/
  )
})

test('foreign-architecture macOS builds never reuse the host Electron dist', () => {
  assert.equal(
    canReuseInstalledElectronDist({ args: ['--mac', '--x64'], hostArch: 'arm64', platform: 'darwin' }),
    false
  )
  assert.equal(
    canReuseInstalledElectronDist({ args: ['--mac', '--arm64'], hostArch: 'x64', platform: 'darwin' }),
    false
  )
  assert.equal(
    canReuseInstalledElectronDist({
      args: ['--mac', '--universal'],
      hostArch: 'arm64',
      platform: 'darwin'
    }),
    false
  )
})

test('same-architecture and non-macOS builds may reuse the installed Electron dist', () => {
  assert.equal(
    canReuseInstalledElectronDist({ args: ['--mac', '--arm64'], hostArch: 'arm64', platform: 'darwin' }),
    true
  )
  assert.equal(canReuseInstalledElectronDist({ args: ['--mac'], hostArch: 'arm64', platform: 'darwin' }), true)
  assert.equal(canReuseInstalledElectronDist({ args: ['--win', '--x64'], hostArch: 'arm64', platform: 'win32' }), true)
})
