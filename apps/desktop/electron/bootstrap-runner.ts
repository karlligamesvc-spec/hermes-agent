/**
 * bootstrap-runner.ts
 *
 * Drives apps/desktop's first-launch install of Hermes Agent by spawning
 * scripts/install.ps1 stage-by-stage and streaming progress events back to
 * the renderer.
 *
 * Wired from electron/main.ts:
 *   import { runBootstrap }from './bootstrap-runner'
 *   const result = await runBootstrap({
 *     installStamp,        // INSTALL_STAMP from main.ts (may be null in dev)
 *     activeRoot,          // ACTIVE_HERMES_ROOT
 *     sourceRepoRoot,      // SOURCE_REPO_ROOT (for dev install.ps1 lookup)
 *     hermesHome,          // HERMES_HOME
 *     logRoot,             // HERMES_HOME/logs
 *     updateInfo,          // hc-452: {isUpdate, toVersion, fromVersion} -- caller
 *                          // resolves this from whether a runtime-pin override is
 *                          // pending (an opt-in update re-bootstrap) vs a genuine
 *                          // first install. Defaults to a first-install shape.
 *     emit: ev => {...}    // event sink (sender.send or similar)
 *   })
 *
 * Emits events with shape:
 *   { type: 'manifest',  stages: [{name, title, category, needs_user_input}, ...],
 *                        updateInfo: {isUpdate, toVersion, fromVersion} }
 *   { type: 'stage',     name, state: 'running'|'succeeded'|'skipped'|'failed',
 *                        json?, durationMs?, error? }
 *   { type: 'activity',  stage? } // throttled raw child stdout/stderr activity
 *   { type: 'log',       stage?, line, stream: 'stdout'|'stderr' } // raw line from install.ps1
 *   { type: 'complete',  marker: <written marker payload> }
 *   { type: 'failed',    stage?, error }     // bootstrap aborted
 *
 * Resolves with the same shape as the final 'complete' or 'failed' event so
 * callers can await either way.
 *
 * NOT implemented yet (deferred to Phase 1E / 1F):
 *   - User-facing retry / cancel from the renderer (event channels exist;
 *     no UI consumes them yet)
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'

import {
  buildErrorCode,
  fireTelemetry,
  normalizeDesktopPlatform,
  sendDesktopTelemetry,
  STATUS_FAILURE,
  STATUS_START,
  STATUS_SUCCESS
} from './apexnodes-telemetry'
import { hiddenWindowsChildOptions } from './windows-child-options'

const IS_WINDOWS = process.platform === 'win32'

const STAMP_COMMIT_RE = /^[0-9a-f]{7,40}$/i
const FALLBACK_COMMIT_RE = /^0{7,40}$/
const FALLBACK_BRANCH = 'main'

// hc-543: the COS extract stamps the tree's own commit here, so the desktop can
// report the ACTUAL source tree rather than whatever the bootstrap marker claims.
const SOURCE_COMMIT_STAMP = '.hermes-source-commit'

/** The commit stamped into an installed tree, or null when unstamped. */
function readSourceCommitStamp(activeRoot) {
  if (!activeRoot) {return null}

  try {
    const raw = fs.readFileSync(path.join(activeRoot, SOURCE_COMMIT_STAMP), 'utf8').trim()

    return raw || null
  } catch {
    return null
  }
}

/** Do two commit keys name the same commit, allowing an abbreviated form? */
function commitKeysMatch(a, b) {
  if (!a || !b) {return false}
  const x = String(a).trim().toLowerCase()
  const y = String(b).trim().toLowerCase()

  if (!x || !y) {return false}

  if (x === y) {return true}
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x

  if (shorter.length < 7 || !STAMP_COMMIT_RE.test(shorter)) {return false}

  return longer.startsWith(shorter)
}

// hc-543: DETERMINISTIC decision for "did the on-disk tree actually reach the
// target commit before we stamp the bootstrap-complete marker?" Pure function
// (no fs / no I/O) so the three states are unit-testable in isolation:
//
//   1. consistent  — stamp present and matches target        -> ok, 'match'
//   2. inconsistent — stamp present but a DIFFERENT commit    -> FAIL, 'commit_mismatch'
//        This is the hc-543 false-success: the repository stage silently
//        reused/failed to replace the tree, yet every stage returned ok, so
//        without this the marker would be stamped with a version the files on
//        disk are NOT. We refuse the marker; the caller rolls back to the old
//        runtime instead of reporting a phantom update.
//   3. unverifiable — no stamp, OR nothing to verify against  -> ok, fail OPEN
//        A git checkout (upstream curl|bash) and a legacy COS tree have no
//        stamp; a branch-only pin has no target commit. We must not block those
//        — after hc-543 lands, every COS extract writes the stamp, so a genuine
//        desktop update lands in state 1 or 2, and this branch only ever covers
//        installs that were never subject to the bug.
function evaluateTreeIntegrity({ treeCommit = null, targetCommit = null }: any = {}) {
  const base = { treeCommit: treeCommit || null, targetCommit: targetCommit || null }

  if (!targetCommit) {return { ok: true, reason: 'no_target', ...base }}

  if (!treeCommit) {return { ok: true, reason: 'unverifiable', ...base }}

  if (commitKeysMatch(treeCommit, targetCommit)) {return { ok: true, reason: 'match', ...base }}

  return { ok: false, reason: 'commit_mismatch', ...base }
}

function isPinnedCommit(commit) {
  return typeof commit === 'string' && STAMP_COMMIT_RE.test(commit) && !FALLBACK_COMMIT_RE.test(commit)
}

