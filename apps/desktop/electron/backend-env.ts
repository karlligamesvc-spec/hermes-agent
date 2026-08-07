import path from 'node:path'

// Match the POSIX fallback surface used by the Python terminal environment.
// macOS apps launched from Finder/Dock often inherit only /usr/bin:/bin:/usr/sbin:/sbin,
// which misses Apple Silicon Homebrew and user-installed CLI tools such as codex.
const POSIX_SANE_PATH_ENTRIES = Object.freeze([
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin'
])

// hc-406: HuggingFace mirror for mainland China. faster-whisper (local STT,
// the default speech-to-text provider) lazily downloads its ~150 MB Whisper
// model from the Hub on first voice message; huggingface.co is blocked/slow in
// CN, so a bare-network desktop hangs the whole transcription. huggingface_hub
// (a faster-whisper transitive dep) resolves the Hub host from HF_ENDPOINT, so
// exporting this into the backend subprocess env transparently routes every Hub
// download (STT model, marker-pdf OCR models, the huggingface-hub skill's `hf`
// CLI, …) through the official transparent CN mirror. Overridable: we only set
// it when the parent env hasn't already (a power user / staging can point at
// ModelScope or the real Hub). The runtime never reads HF_ENDPOINT itself; this
// is purely for the Python libs it shells into.
const HF_MIRROR_ENDPOINT = 'https://hf-mirror.com'

function delimiterForPlatform(platform = process.platform) {
  return platform === 'win32' ? ';' : ':'
}

function pathModuleForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function pathEnvKey(env = process.env, platform = process.platform) {
  if (platform !== 'win32') {
    return 'PATH'
  }

  return Object.keys(env || {}).find(key => key.toUpperCase() === 'PATH') || 'PATH'
}

function currentPathValue(env = process.env, platform = process.platform) {
  const key = pathEnvKey(env, platform)

  return env?.[key] || ''
}

function appendUniquePathEntries(entries, { delimiter = path.delimiter } = {}) {
  const seen = new Set()
  const ordered = []

  for (const entry of entries) {
    if (!entry) {
      continue
    }

    const parts = Array.isArray(entry) ? entry : String(entry).split(delimiter)

    for (const part of parts) {
      if (!part || seen.has(part)) {
        continue
      }

      seen.add(part)
      ordered.push(part)
    }
  }

  return ordered.join(delimiter)
}

/** Both managed Node layouts are valid: Windows installs node.exe at the
 * managed root, while POSIX installs under node/bin. Prefer the native layout
 * but keep the migrated layout reachable on every platform. */
function hermesManagedNodePathEntries(
  hermesHome,
  { platform = process.platform, pathModule = pathModuleForPlatform(platform) }: any = {}
) {
  if (!hermesHome) {
    return []
  }

  const root = pathModule.join(hermesHome, 'node')
  const bin = pathModule.join(root, 'bin')

  return platform === 'win32' ? [root, bin] : [bin, root]
}

function buildDesktopBackendPath({
  hermesHome,
  venvRoot,
  currentPath = '',
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform)
}: any = {}) {
  const delimiter = delimiterForPlatform(platform)
  const hermesNodeDirs = hermesManagedNodePathEntries(hermesHome, { platform, pathModule })
  const venvBin = venvRoot ? pathModule.join(venvRoot, platform === 'win32' ? 'Scripts' : 'bin') : null
  const saneEntries = platform === 'win32' ? [] : POSIX_SANE_PATH_ENTRIES

  return appendUniquePathEntries([hermesNodeDirs, venvBin, currentPath, saneEntries], { delimiter })
}

function normalizeHermesHomeRoot(hermesHome, { pathModule = pathModuleForPlatform(process.platform) }: any = {}) {
  if (!hermesHome) {
    return hermesHome
  }

  const resolved = pathModule.resolve(String(hermesHome))
  const parent = pathModule.dirname(resolved)

  if (pathModule.basename(parent).toLowerCase() === 'profiles') {
    return pathModule.dirname(parent)
  }

  return resolved
}

function buildDesktopBackendEnv({
  hermesHome,
  pythonPathEntries = [],
  venvRoot,
  currentEnv = process.env,
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform),
  proxyEnv = {}
}: any = {}) {
  const delimiter = delimiterForPlatform(platform)
  const currentPythonPath = currentEnv?.PYTHONPATH || ''
  const key = pathEnvKey(currentEnv, platform)

  const env: any = {
    PYTHONPATH: appendUniquePathEntries([...pythonPathEntries, currentPythonPath], { delimiter }),
    PYTHONUTF8: currentEnv?.PYTHONUTF8 ?? '1',
    [key]: buildDesktopBackendPath({
      hermesHome,
      venvRoot,
      currentPath: currentPathValue(currentEnv, platform),
      platform,
      pathModule
    })
  }

  // hc-545: fold in the coding-agent proxy fragment (HTTP(S)_PROXY / NO_PROXY,
  // resolved from the macOS system proxy in AUTO mode). Because the gateway
  // spawn merges { ...process.env, ...backend.env } and hermes_subprocess_env
  // does NOT strip proxy vars, these propagate to the spawned claude/codex child
  // by plain env inheritance — one injection point covers gateway + agent. The
  // fragment is already add-only vs the parent env (apex-agent-proxy.ts), so a
  // spread here is safe; an empty fragment (OFF / no system proxy) is a no-op.
  if (proxyEnv && typeof proxyEnv === 'object') {
    for (const [proxyKey, proxyValue] of Object.entries(proxyEnv)) {
      if (proxyValue) {env[proxyKey] = proxyValue}
    }
  }

  // hc-406: seed the CN HuggingFace mirror for the Python Hub-download path
  // (faster-whisper STT model, marker-pdf OCR, the `hf` CLI). Add-only: never
  // clobber an HF_ENDPOINT the parent env already set (staging / power-user /
  // ModelScope override). The spawn merges `{ ...process.env, ...backend.env }`,
  // so a value here wins over inheritance — hence the explicit passthrough of an
  // existing value so an override survives.
  const existingHfEndpoint = String(currentEnv?.HF_ENDPOINT || '').trim()
  env.HF_ENDPOINT = existingHfEndpoint || HF_MIRROR_ENDPOINT

  return env
}

export {
  appendUniquePathEntries,
  buildDesktopBackendEnv,
  buildDesktopBackendPath,
  delimiterForPlatform,
  hermesManagedNodePathEntries,
  HF_MIRROR_ENDPOINT,
  normalizeHermesHomeRoot,
  pathEnvKey,
  POSIX_SANE_PATH_ENTRIES
}
