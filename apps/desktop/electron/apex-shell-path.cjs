/**
 * apex-shell-path.cjs
 *
 * hc-544: PATH augmentation for the GUI-launched desktop app.
 *
 * ── Root cause (real-machine取证 2026-07-16) ────────────────────────────────
 * A macOS app launched from Finder/Dock/launchd inherits a *minimal* PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — it does NOT source the user's shell rc, so
 * it misses `~/.local/bin` (the npm-global / official-installer target for
 * `claude` and `codex`), nvm/volta/fnm shims, and Homebrew. The desktop spawns
 * the Python backend / messaging gateway with this PATH, and the coding-agent
 * harness inside it spawns `claude`/`codex` by bare name: CPython resolves the
 * bare argv[0] against the *child* env's PATH, so the spawn `FileNotFoundError`s
 * and the IM 直通 reports "Claude Code 未接入". PM's stop-gap was a symlink into
 * ~/.apexnodes/node/bin, which an engine update wipes — not a root fix.
 *
 * ── Fix (fix-path pattern + static floor) ───────────────────────────────────
 * main.cjs augments THIS process's PATH once at boot (before any child spawn) so
 * every downstream spawn inherits a usable PATH. Two composed sources:
 *   1. The user's *login-shell* PATH, probed via `$SHELL -lic 'echo $PATH'`
 *      (captures nvm/fnm/asdf/pyenv and any custom rc PATH edits). Best-effort,
 *      hard-timeout, trusted verbatim when it returns.
 *   2. A static floor of common user bin dirs (`~/.local/bin`, `~/.npm-global/bin`,
 *      `~/bin`, `~/.volta/bin`, Homebrew) — existence-filtered — so a failed /
 *      timed-out probe still resolves the documented `~/.local/bin` case.
 * Append-only + de-duplicated: inherited entries keep their precedence, so
 * system-tool and python resolution are unchanged.
 *
 * Standalone (no `require('electron')`, no subprocess, no side effects) so it
 * unit-tests with `node --test`, same pattern as apex-gateway.cjs /
 * apex-daemon.cjs. main.cjs owns the electron-coupled glue: the `execFileSync`
 * shell probe (with timeout) and the `process.env.PATH` mutation.
 */

const path = require('node:path')

// Sentinel bracketing the PATH value in the probe's stdout, so we can pluck it
// out of any rc-file noise (banners, `nvm use` output, etc.).
const LOGIN_SHELL_PATH_SENTINEL = '__HERMES_LOGIN_PATH__='

/**
 * argv (after the shell binary) for the login-shell PATH probe. `-l` sources the
 * login profile, `-i` the interactive rc (where nvm/fnm hooks usually live), and
 * the `printf` brackets the value with the sentinel.
 *
 * @returns {string[]}
 */
function loginShellPathProbeArgs() {
  return ['-lic', `printf '%s%s\\n' '${LOGIN_SHELL_PATH_SENTINEL}' "$PATH"`]
}

/**
 * Extract the PATH value the probe printed, or null when the sentinel is absent
 * (probe produced only rc noise / nothing usable).
 *
 * @param {string | Buffer | null | undefined} stdout
 * @returns {string | null}
 */
function parseLoginShellPath(stdout) {
  if (!stdout) return null
  for (const line of String(stdout).split('\n')) {
    const idx = line.indexOf(LOGIN_SHELL_PATH_SENTINEL)
    if (idx !== -1) {
      const value = line.slice(idx + LOGIN_SHELL_PATH_SENTINEL.length).trim()
      return value || null
    }
  }
  return null
}

/**
 * Common POSIX user-level bin dirs, in priority order. `home` is the OS account
 * home (`os.homedir()`), never a Hermes profile home. Not existence-filtered
 * here — the caller applies its `isDir` predicate.
 *
 * @param {string} home
 * @param {{ pathModule?: typeof path.posix }} [opts]
 * @returns {string[]}
 */
function posixUserBinDirCandidates(home, { pathModule = path.posix } = {}) {
  if (!home) return []
  const j = (...parts) => pathModule.join(home, ...parts)
  return [
    j('.local', 'bin'), // claude/codex installer, pipx, npm prefix=~/.local
    j('.npm-global', 'bin'), // `npm config set prefix ~/.npm-global`
    j('bin'), // ad-hoc user bin
    j('.volta', 'bin'), // Volta shim dir
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin' // Intel Homebrew / manual installs
  ]
}

/**
 * Append entries from `sources` that aren't already in `base`, de-duplicating
 * and preserving first-occurrence order. `base` is kept verbatim (inherited
 * PATH). Each source is a delimiter-joined PATH string or an array of dirs.
 * Empty segments are dropped.
 *
 * @param {string} base
 * @param {Array<string | string[]>} sources
 * @param {{ delimiter?: string }} [opts]
 * @returns {string}
 */
function mergePathEntries(base, sources, { delimiter = ':' } = {}) {
  const seen = new Set()
  const ordered = []
  const push = entry => {
    if (!entry || seen.has(entry)) return
    seen.add(entry)
    ordered.push(entry)
  }
  for (const entry of String(base || '').split(delimiter)) push(entry)
  for (const src of sources || []) {
    const parts = Array.isArray(src) ? src : String(src || '').split(delimiter)
    for (const part of parts) push(part)
  }
  return ordered.join(delimiter)
}

/**
 * Build the augmented PATH for the desktop's spawned children.
 *
 * Windows: returns `currentPath` unchanged — a GUI app there already inherits
 * the full user PATH from the registry, so there is nothing to repair.
 *
 * POSIX: `currentPath`, then the probed login-shell PATH (trusted verbatim),
 * then the existence-filtered static user-bin floor. Append-only + de-duplicated.
 *
 * @param {{
 *   currentPath?: string,
 *   home?: string,
 *   loginShellPath?: string | null,
 *   platform?: NodeJS.Platform,
 *   isDir?: (dir: string) => boolean,
 *   pathModule?: typeof path.posix
 * }} [opts]
 * @returns {string}
 */
function resolveAugmentedPath({
  currentPath = '',
  home = '',
  loginShellPath = null,
  platform = process.platform,
  isDir = () => true,
  pathModule = platform === 'win32' ? path.win32 : path.posix
} = {}) {
  if (platform === 'win32') return currentPath
  const delimiter = path.posix.delimiter
  const staticFloor = posixUserBinDirCandidates(home, { pathModule }).filter(isDir)
  const sources = []
  if (loginShellPath) sources.push(loginShellPath) // trusted user PATH, verbatim
  sources.push(staticFloor) // existence-filtered fallback floor
  return mergePathEntries(currentPath, sources, { delimiter })
}

module.exports = {
  LOGIN_SHELL_PATH_SENTINEL,
  loginShellPathProbeArgs,
  mergePathEntries,
  parseLoginShellPath,
  posixUserBinDirCandidates,
  resolveAugmentedPath
}
