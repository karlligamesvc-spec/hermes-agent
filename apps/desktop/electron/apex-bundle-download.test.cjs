'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createHash } = require('node:crypto')

const { downloadWithResume, BundleDownloadError } = require('./apex-bundle-download.cjs')

// Deterministic payload (not random — no fake fuzzing). Range semantics are
// exercised against a REAL loopback http server, so this is genuine transport.
const BODY = Buffer.from('ApexNodes-runtime-bundle-'.repeat(4096)) // ~100 KiB
const BODY_SHA = createHash('sha256').update(BODY).digest('hex')

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hb-dl-'))
}
function rm(d) {
  fs.rmSync(d, { recursive: true, force: true })
}
const noSleep = () => Promise.resolve()

/**
 * Start a loopback server with a scripted per-request behaviour.
 * `handler(req, res, count)` fully owns the response.
 */
function startServer(handler) {
  return new Promise(resolve => {
    let count = 0
    const server = http.createServer((req, res) => {
      count += 1
      handler(req, res, count)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}/bundle.tar.gz`, close: () => new Promise(r => server.close(r)) })
    })
  })
}

/** Serve a byte range honoring `Range: bytes=start-` → 206 + Content-Range. */
function serveRange(req, res, body) {
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d+)-/.exec(range)
    const start = m ? Number(m[1]) : 0
    if (start >= body.length) {
      // Real COS behaviour: offset at/after EOF → 416 Range Not Satisfiable.
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` })
      res.end()
      return
    }
    const slice = body.subarray(start)
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
      'Content-Length': String(slice.length)
    })
    res.end(slice)
  } else {
    res.writeHead(200, { 'Content-Length': String(body.length) })
    res.end(body)
  }
}

test('downloadWithResume: clean download passes the sha256 gate', async () => {
  const dir = mkTmp()
  const { url, close } = await startServer((req, res) => serveRange(req, res, BODY))
  try {
    const dest = path.join(dir, 'bundle.tar.gz')
    const r = await downloadWithResume({ url, dest, sha256: BODY_SHA, size: BODY.length, sleep: noSleep })
    assert.equal(r.ok, true)
    assert.equal(r.bytes, BODY.length)
    assert.equal(r.sha256, BODY_SHA)
    assert.equal(r.attempts, 1)
    assert.ok(fs.existsSync(dest))
    assert.equal(fs.existsSync(dest + '.part'), false, '.part cleaned up on success')
  } finally {
    await close()
    rm(dir)
  }
})

test('downloadWithResume: a mid-stream drop is resumed via Range (partial kept)', async () => {
  const dir = mkTmp()
  const half = Math.floor(BODY.length / 2)
  const { url, close } = await startServer((req, res, count) => {
    if (count === 1) {
      // Simulate a network drop after ~half: promise the full length, send part,
      // then destroy the socket. The client keeps whatever it flushed.
      res.writeHead(200, { 'Content-Length': String(BODY.length) })
      res.write(BODY.subarray(0, half))
      setImmediate(() => res.socket.destroy())
      return
    }
    serveRange(req, res, BODY) // 2nd attempt honors Range from the resume offset
  })
  try {
    const dest = path.join(dir, 'bundle.tar.gz')
    const r = await downloadWithResume({ url, dest, sha256: BODY_SHA, size: BODY.length, sleep: noSleep })
    assert.equal(r.ok, true)
    assert.equal(r.sha256, BODY_SHA)
    assert.ok(r.attempts >= 2, 'took at least one resume')
  } finally {
    await close()
    rm(dir)
  }
})

test('downloadWithResume: server ignoring Range (200) restarts cleanly', async () => {
  const dir = mkTmp()
  const half = Math.floor(BODY.length / 2)
  const { url, close } = await startServer((req, res, count) => {
    if (count === 1) {
      res.writeHead(200, { 'Content-Length': String(BODY.length) })
      res.write(BODY.subarray(0, half))
      setImmediate(() => res.socket.destroy())
      return
    }
    // 2nd attempt: client sends Range, but server sends the WHOLE body as 200.
    res.writeHead(200, { 'Content-Length': String(BODY.length) })
    res.end(BODY)
  })
  try {
    const dest = path.join(dir, 'bundle.tar.gz')
    const r = await downloadWithResume({ url, dest, sha256: BODY_SHA, size: BODY.length, sleep: noSleep })
    assert.equal(r.ok, true)
    assert.equal(r.sha256, BODY_SHA, 'truncate+restart yields an intact file, not a doubled one')
  } finally {
    await close()
    rm(dir)
  }
})

test('downloadWithResume: sha mismatch discards the file and fails', async () => {
  const dir = mkTmp()
  const { url, close } = await startServer((req, res) => serveRange(req, res, BODY))
  try {
    const dest = path.join(dir, 'bundle.tar.gz')
    await assert.rejects(
      downloadWithResume({ url, dest, sha256: 'deadbeef'.repeat(8), size: BODY.length, maxAttempts: 2, sleep: noSleep }),
      err => {
        assert.ok(err instanceof BundleDownloadError)
        assert.equal(err.code, 'sha_mismatch')
        return true
      }
    )
    assert.equal(fs.existsSync(dest), false, 'never promotes a bad file to dest')
    assert.equal(fs.existsSync(dest + '.part'), false, 'corrupt partial discarded')
  } finally {
    await close()
    rm(dir)
  }
})

test('downloadWithResume: a 404 fails fast without exhausting retries', async () => {
  const dir = mkTmp()
  let hits = 0
  const { url, close } = await startServer((req, res) => {
    hits += 1
    res.writeHead(404)
    res.end('nope')
  })
  try {
    const dest = path.join(dir, 'bundle.tar.gz')
    await assert.rejects(
      downloadWithResume({ url, dest, sha256: BODY_SHA, maxAttempts: 5, sleep: noSleep }),
      err => {
        assert.equal(err.code, 'http_client_error')
        return true
      }
    )
    assert.equal(hits, 1, '4xx is not retried (object genuinely absent)')
  } finally {
    await close()
    rm(dir)
  }
})

test('downloadWithResume: a 416 at EOF keeps the (complete) part and passes the sha gate', async () => {
  const dir = mkTmp()
  const { url, close } = await startServer((req, res) => serveRange(req, res, BODY))
  try {
    const dest = path.join(dir, 'bundle.tar.gz')
    // Complete correct partial, but NO expected size → the loop can't short-
    // circuit, so it issues Range: bytes=<len>- and the server answers 416. The
    // part must be kept (not wiped to an empty file) and pass the sha gate.
    fs.writeFileSync(dest + '.part', BODY)
    const r = await downloadWithResume({ url, dest, sha256: BODY_SHA, sleep: noSleep })
    assert.equal(r.ok, true)
    assert.equal(r.bytes, BODY.length)
    assert.equal(r.sha256, BODY_SHA)
  } finally {
    await close()
    rm(dir)
  }
})

test('downloadWithResume: an already-complete .part is accepted via the gate only', async () => {
  const dir = mkTmp()
  let hits = 0
  const { url, close } = await startServer((req, res) => {
    hits += 1
    serveRange(req, res, BODY)
  })
  try {
    const dest = path.join(dir, 'bundle.tar.gz')
    // Pre-seed a complete, correct partial: the downloader should NOT hit the net.
    fs.writeFileSync(dest + '.part', BODY)
    const r = await downloadWithResume({ url, dest, sha256: BODY_SHA, size: BODY.length, sleep: noSleep })
    assert.equal(r.ok, true)
    assert.equal(hits, 0, 'complete partial short-circuits the network entirely')
  } finally {
    await close()
    rm(dir)
  }
})
