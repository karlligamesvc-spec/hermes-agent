import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import afterPack, { assertMacVersionIdentity } from './after-pack.mjs'
import { MAC_ZIP_STORED_SUFFIXES } from './assert-update-engine-stored.mjs'

const tempRoots = []

function macFixture({ infoVersion = '0.17.24', packageVersion = '0.17.24', runtimeVersion = '0.17.24' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apex-version-identity-'))
  const appOutDir = join(root, 'out')
  const contents = join(appOutDir, 'APEX.app', 'Contents')
  const packageJsonPath = join(root, 'package.json')
  tempRoots.push(root)
  mkdirSync(contents, { recursive: true })
  writeFileSync(packageJsonPath, JSON.stringify({ version: packageVersion }))
  writeFileSync(
    join(contents, 'Info.plist'),
    `<plist><dict><key>CFBundleShortVersionString</key><string>${infoVersion}</string><key>CFBundleVersion</key><string>${infoVersion}</string></dict></plist>`
  )

  return { appOutDir, packageJsonPath, productName: 'APEX', runtimeVersion }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('afterPack Windows identity gate', () => {
  it('does nothing for non-Windows packages', async () => {
    await expect(afterPack({ electronPlatformName: 'linux' })).resolves.toBeUndefined()
  })

  it('fails packaging when the Windows executable cannot be stamped', async () => {
    await expect(
      afterPack({
        electronPlatformName: 'win32',
        appOutDir: '/definitely-not-an-electron-package',
        packager: { appInfo: { productFilename: 'APEX' } }
      })
    ).rejects.toThrow(/target exe not found.*APEX\.exe/)
  })
})

describe('afterPack macOS version identity gate', () => {
  it('accepts one package/runtime/Info.plist version', () => {
    expect(assertMacVersionIdentity(macFixture())).toEqual({
      bundleVersion: '0.17.24',
      packageVersion: '0.17.24',
      runtimeVersion: '0.17.24',
      shortVersion: '0.17.24'
    })
  })

  it('rejects an Info.plist version that diverges from the runtime package', () => {
    expect(() => assertMacVersionIdentity(macFixture({ infoVersion: '0.21.0' }))).toThrow(
      /version identity mismatch/
    )
  })

  it('rejects a runtime version that diverges from package.json', () => {
    expect(() => assertMacVersionIdentity(macFixture({ runtimeVersion: '0.21.0' }))).toThrow(
      /version identity mismatch/
    )
  })
})

describe('afterPack macOS update zip seam (hc-1058)', () => {
  it('sets ZIPOPT so Info-ZIP stores the engine archive in the update zip', async () => {
    const version = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
    const { appOutDir } = macFixture({ infoVersion: version, packageVersion: version, runtimeVersion: version })
    const before = process.env.ZIPOPT

    delete process.env.ZIPOPT

    try {
      await afterPack({ electronPlatformName: 'darwin', appOutDir, packager: { appInfo: { productFilename: 'APEX', version } } })
      expect(process.env.ZIPOPT).toBe(`-n ${MAC_ZIP_STORED_SUFFIXES}`)
    } finally {
      if (before === undefined) {delete process.env.ZIPOPT} else {process.env.ZIPOPT = before}
    }
  })
})
