/**
 * apex-platform-tools.ts
 *
 * THE single place the desktop decides what credential + endpoint the PLATFORM
 * TOOL plugins (图片生成 / 视频生成 / OCR / 媒体转写 / 社媒数据) are spawned with,
 * plus the registry-INDEPENDENT auditor that proves the injection actually
 * covers every plugin that needs it.
 *
 * ── Why this module exists (hc-604) ─────────────────────────────────────────
 * Until now the desktop injected NOTHING for these tools. Zero occurrences of
 * `TOOLS_GATEWAY_KEY` / `API_SERVER_KEY` / `HERMES_PLATFORM_API_BASE` existed
 * anywhere under `apps/desktop`, while the cloud container injects them on every
 * create (`docker_manager.py`) and has a dedicated gate that alerts when they go
 * missing (`entry_connectivity_gate.py`). The plugins were left to find a
 * credential on their own, and the only route they had on desktop was
 * `apexnodes_gateway._managed_provider_entry()` — an ad-hoc scrape of
 * config.yaml's `custom_providers` list.
 *
 * That scrape is a FOURTH holder of the managed relay key, outside the hc-602
 * registry, and it inherits every failure mode hc-602 exists to prevent:
 *
 *   - It reads ONE shape. hc-602 registers three places a managed key may live
 *     (`model`, `custom_providers[]`, `providers.<slug>`); the scrape only knows
 *     the middle one. The day `hermes_cli/config.py` migrates the list into the
 *     v12 `providers:` dict — a migration hc-602 already registered an anchor
 *     for — the scrape returns None, `use_gateway()` goes false, and every
 *     platform tool silently falls back to the legacy Scheduler path.
 *   - It reads a REPLICA, not the source. The desktop's own stored credential
 *     (apex-managed.json, safeStorage) is the truth; config.yaml is a copy the
 *     boot self-heal keeps in sync. On the 0.17.1 build in the field that copy
 *     was only PARTIALLY synced — hc-595's patcher matched `model.api_key` and
 *     missed the `custom_providers` entry (`entries=0/0` in the desktop log), so
 *     chat authenticated with a live key while the tools read a dead one from
 *     the very next block of the same file and got a 401. That is the reported
 *     hc-604 symptom, reproduced from disk: the two `api_key:` values in a real
 *     ~/.apexnodes/config.yaml hash to different digests.
 *   - The legacy fallback cannot work here at all. `_api_base()` defaults to
 *     `http://host.docker.internal:8000/api/v1` — a Docker-only address that
 *     does not resolve on a desktop — so "gateway unavailable" degrades to a
 *     connection error rather than a working direct call.
 *
 * ── What this module does instead ───────────────────────────────────────────
 * The spawn env carries the credential, sourced from the SAME stored managed
 * credential hc-602's writer reads (main.ts passes `resolveManagedConfig()`), so
 * there is no new holder: config.yaml and the spawn env are two renderings of
 * one value, refreshed together — the 401 self-heal rewrites config.yaml AND
 * re-homes the backend (`applyToBackend: reloadBackendForRelayKey`), which
 * re-runs this builder.
 *
 * `TOOLS_GATEWAY_KEY` — not `API_SERVER_KEY` — carries it. Both are read by
 * `apexnodes_gateway.agent_api_key()`, but `API_SERVER_KEY` is ALSO the runtime's
 * own OpenAI-compatible API-server bearer (`hermes_cli/config.py`: "Required
 * whenever the API server is enabled; server refuses to start without it"), and
 * overloading one env var with two unrelated credentials is how the next
 * three-day debugging session starts. `TOOLS_GATEWAY_KEY` is read by the tools
 * gateway client and by nothing else in the runtime.
 *
 * ── The invariant, and who enforces it ──────────────────────────────────────
 * The contract is declared ONCE, in Python, as
 * `plugins/apexnodes_gateway.DESKTOP_SPAWN_ENV_CONTRACT`, and has two
 * independent consumers that reach it by different routes:
 *
 *   1. This module + `apex-platform-tools.test.ts` (TypeScript): the test reads
 *      that literal out of the .py file and asserts `buildPlatformToolSpawnEnv`
 *      emits EXACTLY those keys. Adding a key to the contract without teaching
 *      the builder — or vice versa — is red.
 *   2. `tests/plugins/test_desktop_platform_tool_credentials.py` (Python):
 *      enumerates every `plugins/apexnodes-*` directory on disk, imports it, and
 *      asserts that with ONLY the contract env set each one resolves a
 *      credential and a public base. A NEW platform tool plugin is picked up by
 *      the glob automatically — it does not have to be registered anywhere to be
 *      covered, and if it invents its own credential lookup that the injection
 *      does not satisfy, it fails on the first run.
 *
 * `PLATFORM_TOOL_PLUGINS` below is the human-facing registry (which capability
 * each plugin powers, for error text and for the desktop's own accounting). It
 * is deliberately NOT what the audit iterates: `auditPlatformToolPluginEnv`
 * walks the real plugin sources and flags a platform-authenticating plugin that
 * nobody registered — the hc-602 lesson that a verifier must not reuse the
 * writer's idea of what exists.
 *
 * Electron-free and dependency-free (same contract as its siblings), so all of
 * it is unit-testable with `vitest run --project electron`.
 */