type ExecGitFn = (args: string[], cwd: string) => string
type ResolveHeadFn = (activeRoot: string | null | undefined) => string | null

/**
 * Read HEAD from a managed checkout. Used after bootstrap so fallback
 * (all-zero) install stamps still produce a marker that
 * isBootstrapComplete() accepts (pinnedCommit length >= 7).
 */
function resolveCheckoutHead(activeRoot: string | null | undefined, opts: { execGit?: ExecGitFn } = {}): string | null {
  if (!activeRoot) {
    return null
  }

  const run: ExecGitFn =
    opts.execGit ||
    ((args, cwd) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15_000,
        ...hiddenWindowsChildOptions()
      }).trim())

  try {
    const sha = run(['-c', 'windows.appendAtomically=false', 'rev-parse', 'HEAD'], activeRoot)

    return isPinnedCommit(sha) ? sha : null
  } catch {
    return null
  }
}

/** Prefer a real pin already written by install.ps1's bootstrap-marker stage. */
function readExistingPinnedCommit(activeRoot: string | null | undefined): string | null {
  if (!activeRoot) {
    return null
  }

  try {
    const raw = fs.readFileSync(path.join(activeRoot, '.hermes-bootstrap-complete'), 'utf8')
    const parsed = JSON.parse(raw)

    return parsed && isPinnedCommit(parsed.pinnedCommit) ? parsed.pinnedCommit : null
  } catch {
    return null
  }
}

/**
 * Pick the commit to store on the bootstrap-complete marker.
 * Packaged fallback stamps must NOT win (all-zero is not a real pin); after a
 * successful install the checkout's HEAD (or install.ps1's marker) does.
 */
function resolveMarkerPinnedCommit(
  installStamp: { commit?: string; branch?: string | null } | null | undefined,
  activeRoot: string | null | undefined,
  opts: { resolveHead?: ResolveHeadFn } = {}
): string | null {
  const resolveHead = opts.resolveHead || resolveCheckoutHead

  if (installStamp && isPinnedCommit(installStamp.commit)) {
    return installStamp.commit
  }

  const head = resolveHead(activeRoot)

  if (head) {
    return head
  }

  return readExistingPinnedCommit(activeRoot)
}

/**
 * Map an install stamp to the GitHub ref used to fetch install.ps1/sh.
 * Real CI/git stamps pin an immutable SHA. Non-git fallback stamps carry an
 * all-zero placeholder -- treat those as an unpinned branch ref so bootstrap
 * never asks GitHub for commit 0000000... (#50823).
 */
function installRefForStamp(installStamp) {
  if (installStamp && isPinnedCommit(installStamp.commit)) {
    return {
      ref: installStamp.commit,
      cacheKey: installStamp.commit,
      pinned: true
    }
  }

  if (installStamp && typeof installStamp.commit === 'string' && FALLBACK_COMMIT_RE.test(installStamp.commit)) {
    const ref = installStamp.branch || FALLBACK_BRANCH

    return {
      ref,
      cacheKey: `fallback-${String(ref).replace(/[^0-9A-Za-z._-]/g, '_')}`,
      pinned: false
    }
  }

  return null
}

// Stages flagged needs_user_input=true in the manifest are skipped by the
// runner (passed -NonInteractive to install.ps1, which the install script
// itself handles by emitting skipped=true frames). The renderer / 1E onboarding
// overlay takes over for those concerns (API keys, model, persona, gateway).
// We let install.ps1's own -NonInteractive logic drive this rather than
// filtering client-side -- single source of truth.

// ---------------------------------------------------------------------------
// install.ps1 source resolution
// ---------------------------------------------------------------------------

function installScriptName() {
  return process.platform === 'win32' ? 'install.ps1' : 'install.sh'
}

function installScriptKind() {
  return process.platform === 'win32' ? 'powershell' : 'posix'
}

function resolveLocalInstallScript(sourceRepoRoot) {
  if (!sourceRepoRoot) {
    return null
  }

  const candidate = path.join(sourceRepoRoot, 'scripts', installScriptName())

  try {
    fs.accessSync(candidate, fs.constants.R_OK)

    return candidate
  } catch {
    return null
  }
}

function bootstrapCacheDir(hermesHome) {
  return path.join(hermesHome, 'bootstrap-cache')
}

// The install.sh / install.ps1 that ships inside the already-installed agent
// checkout under ~/.hermes/hermes-agent. Used as a last-resort fallback when
// the pinned commit can't be fetched from GitHub (e.g. a locally-built desktop
// app stamped to an unpushed HEAD).
function installedAgentInstallScript(hermesHome) {
  if (!hermesHome) {
    return null
  }

  const candidate = path.join(hermesHome, 'hermes-agent', 'scripts', installScriptName())

  try {
    fs.accessSync(candidate, fs.constants.R_OK)

    return candidate
  } catch {
    return null
  }
}

// The install.sh / install.ps1 we ship INSIDE the packaged app via
// electron-builder's extraResources (staged from scripts/install.sh by
// scripts/stage-install-script.cjs -> process.resourcesPath/install.sh). This
// is the primary installer source for a packaged ApexNodes build: it lets a
// fresh, network-restricted (mainland-China) machine bootstrap without first
// fetching install.sh from raw.githubusercontent.com (blocked there). Absent in
// dev and in older builds that predate bundling, in which case resolution falls
// through to the GitHub download.
function bundledInstallScript(resourcesPath) {
  if (!resourcesPath) {
    return null
  }

  const candidate = path.join(resourcesPath, installScriptName())

  try {
    fs.accessSync(candidate, fs.constants.R_OK)

    return candidate
  } catch {
    return null
  }
}

