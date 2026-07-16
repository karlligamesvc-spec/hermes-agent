'use strict'

/**
 * apex-bundle-download.cjs — hc-472 P1 · F1
 *
 * HTTP Range resumable downloader for the ~0.6 GB runtime bundle archive.
 *
 * WHY (design §8 断点续传)
 * -----------------------
 * A single large object over a weak mainland-CN link breaks often; restarting
 * from byte 0 doubles both the wait and the COS egress bill. This downloader:
 *   - streams to `<dest>.part` and RESUMES with `Range: bytes=<have>-` on retry,
 *   - KEEPS the partial file across network/stream errors (only the resume
 *     offset is lost, never the bytes),
 *   - restarts cleanly if the server ignores Range (200 instead of 206),
 *   - gates on the WHOLE-archive sha256 before the caller is allowed to extract
 *     ("整包 .sha256 通过才进解压"), discarding + re-fetching a partial that
 *     fails the hash (a resumed-append corruption).
 *
 * INTEGRITY MODEL — the bundle build (scripts/build-runtime-bundle.mjs) emits
 * exactly two integrity artifacts: (1) the whole-archive sha256 (sidecar
 * `.sha256` + sibling manifest `archive.sha256`), enforced HERE before extract,
 * and (2) a per-EXTRACTED-file sha index (.runtime/files.tsv) enforced AFTER
 * extract by the bundled `verify` (see apex-bundle-install.cjs). There is no
 * per-download-chunk sha in the manifest, so chunk-granular verification is not
 * possible; the whole-archive hash is the authoritative download gate and the
 * per-file index catches any post-extract damage.
 *
 * Uses node http/https directly (electron main runs on node; undici fetch
 * ignores proxy env, which the build script also avoids). Transport is real, so
 * tests drive it against a loopback http.Server exercising genuine 200/206/416
 * Range semantics; only the backoff `sleep` is injected so retries don't wait.
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { createHash } = require('node:crypto')

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_TIMEOUT_MS = 900_000 // 15 min: a whole bundle over a slow CN link
const DEFAULT_BACKOFF_MS = 1_500

class BundleDownloadError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BundleDownloadError'
    this.code = code || 'download_failed'
  }
}

function sleepReal(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fileSizeOr0(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

function sha256File(file) {
  const h = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  try {
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

/**
 * One HTTP GET → a live response, streamed to `partPath`.
 *   - `fromOffset > 0` sends a Range header and requires a 206 (append) or, if
 *     the server ignores Range and replies 200, signals a full restart so the
 *     caller truncates the partial.
 *   - resolves {status, bytesWritten, restarted} on a clean end,
 *   - rejects (BundleDownloadError) on network/stream/status errors, leaving the
 *     partial file intact for the next resume.
 */
function fetchRange({ url, partPath, fromOffset, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new BundleDownloadError(`invalid url: ${url}`, 'invalid_url'))
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new BundleDownloadError(`unsupported protocol: ${parsed.protocol}`, 'invalid_url'))
      return
    }
    const client = parsed.protocol === 'https:' ? https : http
    const reqHeaders = { ...(headers || {}) }
    if (fromOffset > 0) reqHeaders.Range = `bytes=${fromOffset}-`

    let settled = false
    let out = null
    const fail = err => {
      // Release the write stream so its fd is closed and its flushed size is the
      // exact resume offset for the next attempt (no gap, no stuck handle).
      if (out) {
        try {
          out.destroy()
        } catch {
          void 0
        }
      }
      if (settled) return
      settled = true
      reject(err instanceof BundleDownloadError ? err : new BundleDownloadError(String(err && err.message || err), 'network_error'))
    }

    const req = client.request(parsed, { method: 'GET', headers: reqHeaders }, res => {
      const status = res.statusCode || 0
      // 416: our partial is already >= the object; caller resets and re-checks.
      if (status === 416) {
        res.resume()
        if (settled) return
        settled = true
        resolve({ status, bytesWritten: 0, restarted: true, rangeUnsatisfiable: true })
        return
      }
      if (status !== 200 && status !== 206) {
        res.resume()
        fail(new BundleDownloadError(`unexpected status ${status} for ${url}`, status >= 400 && status < 500 ? 'http_client_error' : 'http_server_error'))
        return
      }
      // Range requested but server ignored it → full body from 0: truncate.
      const restarted = fromOffset > 0 && status === 200
      const flags = restarted || fromOffset === 0 ? 'w' : 'a'
      out = fs.createWriteStream(partPath, { flags })
      let bytesWritten = 0
      res.on('data', chunk => {
        bytesWritten += chunk.length
      })
      res.on('error', fail)
      out.on('error', fail)
      out.on('finish', () => {
        if (settled) return
        settled = true
        resolve({ status, bytesWritten, restarted })
      })
      res.pipe(out)
    })
    req.on('error', fail)
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      try {
        req.destroy(new BundleDownloadError(`timeout after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`, 'timeout'))
      } catch {
        void 0
      }
    })
    req.end()
  })
}

