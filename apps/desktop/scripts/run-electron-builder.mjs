// Resolve electronDist at runtime (#38673, #47917): electron-builder 26.8.x can
// re-unpack a broken Electron.app; reusing the installed dist dodges that.
// npm workspace hoisting is non-deterministic — require.resolve finds electron
// wherever it landed. Reuse is safe only when the requested macOS target
// matches the host architecture; foreign-arch builds must fetch the matching
// Electron distribution via @electron/get.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

import {
  canReuseInstalledElectronDist,
  requestedMacTargetArch,
} from "./electron-builder-target-arch.mjs"

const require = createRequire(import.meta.url)

function electronDistDir() {
  try {
    return path.join(path.dirname(require.resolve("electron/package.json")), "dist")
  } catch {
    return null
  }
}

function distBinary(dist) {
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
  }
  if (process.platform === "win32") {
    return path.join(dist, "electron.exe")
  }
  return path.join(dist, "electron")
}

function electronBuilderCli() {
  const pkgJson = require.resolve("electron-builder/package.json")
  const bin = require(pkgJson).bin
  const rel = typeof bin === "string" ? bin : bin["electron-builder"]
  return path.join(path.dirname(pkgJson), rel)
}

const dist = electronDistDir()
const forwardedArgs = process.argv.slice(2)
const args = []
const reuseInstalledDist = canReuseInstalledElectronDist({
  args: forwardedArgs,
  hostArch: process.arch,
  platform: process.platform,
})
if (dist && fs.existsSync(distBinary(dist)) && reuseInstalledDist) {
  args.push(`-c.electronDist=${dist}`)
} else if (dist && fs.existsSync(distBinary(dist)) && !reuseInstalledDist) {
  const targetArch = requestedMacTargetArch(forwardedArgs)
  console.warn(
    `[run-electron-builder] installed Electron is ${process.arch}, target is ${targetArch}; ` +
      "electron-builder will fetch the target-architecture Electron distribution."
  )
} else {
  console.warn(
    "[run-electron-builder] no local electron dist; electron-builder will fetch " +
      "via @electron/get (electronVersion + ELECTRON_MIRROR)."
  )
}
args.push(...forwardedArgs)

const result = spawnSync(process.execPath, [electronBuilderCli(), ...args], {
  stdio: "inherit",
})
if (result.error) {
  console.error(`[run-electron-builder] spawn failed: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status == null ? 1 : result.status)