// Build the extra environment handed to the install.sh / install.ps1 spawn.
//
// Two INDEPENDENT pieces, deliberately decoupled:
//
//   1. HERMES_RUNTIME_COS_BASE — the public-read COS base that hosts the runtime
//      tarball + uv binary. This is threaded through *regardless of the mirror
//      decision* so that when install.sh's OWN region auto-detection picks CN,
//      it has the COS base it needs (install.sh has no built-in default; without
//      it the CN runtime fetch silently falls back to git clone / astral.sh,
//      which are blocked in mainland China). An explicit env value wins.
//
//   2. HERMES_CN_MIRRORS — only set when the mirror region is being FORCED, via
//      either an explicit process.env.HERMES_CN_MIRRORS (ops/CI escape hatch) or
//      the caller passing cnMirrors:true. When neither forces it we OMIT the
//      flag entirely so install.sh runs its IP/timezone region auto-detection
//      (precedence rule #3 in install.sh). This is the whole point: packaged
//      desktop builds must auto-detect per machine, not statically assume China.
//
// Forwarding an explicit '0' is intentional — install.sh treats a set
// HERMES_CN_MIRRORS as authoritative (rule #1) and stays on upstream defaults
// without probing, which is what an operator who set '0' wants.
function cnInstallEnv({ cnMirrors = false, runtimeCosBase = '' }: any = {}) {
  const env: any = {}

  // COS base: env override first, then the passed value. Only include it when
  // non-empty so we never blank out an inherited value with ''.
  const base = process.env.HERMES_RUNTIME_COS_BASE != null ? process.env.HERMES_RUNTIME_COS_BASE : runtimeCosBase || ''

  if (base) {
    env.HERMES_RUNTIME_COS_BASE = base
  }

  // Mirror flag: forward an explicit env value verbatim; otherwise only force it
  // on when the caller opts in. Unset => let install.sh auto-detect the region.
  if (process.env.HERMES_CN_MIRRORS != null) {
    env.HERMES_CN_MIRRORS = process.env.HERMES_CN_MIRRORS
  } else if (cnMirrors) {
    env.HERMES_CN_MIRRORS = '1'
  }

  return env
}

/**
 * Render HERMES_CN_MIRRORS for the bootstrap log's opening line (hc-642).
 *
 * The flag has THREE states, and the old `=== '1' ? 'on' : 'off'` collapsed two
 * of them into a lie: an UNSET flag printed `cn=off`, which reads as "China
 * mirrors are disabled" when it actually means the opposite of a decision —
 * cnInstallEnv deliberately omits the flag so install.sh/install.ps1 run their
 * own region auto-detection (see rule #2 above). On the machine that motivated
 * this ticket the log said `cn=off` on every line while the installer was
 * printing "ApexNodes region: cn (auto-detected) -- using China mirrors", and
 * the log is the first thing anyone reads when an install goes wrong.
 */
function describeCnMirrorMode(value: string | undefined) {
  if (value === '1') {return 'forced-on'}

  if (value != null) {return `forced-off(${value})`}

  return 'auto'
}

function hasExistingGitCheckout(activeRoot) {
  if (!activeRoot) {
    return false
  }

  try {
    return fs.existsSync(path.join(activeRoot, '.git'))
  } catch {
    return false
  }
}

function cachedScriptPath(hermesHome, commit) {
  return path.join(bootstrapCacheDir(hermesHome), `install-${commit}.${process.platform === 'win32' ? 'ps1' : 'sh'}`)
}