// ── The registry ────────────────────────────────────────────────────────────

export interface PlatformToolPlugin {
  /** Plugin directory name under `plugins/` — also the `plugins.enabled` entry. */
  id: string
  /** User-facing capability name, used in error text. */
  capability: string
  /** Tool names the plugin registers, for support/diagnostics. */
  tools: readonly string[]
}

/**
 * Every bundled plugin that authenticates to the ApexNodes platform to do its
 * work. Registering one here does not enable it — `MANAGED_PLUGIN_NAMES` in
 * apex-managed.ts does that — this list records WHAT BREAKS when the credential
 * is missing, so the desktop can say so in words a user can act on.
 *
 * ⚠️ This list is not the audit's source of truth. `auditPlatformToolPluginEnv`
 * discovers platform-authenticating plugins from their source and reports any
 * that are missing here, so an unregistered one is caught rather than silently
 * uncovered.
 */
export const PLATFORM_TOOL_PLUGINS: readonly PlatformToolPlugin[] = Object.freeze([
  Object.freeze({
    id: 'apexnodes-image-tools',
    capability: '图片生成',
    tools: Object.freeze(['generate_image'])
  }),
  Object.freeze({
    id: 'apexnodes-video-tools',
    capability: '视频生成',
    tools: Object.freeze(['generate_video'])
  }),
  Object.freeze({
    id: 'apexnodes-douyin-tools',
    capability: '媒体下载 / 转写 / 图片 OCR',
    tools: Object.freeze([
      'social_download',
      'media_transcribe',
      'image_ocr',
      'social_batch_submit',
      'social_batch_status'
    ])
  }),
  Object.freeze({
    id: 'apexnodes-social-tools',
    capability: '社媒数据',
    tools: Object.freeze([
      'social_content',
      'social_search',
      'social_profile',
      'social_comments',
      'social_trending',
      'social_posts',
      'social_captions',
      'creator_top_posts'
    ])
  })
]) as readonly PlatformToolPlugin[]

// ── The injected env ────────────────────────────────────────────────────────

/**
 * The env keys this module injects. MUST equal
 * `plugins/apexnodes_gateway.DESKTOP_SPAWN_ENV_CONTRACT`; the test reads that
 * literal from the .py file and compares, so the two cannot drift.
 *
 *   TOOLS_GATEWAY_KEY       the managed relay key — `agent_api_key()` reads it
 *                           first, ahead of any config.yaml scrape.
 *   TOOLS_GATEWAY_BASE      pins gateway mode ON. Without it `gateway_base()`
 *                           has to infer desktop-ness from config.yaml's shape.
 *   HERMES_PLATFORM_API_BASE the Scheduler base the plugins' LEGACY path uses
 *                           (`TOOLS_GATEWAY_DISABLED=1`, or an old plugin copy
 *                           with no gateway leg). Its built-in default is
 *                           `host.docker.internal` — unroutable off Docker.
 */
