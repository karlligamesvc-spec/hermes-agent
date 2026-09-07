/**
 * after-pack.mjs — electron-builder afterPack hook.
 *
 * Stamps the APEX icon + identity onto the packed Windows APEX.exe via
 * rcedit (delegated to set-exe-identity.mjs). This runs for EVERY packed build
 * — first install, `hermes desktop`, the installer's --update rebuild, and a
 * dev's manual `npm run pack` — so the branded exe can never silently revert
 * to the stock "Electron" icon/name (the bug when the stamp lived only in
 * install.ps1, which the update path doesn't use).
 *
 * Windows-only: rcedit edits PE resources, irrelevant on macOS/Linux where the
 * app identity comes from the bundle Info.plist / desktop entry. A stamp
 * failure rejects this hook and fails packaging: stock Electron metadata is
 * an invalid customer artifact, even when the executable would otherwise run.
 *
 * electron-builder passes a context with:
 *   - electronPlatformName: 'win32' | 'darwin' | 'linux'
 *   - appOutDir:            the unpacked app directory for this target
 *   - packager.appInfo.productFilename: the exe basename (e.g. 'APEX')
 */

import fs from 'node:fs'
import path from 'node:path'

import { stampExeIdentity } from './set-exe-identity.mjs'

function plistString(plist, key) {
  const match = plist.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]+)</string>`))

  return match?.[1]?.trim() || null
}

/** Packaging-time identity gate: Electron's runtime version comes from the
 * desktop package, while macOS exposes the two Info.plist values. Reject the
 * App before DMG creation if any of those three identities diverge. */
export function assertMacVersionIdentity({ appOutDir, productName, runtimeVersion, packageJsonPath }) {
  const packageVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
  const infoPath = path.join(appOutDir, `${productName}.app`, 'Contents', 'Info.plist')
  const plist = fs.readFileSync(infoPath, 'utf8')
  const shortVersion = plistString(plist, 'CFBundleShortVersionString')
  const bundleVersion = plistString(plist, 'CFBundleVersion')
  const versions = { packageVersion, runtimeVersion, shortVersion, bundleVersion }

  if (!packageVersion || Object.values(versions).some(version => version !== packageVersion)) {
    throw new Error(`APEX macOS version identity mismatch: ${JSON.stringify(versions)}`)
  }

  return versions
}

export default async function afterPack(context) {
  const productName = context.packager?.appInfo?.productFilename || 'APEX'
  const desktopRoot = path.resolve(import.meta.dirname, '..')

  if (context.electronPlatformName === 'darwin') {
    assertMacVersionIdentity({
      appOutDir: context.appOutDir,
      productName,
      runtimeVersion: context.packager?.appInfo?.version,
      packageJsonPath: path.join(desktopRoot, 'package.json')
    })

    return
  }

  if (context.electronPlatformName !== 'win32') {
    return
  }

  const exe = path.join(context.appOutDir, `${productName}.exe`)

  await stampExeIdentity(exe, desktopRoot)
}
