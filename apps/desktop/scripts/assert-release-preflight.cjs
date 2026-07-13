'use strict'

/**
 * assert-release-preflight.cjs — hc-532 (gate 2): the pre-release CI闸 that
 * blocks a desktop build whose shell↔engine contract does not hold against LIVE
 * prod. Read-only, credential-free: it GETs /api/v1/runtime/latest and HEADs the
 * default engine tarball, then compares versions. No secrets, no writes — safe to
 * run as the first job of desktop-macos.yml / desktop-windows.yml (build `needs`
 * it, so a fail here aborts the release).
 *
 * Three assertions (A-10 recurrence guard):
 *   2a tarball reachable — /latest.cos_tarball_url HEADs 200 (the default engine
 *      package a fresh install pulls is actually downloadable).
 *   2b engine floor    — when package.json declares apexnodes.minEngineVersion,
 *      the default engine (/latest.version) is >= it. Catches "shell ships a
 *      feature whose required engine is not the published default yet" (A-10).
 *   2c desktop floor   — when /latest declares min_desktop_version, it is <= the
 *      shell version being cut (package.json version). The mirror of 2b: catches
 *      "the default engine already requires a newer shell than we're releasing"
 *      (the hc-475 axis, verified at release time instead of only at runtime).
 *
 * FAIL CLOSED, on purpose — the OPPOSITE of the runtime gate. engineMeetsMin
 * Version / desktopMeetsMinVersion fail OPEN so a garbage version can never brick
 * a user's install. A *release* gate has the opposite duty: on ambiguity
 * (unreachable prod, unparseable version on a required comparison) it BLOCKS,
 * because shipping on an un-verifiable contract is exactly the skew it exists to
 * stop. Version arithmetic itself reuses compareSemver from the runtime module,
 * so the CI闸 and the runtime gate can never drift on how a version is parsed.
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')

const { compareSemver } = require('../electron/apex-runtime-latest.cjs')

const DEFAULT_API_BASE = 'https://api.apex-nodes.com'
const LATEST_PATH = '/api/v1/runtime/latest'

/**
 * Pure release-preflight decision. No I/O — every input is passed in, so the
 * whole matrix is table-testable. Returns { ok, checks } where each check is
 * { gate, ok, skipped?, expected?, actual?, message }.
 *
 * @param {object} o
 * @param {object|null} o.latest parsed /latest body, or null when unreachable
 * @param {string|null} o.minEngineVersion package.json apexnodes.minEngineVersion (null = not declared)
 * @param {string} o.shellVersion package.json version — the release being cut
 * @param {number|null} o.tarballStatus HTTP status from HEAD cos_tarball_url (null = not attempted / no response)
 * @returns {{ ok: boolean, checks: Array<{gate:string, ok:boolean, skipped?:boolean, expected?:string, actual?:string, message:string}> }}
 */
function evaluatePreflight({ latest, minEngineVersion, shellVersion, tarballStatus }) {
  const checks = []

  // Gate 0: /latest must resolve — every other check reads from it. Unreachable
  // prod BLOCKS the release (fail closed): we cannot certify the engine contract.
  if (!latest || typeof latest !== 'object') {
    checks.push({
      gate: 'latest-reachable',
      ok: false,
      expected: 'HTTP 200 JSON from ' + LATEST_PATH,
      actual: 'no usable /latest body',
      message: 'could not reach or parse ' + LATEST_PATH + ' — cannot certify the engine contract'
    })
    return { ok: false, checks }
  }
  const latestVersion = typeof latest.version === 'string' ? latest.version : null
  checks.push({
    gate: 'latest-reachable',
    ok: true,
    message: '/latest resolved (version=' + (latestVersion || '?') + ')'
  })

  // Gate 2a: the default engine tarball a fresh install pulls must HEAD 200.
  const tarballUrl = typeof latest.cos_tarball_url === 'string' ? latest.cos_tarball_url : ''
  if (!tarballUrl) {
    checks.push({
      gate: 'tarball-head',
      ok: false,
      expected: 'cos_tarball_url present + HEAD 200',
      actual: 'cos_tarball_url absent',
      message: '/latest has no cos_tarball_url — the default engine package is not published'
    })
  } else if (tarballStatus === 200) {
    checks.push({ gate: 'tarball-head', ok: true, message: 'HEAD ' + tarballUrl + ' -> 200' })
  } else {
    checks.push({
      gate: 'tarball-head',
      ok: false,
      expected: 'HEAD 200',
      actual: String(tarballStatus == null ? 'no response' : tarballStatus),
      message: 'default engine tarball not downloadable: HEAD ' + tarballUrl + ' -> ' + (tarballStatus == null ? 'no response' : tarballStatus)
    })
  }

  // Gate 2b: default engine >= the shell's declared minimum (only when declared).
  if (!minEngineVersion) {
    checks.push({
      gate: 'engine-floor',
      ok: true,
      skipped: true,
      message: 'package.json declares no apexnodes.minEngineVersion — engine-floor check skipped'
    })
  } else {
    const cmp = compareSemver(latestVersion, minEngineVersion)
    if (cmp === null) {
      checks.push({
        gate: 'engine-floor',
        ok: false,
        expected: 'latest.version comparable to ' + minEngineVersion,
        actual: 'latest.version=' + (latestVersion || 'null'),
        message: 'cannot compare default engine version (' + (latestVersion || 'null') + ') against minEngineVersion (' + minEngineVersion + ')'
      })
    } else if (cmp >= 0) {
      checks.push({
        gate: 'engine-floor',
        ok: true,
        message: 'default engine ' + latestVersion + ' >= required minEngineVersion ' + minEngineVersion
      })
    } else {
      checks.push({
        gate: 'engine-floor',
        ok: false,
        expected: 'default engine >= ' + minEngineVersion,
        actual: latestVersion,
        message:
          'default engine ' + latestVersion + ' is BEHIND the shell-required minEngineVersion ' + minEngineVersion +
          ' — flip the default engine to the newer bundle before cutting this shell (A-10 guard)'
      })
    }
  }

  // Gate 2c: default engine's min_desktop_version <= the shell being cut (only
  // when /latest declares one). Mirror of 2b along the hc-475 axis.
  const minDesktop = typeof latest.min_desktop_version === 'string' ? latest.min_desktop_version : null
  if (!minDesktop) {
    checks.push({
      gate: 'desktop-floor',
      ok: true,
      skipped: true,
      message: '/latest declares no min_desktop_version — desktop-floor check skipped'
    })
  } else {
    const cmp = compareSemver(minDesktop, shellVersion)
    if (cmp === null) {
      checks.push({
        gate: 'desktop-floor',
        ok: false,
        expected: 'min_desktop_version comparable to shell ' + shellVersion,
        actual: 'min_desktop_version=' + minDesktop,
        message: 'cannot compare engine min_desktop_version (' + minDesktop + ') against shell version (' + shellVersion + ')'
      })
    } else if (cmp <= 0) {
      checks.push({
        gate: 'desktop-floor',
        ok: true,
        message: 'engine min_desktop_version ' + minDesktop + ' <= shell being cut ' + shellVersion
      })
    } else {
      checks.push({
        gate: 'desktop-floor',
        ok: false,
        expected: 'min_desktop_version <= ' + shellVersion,
        actual: minDesktop,
        message:
          'default engine requires desktop >= ' + minDesktop + ' but this release is ' + shellVersion +
          ' — bump the shell version before releasing (hc-475 axis)'
      })
    }
  }

  return { ok: checks.every(c => c.ok), checks }
}

