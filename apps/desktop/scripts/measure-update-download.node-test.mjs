import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { measureUpdateDownload } from './measure-update-download.mjs'

// hc-1058: the release readback measures a release's real download with
// electron-updater's planner; pin that it reports the changed share, not the size.
const require = createRequire(import.meta.url)
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')

function noise(seed, length) {
  const out = Buffer.alloc(length)
  for (let at = 0, n = 0; at < length; n++) at += createHash('sha256').update(`${seed}:${n}`).digest().copy(out, at)
  return out
}

test('reports the share a differential update downloads, from files or URLs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1058-measure-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const base = noise('release', 2 * 1024 * 1024)
  const next = Buffer.concat([base.subarray(0, 1_000_000), noise('patch', 30_000), base.subarray(1_000_000)])
  for (const [name, data] of [['APEX-1.0.1.zip', base], ['APEX-1.0.2.zip', next]]) {
    fs.writeFileSync(path.join(dir, name), data)
    await buildBlockMap(path.join(dir, name), 'gzip', path.join(dir, `${name}.blockmap`))
  }

  const fromFiles = await measureUpdateDownload(path.join(dir, 'APEX-1.0.1.zip.blockmap'), path.join(dir, 'APEX-1.0.2.zip.blockmap'))
  assert.equal(fromFiles.full, next.length)
  assert.ok(fromFiles.download >= 30_000 && fromFiles.download < 150_000, JSON.stringify(fromFiles))
  assert.ok(fromFiles.ranges >= 1)

  const server = http.createServer((request, response) => {
    const file = path.join(dir, path.basename(request.url))
    if (!fs.existsSync(file)) { response.writeHead(404); response.end(); return }
    response.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}`
  assert.deepEqual(await measureUpdateDownload(`${url}/APEX-1.0.1.zip.blockmap`, `${url}/APEX-1.0.2.zip.blockmap`), fromFiles)
  await assert.rejects(measureUpdateDownload(`${url}/missing.blockmap`, `${url}/APEX-1.0.2.zip.blockmap`), /HTTP 404/)
})
