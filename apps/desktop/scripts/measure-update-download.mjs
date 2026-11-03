// hc-1058: how much an installed shell downloads to move between two releases.
//
// Feeds electron-updater's own download planner the two published blockmaps,
// exactly as a differential update would, so the release readback can record the
// real cost of a release instead of the package size. A patch release (0.17.x)
// is expected to stay small; a minor release (0.18.0) may legitimately be large.
//
// usage: node scripts/measure-update-download.mjs <old .blockmap file or URL> <new .blockmap file or URL>
//   e.g. B=https://<cos>/desktop/mac-arm64
//        node scripts/measure-update-download.mjs $B/APEX-0.17.63-mac-arm64.zip.blockmap $B/APEX-0.17.64-mac-arm64.zip.blockmap

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)

async function readBlockMap(source) {
  let bytes
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    bytes = fs.readFileSync(source)
  }
  return JSON.parse(zlib.gunzipSync(bytes).toString('utf8'))
}

/** { full, download, percent, ranges } for moving from `before` to `after` (parsed blockmaps). */
export function plannedDownload(before, after) {
  const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder')
  const operations = computeOperations(before, after, { info() {}, warn() {}, error() {}, debug() {} })
  const downloads = operations.filter(operation => operation.kind === OperationKind.DOWNLOAD)
  const download = downloads.reduce((sum, operation) => sum + operation.end - operation.start, 0)
  const full = after.files[0].sizes.reduce((sum, size) => sum + size, 0)
  return { full, download, percent: Math.round((1000 * download) / full) / 10, ranges: downloads.length }
}

export async function measureUpdateDownload(oldSource, newSource) {
  return plannedDownload(await readBlockMap(oldSource), await readBlockMap(newSource))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [oldSource, newSource] = process.argv.slice(2)
  if (!oldSource || !newSource) {
    console.error('usage: measure-update-download.mjs <old .blockmap file or URL> <new .blockmap file or URL>')
    process.exitCode = 2
  } else {
    measureUpdateDownload(oldSource, newSource)
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(error.message); process.exitCode = 1 })
  }
}
