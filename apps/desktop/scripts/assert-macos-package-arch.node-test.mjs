import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import {
  assertMacPackageArchitecture,
  packageArchitectureTargets,
  parseLipoArchitectures
} from './assert-macos-package-arch.mjs'

function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), 'apex-mac-arch-'))
  const app = join(root, 'APEX.app')
  const macOS = join(app, 'Contents', 'MacOS')
  const nodePty = join(app, 'Contents', 'Resources', 'native-deps', 'node-pty', 'prebuilds', 'darwin-x64')
  const unpackedNodePty = join(
    app,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'dist',
    'node_modules',
    'node-pty',
    'prebuilds',
    'darwin-x64'
  )
  const helper = join(app, 'Contents', 'Frameworks', 'APEX Helper.app', 'Contents', 'MacOS')
  mkdirSync(macOS, { recursive: true })
  mkdirSync(nodePty, { recursive: true })
  mkdirSync(unpackedNodePty, { recursive: true })
  mkdirSync(helper, { recursive: true })
  for (const path of [
    join(macOS, 'APEX'),
    join(helper, 'APEX Helper'),
    join(nodePty, 'pty.node'),
    join(nodePty, 'spawn-helper'),
    join(unpackedNodePty, 'pty.node'),
    join(unpackedNodePty, 'spawn-helper')
  ]) {
    writeFileSync(path, 'fixture')
    chmodSync(path, 0o755)
  }
  return app
}

test('collects main, framework helper, staged and asar-unpacked architecture outlets', () => {
  const targets = packageArchitectureTargets(fakeApp())
  assert.equal(targets.length, 6)
  assert.equal(targets.filter(path => basename(path) === 'APEX').length, 1)
  assert.equal(targets.filter(path => basename(path) === 'APEX Helper').length, 1)
  assert.equal(targets.filter(path => basename(path) === 'pty.node').length, 2)
  assert.equal(targets.filter(path => basename(path) === 'spawn-helper').length, 2)
})

test('normalizes lipo architecture output', () => {
  assert.deepEqual(parseLipoArchitectures('x86_64 arm64\n'), ['x86_64', 'arm64'])
})

test('accepts a package only when every inspected binary has the requested architecture', () => {
  const result = assertMacPackageArchitecture({
    appPath: fakeApp(),
    expectedArch: 'x64',
    readArchitectures: () => ['x86_64']
  })
  assert.equal(result.expectedArch, 'x64')
  assert.equal(result.inspected.length, 6)
})

test('rejects a mislabeled x64 package whose app executable is arm64', () => {
  assert.throws(
    () =>
      assertMacPackageArchitecture({
        appPath: fakeApp(),
        expectedArch: 'x64',
        readArchitectures: path => (basename(path) === 'APEX' ? ['arm64'] : ['x86_64'])
      }),
    /expected x86_64:[\s\S]*APEX: arm64/
  )
})

test('rejects a mixed native dependency even when the main executable is correct', () => {
  assert.throws(
    () =>
      assertMacPackageArchitecture({
        appPath: fakeApp(),
        expectedArch: 'arm64',
        readArchitectures: path => (basename(path) === 'spawn-helper' ? ['x86_64'] : ['arm64'])
      }),
    /spawn-helper: x86_64/
  )
})

test('rejects universal binaries in single-architecture artifacts', () => {
  assert.throws(
    () =>
      assertMacPackageArchitecture({
        appPath: fakeApp(),
        expectedArch: 'x64',
        readArchitectures: () => ['x86_64', 'arm64']
      }),
    /APEX: x86_64, arm64/
  )
})

test('ignores executable scripts but never a non-Mach-O main executable', () => {
  const app = fakeApp()
  const script = join(app, 'Contents', 'Resources', 'helper.sh')
  writeFileSync(script, '#!/bin/sh\n')
  chmodSync(script, 0o755)

  const accepted = assertMacPackageArchitecture({
    appPath: app,
    expectedArch: 'arm64',
    readArchitectures: path => (path === script ? null : ['arm64'])
  })
  assert.equal(
    accepted.inspected.some(item => item.path === script),
    false
  )

  assert.throws(
    () =>
      assertMacPackageArchitecture({
        appPath: app,
        expectedArch: 'arm64',
        readArchitectures: path => (basename(path) === 'APEX' ? null : ['arm64'])
      }),
    /APEX: <not Mach-O>/
  )
})
