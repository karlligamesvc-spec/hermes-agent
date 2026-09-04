import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertWindowsExeIdentity,
  packageVersionToPeVersion,
  windowsExeIdentity
} from './windows-exe-identity.mjs'

const packageVersion = '0.17.24'
const expected = windowsExeIdentity(packageVersion)

test('Windows executable identity is derived from the Desktop package version', () => {
  assert.deepEqual(expected, {
    ProductName: 'APEX',
    FileDescription: 'APEX',
    CompanyName: 'ApexNodes HK',
    FileVersion: '0.17.24.0',
    ProductVersion: '0.17.24.0',
    LegalCopyright: 'Copyright (c) 2026 ApexNodes HK'
  })
  assert.equal(packageVersionToPeVersion('1.2.3-beta.4'), '1.2.3.0')
  assert.throws(() => packageVersionToPeVersion('Electron 40.10.2'), /not valid semver/)
})

test('the shipping validator accepts the exact APEX identity', () => {
  assert.deepEqual(assertWindowsExeIdentity(expected, packageVersion), expected)
})

test('the shipping validator rejects an injected Hermes product identity', () => {
  assert.throws(
    () => assertWindowsExeIdentity({ ...expected, ProductName: 'Hermes' }, packageVersion),
    /ProductName.*Hermes/
  )
})

test('the shipping validator rejects an injected Nous Research company identity', () => {
  assert.throws(
    () => assertWindowsExeIdentity({ ...expected, CompanyName: 'Nous Research' }, packageVersion),
    /CompanyName.*Nous Research/
  )
})

test('the shipping validator rejects injected Electron file and product versions', () => {
  assert.throws(
    () =>
      assertWindowsExeIdentity(
        { ...expected, FileVersion: '40.10.2.0', ProductVersion: '40.10.2.0' },
        packageVersion
      ),
    /FileVersion.*40\.10\.2\.0[\s\S]*ProductVersion.*40\.10\.2\.0/
  )
})