/**
 * Download `url` → `dest` with Range resume + whole-archive sha256 gate.
 *
 * @param {object}   o
 * @param {string}   o.url
 * @param {string}   o.dest            final path (written only after sha passes)
 * @param {string}  [o.sha256]         expected whole-archive hex sha256 (gate)
 * @param {number}  [o.size]           expected byte length (early sanity)
 * @param {number}  [o.maxAttempts]
 * @param {number}  [o.timeoutMs]
 * @param {number}  [o.backoffMs]
 * @param {object}  [o.headers]
 * @param {(e:{received:number,total:number|null,attempt:number})=>void} [o.onProgress]
 * @param {(ms:number)=>Promise<void>} [o.sleep]  injected backoff (tests)
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{ok:true, path:string, bytes:number, sha256:string, attempts:number}>}
 * @throws  {BundleDownloadError}
 */
async function downloadWithResume(o) {
  const {
    url,
    dest,
    sha256: expectedSha,
    size: expectedSize,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    backoffMs = DEFAULT_BACKOFF_MS,
    headers,
    onProgress,
    sleep = sleepReal,
    log = () => {}
  } = o || {}

  if (!url) throw new BundleDownloadError('url is required', 'invalid_url')
  if (!dest) throw new BundleDownloadError('dest is required', 'invalid_dest')

  const partPath = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let have = fileSizeOr0(partPath)
    // A partial larger than the known full size can only be corruption — reset.
    if (expectedSize && have > expectedSize) {
      fs.rmSync(partPath, { force: true })
      have = 0
    }
    // Already fully downloaded on disk → skip straight to the integrity gate.
    const alreadyComplete = expectedSize && have === expectedSize

    try {
      if (!alreadyComplete) {
        log(`[bundle-download] attempt ${attempt}/${maxAttempts} from byte ${have}${expectedSize ? `/${expectedSize}` : ''}`)
        const res = await fetchRange({ url, partPath, fromOffset: have, headers, timeoutMs })
        if (res.rangeUnsatisfiable) {
          // 416 = our offset is at/after EOF, i.e. the part is already (at least)
          // complete. KEEP it and let the size+sha gate below decide — never
          // delete here (a size-unknown caller would otherwise ship an empty
          // file). A part LARGER than expected is reset at the top of the loop.
          void 0
        }
        if (onProgress) {
          const received = fileSizeOr0(partPath)
          onProgress({ received, total: expectedSize || null, attempt })
        }
      }

      // ── integrity gate ────────────────────────────────────────────────────
      const gotSize = fileSizeOr0(partPath)
      if (expectedSize && gotSize !== expectedSize) {
        throw new BundleDownloadError(`size mismatch: got ${gotSize}, expected ${expectedSize}`, 'size_mismatch')
      }
      if (expectedSha) {
        const gotSha = sha256File(partPath)
        if (gotSha.toLowerCase() !== String(expectedSha).toLowerCase()) {
          // A corrupt whole file — a resumed append went wrong. Discard so the
          // next attempt re-fetches from scratch instead of resuming garbage.
          fs.rmSync(partPath, { force: true })
          throw new BundleDownloadError(`sha256 mismatch: got ${gotSha}, expected ${expectedSha}`, 'sha_mismatch')
        }
        fs.renameSync(partPath, dest)
        log(`[bundle-download] complete: ${gotSize} bytes, sha256 verified`)
        return { ok: true, path: dest, bytes: gotSize, sha256: gotSha, attempts: attempt }
      }
      // No expected sha (caller will verify per-file post-extract): accept bytes.
      const finalSha = sha256File(partPath)
      fs.renameSync(partPath, dest)
      log(`[bundle-download] complete: ${gotSize} bytes (no expected sha to gate on)`)
      return { ok: true, path: dest, bytes: gotSize, sha256: finalSha, attempts: attempt }
    } catch (err) {
      lastErr = err instanceof BundleDownloadError ? err : new BundleDownloadError(String(err && err.message || err), 'download_failed')
      log(`[bundle-download] attempt ${attempt} failed: ${lastErr.code} — ${lastErr.message}`)
      // A 4xx (object genuinely absent / gone) will not fix itself on retry.
      if (lastErr.code === 'http_client_error' || lastErr.code === 'invalid_url' || lastErr.code === 'invalid_dest') {
        throw lastErr
      }
      if (attempt < maxAttempts) {
        await sleep(backoffMs * attempt)
      }
    }
  }
  throw lastErr || new BundleDownloadError('download failed after retries', 'download_failed')
}

module.exports = {
  BundleDownloadError,
  DEFAULT_MAX_ATTEMPTS,
  downloadWithResume,
  sha256File,
  // exported for focused tests
  fetchRange
}