export const PLATFORM_TOOL_ENV_KEYS = Object.freeze([
  'TOOLS_GATEWAY_KEY',
  'TOOLS_GATEWAY_BASE',
  'HERMES_PLATFORM_API_BASE'
] as const)

/** Path segment that turns the API host into the Scheduler's versioned base. */
const SCHEDULER_API_PATH = '/api/v1'

const trimSlashes = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/\/+$/, '')

export interface PlatformToolSpawnEnvInput {
  /** The managed relay key (`resolveManagedConfig().key`); '' when signed out. */
  key: string
  /** The API host, e.g. `https://api.apex-nodes.com` (`resolveApexEndpoints().apiBase`). */
  apiBase: string
  /** Parent env — an explicit value here is left alone (add-only). */
  currentEnv?: Record<string, string | undefined>
}

/**
 * Build the platform-tool fragment for the backend spawn.
 *
 * ADD-ONLY, exactly like `desktopFeishuSpawnEnv` / the HF_ENDPOINT rule: a key
 * the parent env already carries is passed through untouched, so a developer or
 * CI that exported `TOOLS_GATEWAY_BASE=http://127.0.0.1:8000` to test against a
 * local scheduler keeps it. Returns `{}` when signed out or when no API base is
 * resolvable, so `{ ...backendEnv, ...buildPlatformToolSpawnEnv(...) }` is a
 * safe no-op on a BYOK / signed-out install — the tools then report "not signed
 * in" instead of authenticating as somebody's stale key.
 *
 * NOTE the asymmetry that is deliberate: with no key we emit NOTHING, not even
 * the base. A base without a credential would flip `use_gateway()` on and turn
 * a clean "you are not signed in" into a 401 from the server.
 */
export function buildPlatformToolSpawnEnv({
  key,
  apiBase,
  currentEnv = {}
}: PlatformToolSpawnEnvInput): Record<string, string> {
  const credential = String(key ?? '').trim()
  const host = trimSlashes(apiBase)

  if (!credential || !host) {
    return {}
  }

  const env: Record<string, string> = {
    TOOLS_GATEWAY_KEY: credential,
    TOOLS_GATEWAY_BASE: host,
    HERMES_PLATFORM_API_BASE: `${host}${SCHEDULER_API_PATH}`
  }

  for (const name of PLATFORM_TOOL_ENV_KEYS) {
    const inherited = String(currentEnv?.[name] ?? '').trim()

    if (inherited) {
      env[name] = inherited
    }
  }

  return env
}

// ── The auditor (never reads the registry) ──────────────────────────────────

/**
 * One credential/endpoint resolution chain found in a plugin's source: the
 * ORDERED list of env names a single resolver falls through.
 *
 * `delegates` marks a resolver that hands the question to the shared
 * `apexnodes_gateway` resolver instead of answering it from its own env reads.
 * Such a chain is covered by definition — the shared resolver's own chain is
 * audited separately — which is what lets a plugin keep a plain-env fallback for
 * the bare-copy deployment without the audit calling it uncovered.
 */
export interface ResolverChain {
  /** Enclosing function name, e.g. `_agent_api_key`. */
  fn: string
  /** Env names read, in fall-through order. */
  envs: string[]
  delegates: boolean
}

export interface PlatformToolSource {
  /** Plugin directory name, or the shared module's file name. */
  id: string
  source: string
}

export interface AuditedPlatformToolPlugin {
  id: string
  /** Chains that no injected key satisfies. */
  uncovered: ResolverChain[]
  /** True when the source authenticates to the platform but declares no chain. */
  opaque: boolean
  /** True when no `PLATFORM_TOOL_PLUGINS` entry claims this plugin. */
  unregistered: boolean
}