function downloadInstallScript(ref, destPath) {
  // Fetch from GitHub raw at the install ref. Normal production builds pass a
  // pinned SHA (immutable). Non-git fallback builds pass an unpinned branch
  // ref so local builds can still bootstrap without pretending the all-zero
  // placeholder is a real GitHub commit.
  const scriptName = installScriptName()
  const url = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${ref}/scripts/${scriptName}`

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const tmpPath = destPath + '.tmp'
    const out = fs.createWriteStream(tmpPath)
    https
      .get(url, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // GitHub raw shouldn't redirect for a SHA URL, but follow once
          // defensively.
          out.close()
          fs.unlinkSync(tmpPath)
          https
            .get(res.headers.location, res2 => {
              if (res2.statusCode !== 200) {
                reject(
                  new Error(
                    `Failed to download ${scriptName}: HTTP ${res2.statusCode} from redirect ${res.headers.location}`
                  )
                )

                return
              }

              const out2 = fs.createWriteStream(tmpPath)
              res2.pipe(out2)
              out2.on('finish', () => {
                out2.close()
                fs.renameSync(tmpPath, destPath)
                resolve(destPath)
              })
              out2.on('error', reject)
            })
            .on('error', reject)

          return
        }

        if (res.statusCode !== 200) {
          out.close()

          try {
            fs.unlinkSync(tmpPath)
          } catch {
            void 0
          }

          reject(new Error(`Failed to download ${scriptName}: HTTP ${res.statusCode} from ${url}`))

          return
        }

        res.pipe(out)
        out.on('finish', () => {
          out.close()
          fs.renameSync(tmpPath, destPath)
          resolve(destPath)
        })
        out.on('error', err => {
          try {
            fs.unlinkSync(tmpPath)
          } catch {
            void 0
          }

          reject(err)
        })
      })
      .on('error', err => {
        try {
          fs.unlinkSync(tmpPath)
        } catch {
          void 0
        }

        reject(err)
      })
  })
}

async function resolveInstallScript({
  installStamp,
  sourceRepoRoot,
  resourcesPath,
  hermesHome,
  emit,
  _download = downloadInstallScript
}: any) {
  // 1. Dev shortcut: prefer a local checkout's installer so we can iterate
  //    without pushing. SOURCE_REPO_ROOT comes from main.ts (path.resolve
  //    of APP_ROOT/../..).
  const localScript = resolveLocalInstallScript(sourceRepoRoot)

  if (localScript) {
    emit({ type: 'log', line: `[bootstrap] using local ${installScriptName()} at ${localScript}` })

    return { path: localScript, source: 'local', kind: installScriptKind() }
  }

  // 1.5. Packaged primary: the install.sh we shipped inside the app. Used
  //      directly for fresh installs so a network-restricted (mainland-China)
  //      machine never has to reach raw.githubusercontent.com. Falls through to
  //      the GitHub download only for older builds that predate bundling.
  const bundled = bundledInstallScript(resourcesPath)

  if (bundled) {
    emit({ type: 'log', line: `[bootstrap] using bundled ${installScriptName()} at ${bundled}` })

    return { path: bundled, source: 'bundled', kind: installScriptKind() }
  }

  // 2. Packaged path: download from GitHub at the install stamp's ref.
  // Non-git fallback builds carry an all-zero commit; treat that as an
  // unpinned branch ref instead of trying to fetch a non-existent SHA.
  const installRef = installRefForStamp(installStamp)

  if (!installRef) {
    throw new Error(
      `Cannot resolve ${installScriptName()}: no SOURCE_REPO_ROOT and no install stamp. ` +
        'This packaged build was produced without a valid build-time stamp.'
    )
  }

  const cached = cachedScriptPath(hermesHome, installRef.cacheKey)
  const resolvedCommit = installRef.pinned ? installRef.ref : null

  try {
    await fsp.access(cached, fs.constants.R_OK)
    emit({
      type: 'log',
      line: `[bootstrap] using cached ${installScriptName()} for ${installRef.ref.slice(0, 12)}`
    })

    return { path: cached, source: 'cache', commit: resolvedCommit, kind: installScriptKind() }
  } catch {
    // not cached; download
  }

  emit({
    type: 'log',
    line:
      `[bootstrap] fetching ${installScriptName()} for ${installRef.ref.slice(0, 12)} from GitHub` +
      (installRef.pinned ? '' : ' (fallback, unpinned)')
  })

  try {
    await _download(installRef.ref, cached)
    emit({ type: 'log', line: `[bootstrap] saved to ${cached}` })

    return { path: cached, source: 'download', commit: resolvedCommit, kind: installScriptKind() }
  } catch (err) {
    // The pinned commit may not be fetchable from GitHub -- most commonly a
    // locally-built desktop app stamped to an unpushed HEAD (see
    // write-build-stamp.mjs fromLocalGit). Fall back to the installer that
    // ships inside the already-installed agent checkout so dev/self-builds can
    // still bootstrap instead of dying with a fatal 404.
    const installed = installedAgentInstallScript(hermesHome)

    if (installed) {
      emit({
        type: 'log',
        line:
          `[bootstrap] GitHub fetch failed (${err.message}); ` +
          `falling back to installed agent ${installScriptName()} at ${installed}`
      })

      try {
        fs.mkdirSync(path.dirname(cached), { recursive: true })
        fs.copyFileSync(installed, cached)

        return { path: cached, source: 'installed-agent', commit: resolvedCommit, kind: installScriptKind() }
      } catch {
        // Cache copy failed (read-only FS, etc.) -- use the source path directly.
        return { path: installed, source: 'installed-agent', commit: resolvedCommit, kind: installScriptKind() }
      }
    }

    throw err
  }
}

// ---------------------------------------------------------------------------
// powershell wrapper
// ---------------------------------------------------------------------------

// Canonical PowerShell 5.1 location under a Windows root (%SystemRoot%).
function powershellUnderRoot(root) {
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// Resolve the PowerShell interpreter to spawn.
//
// Spawning bare 'powershell.exe' trusts PATH to contain
// %SystemRoot%\System32\WindowsPowerShell\v1.0. On machines whose PATH was
// trimmed, truncated, or stored as a non-expanding REG_SZ (so %SystemRoot%
// never expands), that lookup fails and the spawn dies with ENOENT before
// install.ps1 ever runs — the installer stalls at "0 of 0 steps". Resolve by
// absolute path first, then fall back to PATH (powershell 5.1, then pwsh 7),
// then a bare name as a last resort.
function resolveWindowsPowerShell() {
  for (const v of ['SystemRoot', 'windir']) {
    const root = process.env[v]

    if (root) {
      const candidate = powershellUnderRoot(root)

      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        void 0
      }
    }
  }

  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)

  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, exe)

      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        void 0
      }
    }
  }

  return 'powershell.exe'
}

const BOOTSTRAP_ACTIVITY_THROTTLE_MS = 1_000

function createBootstrapActivityReporter(emit, stageName) {
  let lastEmittedAt = 0

  return () => {
    if (!emit) {
      return
    }

    const now = Date.now()

    if (lastEmittedAt && now - lastEmittedAt < BOOTSTRAP_ACTIVITY_THROTTLE_MS) {
      return
    }

    lastEmittedAt = now
    emit({ type: 'activity', stage: stageName || null })
  }
}

function spawnPowerShell(scriptPath, args, { emit, stageName, abortSignal, hermesHome, extraEnv }: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const ps = process.platform === 'win32' ? resolveWindowsPowerShell() : 'pwsh'
    const fullArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args]

    const child = spawn(
      ps,
      fullArgs,
      hiddenWindowsChildOptions({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Pass HERMES_HOME through so install.ps1 respects the caller's
          // choice rather than re-computing the default.
          HERMES_HOME: hermesHome || process.env.HERMES_HOME || '',
          // CN mirror mode + COS runtime source (empty {} when off). Spread last so
          // an explicit value here overrides any inherited process.env entry. This
          // mirrors spawnBash so install.ps1's China mirror mode activates on
          // Windows too (HERMES_CN_MIRRORS / HERMES_RUNTIME_COS_BASE).
          ...(extraEnv || {})
        }
      })
    )

    let stdout = ''
    let stderr = ''
    let killed = false

    const onAbort = () => {
      killed = true

      try {
        child.kill('SIGTERM')
      } catch {
        void 0
      }
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const reportActivity = createBootstrapActivityReporter(emit, stageName)

    // Stream stdout line-by-line so the renderer sees progress in real time.
    let stdoutBuf = ''
    child.stdout.on('data', chunk => {
      reportActivity()
      stdout += chunk
      stdoutBuf += chunk
      let nl

      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)

        if (line) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stdout' })
        }
      }
    })

    let stderrBuf = ''
    child.stderr.on('data', chunk => {
      reportActivity()
      stderr += chunk
      stderrBuf += chunk
      let nl

      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)

        if (line) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stderr' })
        }
      }
    })

    child.on('error', err => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      reject(err)
    })

    child.on('close', (code, signal) => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      // Flush any trailing bytes
      if (stdoutBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stdoutBuf, stream: 'stdout' } as any)
      }

      if (stderrBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stderrBuf, stream: 'stderr' } as any)
      }

      resolve({ stdout, stderr, code, signal, killed } as any)
    })
  })
}

function spawnBash(scriptPath, args, { emit, stageName, abortSignal, hermesHome, extraEnv }: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HERMES_HOME: hermesHome || process.env.HERMES_HOME || '',
        // CN mirror mode + COS runtime source (empty {} when off). Spread last so
        // an explicit value here overrides any inherited process.env entry.
        ...(extraEnv || {})
      }
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const onAbort = () => {
      killed = true

      try {
        child.kill('SIGTERM')
      } catch {
        void 0
      }
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const reportActivity = createBootstrapActivityReporter(emit, stageName)

    let stdoutBuf = ''
    child.stdout.on('data', chunk => {
      reportActivity()
      stdout += chunk
      stdoutBuf += chunk
      let nl

      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)

        if (line) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stdout' })
        }
      }
    })

    let stderrBuf = ''
    child.stderr.on('data', chunk => {
      reportActivity()
      stderr += chunk
      stderrBuf += chunk
      let nl

      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)

        if (line) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stderr' })
        }
      }
    })

    child.on('error', err => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      reject(err)
    })

    child.on('close', (code, signal) => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      if (stdoutBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stdoutBuf, stream: 'stdout' })
      }

      if (stderrBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stderrBuf, stream: 'stderr' })
      }

      resolve({ stdout, stderr, code, signal, killed })
    })
  })
}

// ---------------------------------------------------------------------------
// Manifest + stage dispatch
// ---------------------------------------------------------------------------

// Build the installer branch/pin args from the install stamp. The commit pin
// is fresh-install only: once a managed checkout already exists, bootstrap is
// a repair/update path and must not let an old packaged app detach the checkout
// back to the commit baked into that app. All-zero fallback stamps are never
// passed as -Commit/--commit — only the branch is used (#50823 / #50864 review).
function buildPinArgs(installStamp, { pinCommit = true } = {}) {
  const args = []

  if (pinCommit && installStamp && isPinnedCommit(installStamp.commit)) {
    args.push('-Commit', installStamp.commit)
  }

  if (installStamp && installStamp.branch) {
    args.push('-Branch', installStamp.branch)
  }

  return args
}

// hc-473: the runtime_key a bootstrap-stage beacon carries. Same priority
// order overlayStampWithPin / derivePinFromLatest (apex-runtime-latest.ts)
// already use for "the key" -- commit first (what install.sh actually keys
// the COS/git-checkout source by), then branch, then the human version label
// as a last resort so a tag-only or pre-hc-085 stamp still reports something.
function runtimeKeyFromStamp(installStamp) {
  if (!installStamp) {
    return null
  }

  return installStamp.commit || installStamp.branch || installStamp.version || null
}

function buildPosixPinArgs({ installStamp, activeRoot, hermesHome, pinCommit = true }) {
  const args = ['--dir', activeRoot, '--hermes-home', hermesHome]

  if (installStamp && installStamp.branch) {
    args.push('--branch', installStamp.branch)
  }

  if (pinCommit && installStamp && isPinnedCommit(installStamp.commit)) {
    args.push('--commit', installStamp.commit)
  }

  return args
}

async function fetchManifest({
  scriptPath,
  installerKind,
  emit,
  hermesHome,
  activeRoot,
  installStamp,
  pinCommit,
  extraEnv
}: any) {
  const isPosix = installerKind === 'posix'

  const args = isPosix
    ? ['--manifest', ...buildPosixPinArgs({ installStamp, activeRoot, hermesHome, pinCommit })]
    : ['-Manifest', ...buildPinArgs(installStamp, { pinCommit })]

  const result = await (isPosix ? spawnBash : spawnPowerShell)(scriptPath, args, {
    emit,
    stageName: '__manifest__',
    hermesHome,
    extraEnv
  })

  if (result.code !== 0) {
    throw new Error(
      `${isPosix ? 'install.sh --manifest' : 'install.ps1 -Manifest'} failed: exit ${result.code}\n${result.stderr || result.stdout}`
    )
  }

  // The manifest is the LAST JSON line on stdout (install.ps1 may print
  // banner / info lines first depending on Console.OutputEncoding effects).
  // Find the last line that parses as JSON with a `stages` field.
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])

      if (parsed && Array.isArray(parsed.stages)) {
        return parsed
      }
    } catch {
      void 0
    }
  }

  throw new Error(
    `${isPosix ? 'install.sh --manifest' : 'install.ps1 -Manifest'} produced no parseable JSON payload\n${result.stdout}`
  )
}

// Parse the JSON result frame from a stage run. The protocol guarantees
// exactly one JSON line per stage in -Json or -Stage mode (post #27224 fix
// for the double-emit bug we addressed in the install.ps1 PR).
function parseStageResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])

      if (parsed && typeof parsed.ok === 'boolean' && typeof parsed.stage === 'string') {
        return parsed
      }
    } catch {
      void 0
    }
  }

  return null
}

async function runStage({
  scriptPath,
  installerKind,
  stage,
  emit,
  hermesHome,
  activeRoot,
  abortSignal,
  installStamp,
  pinCommit,
  extraEnv,
  // hc-473: anonymous per-stage install telemetry. sendTelemetry defaults to
  // the real emitter (apexnodes-telemetry.ts) so every caller of runBootstrap
  // gets beacons for free, with zero main.ts wiring; tests override it (via
  // runBootstrap's own sendTelemetry option, threaded down to here) to capture
  // events without touching the network. telemetryBase is precomputed once by
  // runBootstrap and just carries {platform, arch, app_version, runtime_key}.
  sendTelemetry = sendDesktopTelemetry,
  telemetryBase = {}
}: any) {
  const startedAt = Date.now()
  emit({ type: 'stage', name: stage.name, state: 'running' })
  fireTelemetry(sendTelemetry, { ...telemetryBase, stage: stage.name, status: STATUS_START })

  const isPosix = installerKind === 'posix'

  const args = isPosix
    ? [
        '--stage',
        stage.name,
        '--non-interactive',
        '--json',
        ...buildPosixPinArgs({ installStamp, activeRoot, hermesHome, pinCommit })
      ]
    : ['-Stage', stage.name, '-NonInteractive', '-Json', ...buildPinArgs(installStamp, { pinCommit })]

  const result = await (isPosix ? spawnBash : spawnPowerShell)(scriptPath, args, {
    emit,
    stageName: stage.name,
    abortSignal,
    hermesHome,
    extraEnv
  })

  const durationMs = Date.now() - startedAt

  if (result.killed) {
    const ev = { type: 'stage', name: stage.name, state: 'failed', durationMs, error: 'cancelled by user' }
    emit(ev)
    fireTelemetry(sendTelemetry, {
      ...telemetryBase,
      stage: stage.name,
      status: STATUS_FAILURE,
      error_code: buildErrorCode(stage.name, ev.error)
    })

    return ev
  }

  const json = parseStageResult(result.stdout)

  if (!json) {
    const ev = {
      type: 'stage',
      name: stage.name,
      state: 'failed',
      durationMs,
      error: `${isPosix ? 'install.sh --stage' : 'install.ps1 -Stage'} ${stage.name} produced no JSON result frame (exit=${result.code})`,
      json: null
    }

    emit(ev)
    fireTelemetry(sendTelemetry, {
      ...telemetryBase,
      stage: stage.name,
      status: STATUS_FAILURE,
      error_code: buildErrorCode(stage.name, ev.error)
    })

    return ev
  }

  if (json.ok && json.skipped) {
    const ev = { type: 'stage', name: stage.name, state: 'skipped', durationMs, json }
    emit(ev)

    // No terminal beacon here on purpose: a deliberately-skipped stage (e.g. a
    // needs_user_input stage under -NonInteractive) neither succeeded nor
    // failed. The `start` beacon above already recorded that this stage was
    // reached; leaving it without a terminal is honest telemetry, not a gap.
    return ev
  }

  if (json.ok) {
    const ev = { type: 'stage', name: stage.name, state: 'succeeded', durationMs, json }
    emit(ev)
    fireTelemetry(sendTelemetry, { ...telemetryBase, stage: stage.name, status: STATUS_SUCCESS })

    return ev
  }

  const ev = {
    type: 'stage',
    name: stage.name,
    state: 'failed',
    durationMs,
    json,
    error: json.reason || `exit code ${result.code}`
  }

  emit(ev)
  fireTelemetry(sendTelemetry, {
    ...telemetryBase,
    stage: stage.name,
    status: STATUS_FAILURE,
    error_code: buildErrorCode(stage.name, ev.error)
  })

  return ev
}

// ---------------------------------------------------------------------------
// Per-run log file
// ---------------------------------------------------------------------------

function openRunLog(logRoot) {
  fs.mkdirSync(logRoot, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logRoot, `bootstrap-${ts}.log`)
  const stream = fs.createWriteStream(logPath, { flags: 'a' })

  return { path: logPath, stream }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

async function runBootstrap(opts) {
  const {
    installStamp,
    activeRoot,
    sourceRepoRoot,
    resourcesPath,
    hermesHome,
    logRoot,
    onEvent,
    abortSignal,
    cnMirrors, // true -> activate install.sh CN mirror mode (packaged ApexNodes)
    runtimeCosBase, // public-read COS base hosting the runtime tarball + uv
    writeMarker, // callback to write the bootstrap-complete marker; main.ts provides
    // hc-452: { isUpdate, toVersion, fromVersion } -- main.ts resolves this
    // BEFORE calling runBootstrap (from whether a runtime-pin override is
    // pending) and threads it through so the renderer can show "updating to
    // vX" instead of "one-time setup" on every runtime version bump, not just
    // a genuine first install. Defaults to a plain first-install shape so
    // every existing caller (tests, dev shortcuts) that doesn't pass this
    // keeps working unchanged.
    updateInfo = { isUpdate: false, toVersion: null, fromVersion: null },
    // hc-473: anonymous install-chain telemetry (apexnodes-telemetry.ts).
    // sendTelemetry defaults to the real emitter so this beacons with zero
    // main.ts wiring; tests override it to capture events without touching
    // the network. appVersion is the Electron shell's own app.getVersion().
    sendTelemetry = sendDesktopTelemetry,
    appVersion = null
  } = opts

  // Where the bundled installer lives (process.resourcesPath in a packaged
  // Electron app). Honor an explicit opt for testability; fall back to the
  // ambient Electron value.
  const resolvedResourcesPath = resourcesPath !== undefined ? resourcesPath : process.resourcesPath
  // Extra spawn env that turns on install.sh's CN mirror mode. {} when off.
  const extraEnv = cnInstallEnv({ cnMirrors, runtimeCosBase })

  // hc-473: one {platform, arch, app_version, runtime_key} shape reused by
  // every beacon this run fires -- only `stage` (and status/error_code) vary
  // per call site: 'bootstrap' for the whole-run lifecycle emitted here,
  // the manifest stage name (uv/repository/venv/...) inside runStage.
  const telemetryBase = {
    platform: normalizeDesktopPlatform(process.platform),
    arch: process.arch,
    app_version: appVersion,
    runtime_key: runtimeKeyFromStamp(installStamp)
  }

  // Bail before spawning anything if the user already cancelled — otherwise an
  // already-aborted signal would still fetch the manifest (a spawn) before the
  // in-loop abort check fires.
  if (abortSignal && abortSignal.aborted) {
    fireTelemetry(sendTelemetry, {
      ...telemetryBase,
      stage: 'bootstrap',
      status: STATUS_FAILURE,
      error_code: 'bootstrap:cancelled'
    })

    if (typeof onEvent === 'function') {
      try {
        onEvent({ type: 'failed', error: 'bootstrap cancelled by user' })
      } catch {
        void 0
      }
    }

    return { ok: false, cancelled: true }
  }

  fireTelemetry(sendTelemetry, { ...telemetryBase, stage: 'bootstrap', status: STATUS_START })

  const runLog = openRunLog(logRoot || path.join(hermesHome, 'logs'))

  // Tee every event to the runLog AND the caller's onEvent. This gives us a
  // forensic trail per bootstrap run AND lets the renderer subscribe live.
  const emit = ev => {
    try {
      runLog.stream.write(JSON.stringify(ev) + '\n')
    } catch {
      void 0
    }

    try {
      if (typeof onEvent === 'function') {
        onEvent(ev)
      }
    } catch (err) {
      // Don't let a subscriber bug crash the bootstrap
      runLog.stream.write(`emit error: ${err && err.message}\n`)
    }
  }

  emit({
    type: 'log',
    line:
      `[bootstrap] starting at ${new Date().toISOString()}; ` +
      `activeRoot=${activeRoot}; ` +
      `stamp=${installStamp ? installStamp.commit.slice(0, 12) : '<none>'}; ` +
      `cn=${describeCnMirrorMode(extraEnv.HERMES_CN_MIRRORS)}; ` +
      `runLog=${runLog.path}`
  })

  try {
    const existingCheckout = hasExistingGitCheckout(activeRoot)
    const pinCommit = !existingCheckout

    if (existingCheckout && installStamp && installStamp.commit) {
      emit({
        type: 'log',
        line:
          `[bootstrap] existing checkout detected at ${activeRoot}; ` +
          `not pinning to packaged install stamp ${installStamp.commit.slice(0, 12)}`
      })
    }

    // 1. Resolve the platform installer.
    const scriptInfo = await resolveInstallScript({
      installStamp,
      sourceRepoRoot,
      resourcesPath: resolvedResourcesPath,
      hermesHome,
      emit
    })

    const installerKind = scriptInfo.kind || 'powershell'

    // 2. Fetch manifest
    const manifest = await fetchManifest({
      scriptPath: scriptInfo.path,
      installerKind,
      emit,
      hermesHome,
      activeRoot,
      installStamp,
      pinCommit,
      extraEnv
    })

    emit({
      type: 'manifest',
      stages: manifest.stages,
      protocolVersion: manifest.protocol_version || manifest.protocolVersion || null,
      updateInfo
    })

    // 3. Iterate stages in order. Stages flagged needs_user_input are still
    //    invoked -- install.ps1's own -NonInteractive handler in those stages
    //    emits skipped=true. We trust the protocol rather than filtering
    //    client-side.
    for (const stage of manifest.stages) {
      if (abortSignal && abortSignal.aborted) {
        emit({ type: 'failed', error: 'bootstrap cancelled by user' })
        fireTelemetry(sendTelemetry, {
          ...telemetryBase,
          stage: 'bootstrap',
          status: STATUS_FAILURE,
          error_code: 'bootstrap:cancelled'
        })

        return { ok: false, cancelled: true }
      }

      const ev = await runStage({
        scriptPath: scriptInfo.path,
        installerKind,
        stage,
        emit,
        hermesHome,
        activeRoot,
        abortSignal,
        installStamp,
        pinCommit,
        extraEnv,
        sendTelemetry,
        telemetryBase
      })

      if (ev.state === 'failed') {
        emit({ type: 'failed', stage: stage.name, error: (ev as any).error || 'stage failed' })
        // Bootstrap-level rollup, IN ADDITION TO runStage's own per-stage
        // failure beacon above (deliberate double-signal, not a duplicate:
        // one answers "how far did this run get", the other "which stage").
        fireTelemetry(sendTelemetry, {
          ...telemetryBase,
          stage: 'bootstrap',
          status: STATUS_FAILURE,
          error_code: `bootstrap:stage_failed:${stage.name}`.slice(0, 120)
        })

        return { ok: false, failedStage: stage.name, error: (ev as any).error }
      }
    }

    // 3.5 hc-543: verify the on-disk tree actually reached the target commit
    //     BEFORE stamping the "install complete" marker. Every stage above can
    //     return ok while the repository stage silently reused a stale tree
    //     (a .git-less COS checkout during an opt-in update: the marker then
    //     claimed vNext but the files were still vPrev — `/cc` unknown command).
    //     The COS extract stamps the tree's commit into SOURCE_COMMIT_STAMP;
    //     read it back and refuse the marker on a positive mismatch. Absent
    //     stamp / no target commit fails OPEN (git & legacy installs).
    //
    //     Only a REAL pin is a verification target: a non-git build carries the
    //     all-zero placeholder commit, which names no tree, so comparing a
    //     genuine stamp against it would be a false mismatch.
    const targetCommit = installStamp && isPinnedCommit(installStamp.commit) ? installStamp.commit : null
    const treeCommit = readSourceCommitStamp(activeRoot)
    const integrity = evaluateTreeIntegrity({ treeCommit, targetCommit })

    if (!integrity.ok) {
      const detail =
        `on-disk source is '${treeCommit || 'unknown'}' but the update targets ` +
        `'${targetCommit}' — the repository stage did not replace the tree. ` +
        'Not stamping the complete marker; keeping the previous runtime.'

      emit({ type: 'failed', stage: 'verify', error: detail })
      fireTelemetry(sendTelemetry, {
        ...telemetryBase,
        stage: 'bootstrap',
        status: STATUS_FAILURE,
        error_code: 'bootstrap:stage_failed:verify'
      })

      return { ok: false, failedStage: 'verify', error: detail }
    }

    if (integrity.reason === 'unverifiable') {
      emit({
        type: 'log',
        line:
          `[bootstrap] tree-integrity check: no ${SOURCE_COMMIT_STAMP} stamp on ${activeRoot} ` +
          `(git checkout or legacy tree) — cannot verify commit, proceeding (fail-open)`
      })
    }

    // 4. Write the bootstrap-complete marker. Fallback (all-zero) stamps are
    // not real pins -- resolve HEAD from the checkout we just installed so
    // isBootstrapComplete() (pinnedCommit.length >= 7) accepts the marker
    // instead of re-running bootstrap on every launch (#50823 review).
    const pinnedCommit = resolveMarkerPinnedCommit(installStamp, activeRoot)

    if (!pinnedCommit) {
      emit({
        type: 'log',
        line:
          '[bootstrap] WARNING: could not resolve a real pinnedCommit for the ' +
          'bootstrap-complete marker; subsequent launches may re-run bootstrap'
      })
    } else if (installStamp && !isPinnedCommit(installStamp.commit)) {
      emit({
        type: 'log',
        line: `[bootstrap] fallback stamp resolved marker pin to ${pinnedCommit.slice(0, 12)} from checkout`
      })
    }

    const markerPayload = {
      pinnedCommit,
      pinnedBranch: installStamp ? installStamp.branch : null,
      // Runtime version label, when the caller threaded it onto the stamp (R4/R5).
      version: installStamp ? installStamp.version || null : null
    }

    const marker = typeof writeMarker === 'function' ? writeMarker(markerPayload) : markerPayload
    emit({ type: 'complete', marker })
    fireTelemetry(sendTelemetry, { ...telemetryBase, stage: 'bootstrap', status: STATUS_SUCCESS })

    return { ok: true, marker }
  } catch (err) {
    emit({ type: 'failed', error: err.message || String(err) })
    fireTelemetry(sendTelemetry, {
      ...telemetryBase,
      stage: 'bootstrap',
      status: STATUS_FAILURE,
      error_code: buildErrorCode('bootstrap', err)
    })

    return { ok: false, error: err.message || String(err) }
  } finally {
    try {
      runLog.stream.end()
    } catch {
      void 0
    }
  }
}

export {
  buildPinArgs,
  buildPosixPinArgs,
  bundledInstallScript,
  cachedScriptPath,
  cnInstallEnv,
  commitKeysMatch,
  describeCnMirrorMode,
  // hc-543: update-integrity primitives (also consumed by main.ts for the
  // truthful engine-version IPC).
  evaluateTreeIntegrity,
  hasExistingGitCheckout,
  installedAgentInstallScript,
  installRefForStamp,
  isPinnedCommit,
  // Exposed for testability
  parseStageResult,
  readSourceCommitStamp,
  resolveCheckoutHead,
  resolveInstallScript,
  resolveLocalInstallScript,
  resolveMarkerPinnedCommit,
  runBootstrap,
  runtimeKeyFromStamp,
  SOURCE_COMMIT_STAMP
}