// ---- thin I/O layer (only exercised by the CLI path, never by the unit test) ----

function requestStatus(method, url, { timeoutMs = 15000, redirectsLeft = 3 } = {}) {
  return new Promise(resolve => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve({ status: null, body: null })
      return
    }
    const client = parsed.protocol === 'https:' ? https : http
    const req = client.request(parsed, { method }, res => {
      const status = res.statusCode || 0
      // Follow a single hop of redirects (COS occasionally 302s signed URLs).
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        resolve(requestStatus(method, next, { timeoutMs, redirectsLeft: redirectsLeft - 1 }))
        return
      }
      if (method === 'HEAD') {
        res.resume()
        resolve({ status, body: null })
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', () => resolve({ status, body: null }))
    })
    req.on('error', () => resolve({ status: null, body: null }))
    req.setTimeout(timeoutMs, () => {
      resolve({ status: null, body: null })
      req.destroy()
    })
    req.end()
  })
}

async function fetchLatest(apiBase) {
  const url = apiBase.replace(/\/+$/, '') + LATEST_PATH
  // 3 attempts with linear backoff — absorb a transient prod hiccup so a network
  // blip doesn't spuriously block a release, but a genuine outage still fails closed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { status, body } = await requestStatus('GET', url)
    if (status === 200 && body) {
      try {
        return JSON.parse(body)
      } catch {
        /* fall through to retry */
      }
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000))
  }
  return null
}

function readPackage() {
  const pkgPath = path.join(__dirname, '..', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  return {
    shellVersion: String(pkg.version || ''),
    minEngineVersion:
      pkg.apexnodes && typeof pkg.apexnodes.minEngineVersion === 'string' && pkg.apexnodes.minEngineVersion.trim()
        ? pkg.apexnodes.minEngineVersion.trim()
        : null
  }
}

function renderLine(c) {
  const tag = c.ok ? (c.skipped ? 'SKIP' : 'PASS') : 'FAIL'
  return `[${tag}] ${c.gate}: ${c.message}`
}

async function main() {
  const apiBase = process.env.APEXNODES_API_BASE || DEFAULT_API_BASE
  const { shellVersion, minEngineVersion } = readPackage()

  console.log('== hc-532 gate 2: desktop release preflight ==')
  console.log(`shell version (release being cut): ${shellVersion || '?'}`)
  console.log(`declared apexnodes.minEngineVersion: ${minEngineVersion || '(none)'}`)
  console.log(`probing: ${apiBase}${LATEST_PATH}`)

  const latest = await fetchLatest(apiBase)
  let tarballStatus = null
  if (latest && typeof latest.cos_tarball_url === 'string' && latest.cos_tarball_url) {
    const head = await requestStatus('HEAD', latest.cos_tarball_url)
    tarballStatus = head.status
  }

  const { ok, checks } = evaluatePreflight({ latest, minEngineVersion, shellVersion, tarballStatus })
  for (const c of checks) console.log(renderLine(c))

  if (!ok) {
    console.error('\nrelease preflight FAILED — aborting the desktop build (shell↔engine contract not satisfied).')
    process.exit(1)
  }
  console.log('\nrelease preflight OK — shell↔engine contract holds against live prod.')
}

module.exports = { evaluatePreflight, DEFAULT_API_BASE, LATEST_PATH }

if (require.main === module) {
  main().catch(err => {
    console.error('release preflight crashed:', (err && err.message) || err)
    process.exit(1)
  })
}