export interface PlatformToolAudit {
  clean: boolean
  plugins: AuditedPlatformToolPlugin[]
  /** Ids with an uncovered chain — the injection does not reach them. */
  uncovered: string[]
  /** Ids that authenticate to the platform but are not in the registry. */
  unregistered: string[]
  /** Ids whose credential resolution could not be read at all. */
  opaque: string[]
}

/** Resolvers are named for what they return; this is the naming contract. */
const RESOLVER_NAME_RE = /^_*[a-z0-9_]*(?:key|base)$/i

/** A call that hands credential resolution to the shared gateway client. */
const DELEGATION_RE = /\b(?:_gateway|apexnodes_gateway)\.(?:agent_api_key|gateway_base)\s*\(/

/** Module-level `NAME = "VALUE"` — the gateway client names its envs this way. */
const CONSTANT_RE = /^([A-Z][A-Z0-9_]*)\s*=\s*(["'])([A-Za-z0-9_]+)\2\s*$/

/** A source that builds a platform Bearer request, or imports the shared client. */
const PLATFORM_AUTH_RE = /apexnodes_gateway|Authorization["']?\s*:\s*f?["']Bearer/

/**
 * Read every env name a Python expression can resolve, IN ORDER, resolving
 * module constants. Handles the two forms the plugins actually use:
 *
 *   os.getenv("A") or os.getenv("B")          → ['A', 'B']
 *   for env_name in (ENV_KEY, "A", "B"):      → ['TOOLS_GATEWAY_KEY', 'A', 'B']
 *
 * The second form is why a naive `os.getenv\("([A-Z_]+)"\)` scan is not enough:
 * `apexnodes_gateway.agent_api_key` — the single most important chain in the
 * system — writes its fall-through as a tuple of constants and would scan as
 * ZERO env reads, i.e. as covered-by-nothing-because-there-is-nothing.
 */
function envNamesIn(body: string, constants: Record<string, string>): string[] {
  const names: string[] = []

  const push = (raw: string) => {
    const name = constants[raw] ?? raw

    if (/^[A-Z][A-Z0-9_]*$/.test(name) && !names.includes(name)) {
      names.push(name)
    }
  }

  // Literal + constant-arg os.getenv / os.environ.get calls.
  for (const match of body.matchAll(
    /os\.(?:getenv|environ\.get)\(\s*(?:(["'])([A-Za-z0-9_]+)\1|([A-Za-z_][A-Za-z0-9_]*))/g
  )) {
    push(match[2] ?? match[3])
  }

  // `for <var> in (A, "B", …)` fall-through tuples/lists.
  for (const match of body.matchAll(/\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s*[([]([^)\]]*)[)\]]/g)) {
    for (const part of match[1].split(',')) {
      const token = part.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')

      if (token) {
        push(token)
      }
    }
  }

  return names
}

/**
 * Split a Python module into its top-level `def` bodies. Indentation-based (the
 * same reasoning as hc-602's YAML walk): a structural read cannot be blind to a
 * shape nobody thought to pattern-match.
 */
function topLevelFunctions(source: string): { name: string; body: string }[] {
  const lines = String(source ?? '').split(/\r?\n/)
  const out: { name: string; body: string }[] = []
  let current: { name: string; body: string[] } | null = null

  for (const line of lines) {
    const def = line.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)

    if (def) {
      if (current) {
        out.push({ body: current.body.join('\n'), name: current.name })
      }
      current = { body: [], name: def[1] }

      continue
    }

    if (!current) {
      continue
    }

    // A non-indented, non-blank line ends the function body.
    if (line.trim() && !/^\s/.test(line)) {
      out.push({ body: current.body.join('\n'), name: current.name })
      current = null

      continue
    }

    current.body.push(line)
  }

  if (current) {
    out.push({ body: current.body.join('\n'), name: current.name })
  }

  return out
}

/** Every credential/endpoint resolution chain declared in one Python source. */
export function resolverChainsIn(source: string): ResolverChain[] {
  const raw = String(source ?? '')
  const constants: Record<string, string> = {}

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(CONSTANT_RE)

    if (match) {
      constants[match[1]] = match[3]
    }
  }

  const chains: ResolverChain[] = []

  for (const fn of topLevelFunctions(raw)) {
    if (!RESOLVER_NAME_RE.test(fn.name)) {
      continue
    }
    const envs = envNamesIn(fn.body, constants)
    const delegates = DELEGATION_RE.test(fn.body)

    if (envs.length === 0 && !delegates) {
      continue
    }
    chains.push({ delegates, envs, fn: fn.name })
  }

  return chains
}

/** True when a source authenticates to the ApexNodes platform. */
export function isPlatformAuthenticatingSource(source: string): boolean {
  return PLATFORM_AUTH_RE.test(String(source ?? ''))
}

/**
 * Independently check that the desktop injection reaches EVERY plugin that
 * authenticates to the platform.
 *
 * "Independently" is the point, and it is the hc-602 lesson applied to a
 * different artifact: this function does not consult `PLATFORM_TOOL_PLUGINS`. It
 * decides from the SOURCE whether a plugin talks to the platform, reads the
 * resolution chains that source actually declares, and asks whether the injected
 * key set satisfies at least one env in each. So it catches all three ways this
 * can regress:
 *
 *   - the injection is removed or renamed        → every chain goes uncovered;
 *   - a new plugin invents its own credential env → its chain is uncovered;
 *   - a new plugin is added but never registered  → reported `unregistered`.
 *
 * @param sources every plugin `__init__.py` plus the shared gateway client
 * @param injected the env keys `buildPlatformToolSpawnEnv` emits
 */
export function auditPlatformToolPluginEnv(
  sources: readonly PlatformToolSource[],
  injected: readonly string[] = PLATFORM_TOOL_ENV_KEYS
): PlatformToolAudit {
  const injectedSet = new Set(injected.map(name => String(name)))
  const registered = new Set(PLATFORM_TOOL_PLUGINS.map(plugin => plugin.id))
  const plugins: AuditedPlatformToolPlugin[] = []

  for (const entry of sources || []) {
    const id = String(entry?.id ?? '')
    const source = String(entry?.source ?? '')

    if (!isPlatformAuthenticatingSource(source)) {
      continue
    }

    const chains = resolverChainsIn(source)

    const uncovered = chains.filter(chain => !chain.delegates && !chain.envs.some(name => injectedSet.has(name)))

    plugins.push({
      id,
      // A platform-authenticating source with NO readable chain cannot be
      // proven covered — treated as a failure, not as "nothing to check". This
      // is the case a scanner is most likely to be wrong about, so it is loud.
      opaque: chains.length === 0,
      uncovered,
      // The shared client is a module, not a plugin — it is audited for chain
      // coverage but is not expected in the plugin registry.
      unregistered: id.startsWith('apexnodes-') && !registered.has(id)
    })
  }

  const uncovered = plugins.filter(plugin => plugin.uncovered.length > 0).map(plugin => plugin.id)
  const unregistered = plugins.filter(plugin => plugin.unregistered).map(plugin => plugin.id)
  const opaque = plugins.filter(plugin => plugin.opaque).map(plugin => plugin.id)

  return {
    clean: uncovered.length === 0 && unregistered.length === 0 && opaque.length === 0,
    opaque,
    plugins,
    uncovered,
    unregistered
  }
}

/**
 * One line for the desktop log describing what the spawn will carry. Never
 * emits the credential — only whether one is present, and where it points.
 */
export function describePlatformToolSpawnEnv(env: Record<string, string>): string {
  if (!env || !env.TOOLS_GATEWAY_KEY) {
    return '[platform-tools] no managed credential — 平台工具(图片/视频生成、OCR、转写)将报「未登录」'
  }

  return `[platform-tools] credential injected; gateway=${env.TOOLS_GATEWAY_BASE} legacy=${env.HERMES_PLATFORM_API_BASE}`
}
