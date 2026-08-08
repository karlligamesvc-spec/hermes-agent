/**
 * hc-604 — every platform tool plugin must be reachable by the credential the
 * desktop injects, and that must stay true for plugins nobody has written yet.
 *
 * The bug this suite exists to prevent is not "the builder returned the wrong
 * string". It is the shape of hc-604 itself: the cloud injected these env vars
 * on every container create and guarded them with a dedicated gate, the desktop
 * injected NOTHING, and nothing anywhere was in a position to notice — because
 * the desktop's tests only ever asked the desktop about itself. Four
 * capabilities (图片生成 / 视频生成 / 图片 OCR / 媒体转写) had therefore never
 * worked on a desktop, and the failure surfaced to the user as「密钥已过期,请
 * 重新登录」— an instruction that could not possibly help.
 *
 * So the assertions below are deliberately NOT about this module's own output
 * in isolation. Two of them cross a boundary:
 *
 *   1. `the injected key set IS the contract declared in Python` reads
 *      DESKTOP_SPAWN_ENV_CONTRACT out of plugins/apexnodes_gateway.py. The
 *      consumers of that contract are written in two languages; declaring it
 *      once and having each side read the declaration is what stops them
 *      drifting. (The Python side's own consumer is
 *      tests/plugins/test_desktop_platform_tool_credentials.py, which enumerates
 *      the plugin directories on disk and proves the tools actually resolve.)
 *   2. `every platform tool plugin ON DISK is covered` runs the auditor over the
 *      REAL plugins/ tree. The auditor never consults PLATFORM_TOOL_PLUGINS, so
 *      a new plugin that authenticates to the platform is discovered whether or
 *      not anyone registered it, and is reported if it invents a credential
 *      lookup the injection does not satisfy.
 *
 * Reverse verification is explicit and is what makes the rest of this file worth
 * anything: `removing the injection turns the audit red` and `an unregistered
 * platform plugin is caught` inject the two regressions on purpose and assert
 * the audit fails AND names the offender.
 *
 * No test in this file may contain a real key.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  auditPlatformToolPluginEnv,
  buildPlatformToolSpawnEnv,
  describePlatformToolSpawnEnv,
  isPlatformAuthenticatingSource,
  PLATFORM_TOOL_ENV_KEYS,
  PLATFORM_TOOL_PLUGINS,
  resolverChainsIn
} from './apex-platform-tools'

const KEY = 'sk-Fake000000000000000000000000000'
const API_BASE = 'https://api.apex-nodes.com'

/** Repo root — this file lives at apps/desktop/electron/. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const PLUGINS_ROOT = path.join(REPO_ROOT, 'plugins')
const GATEWAY_CLIENT = path.join(PLUGINS_ROOT, 'apexnodes_gateway.py')

/** Every plugin `__init__.py` plus the shared gateway client, read from disk. */
function readPluginSources() {
  const sources: { id: string; source: string }[] = []

  for (const entry of fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const init = path.join(PLUGINS_ROOT, entry.name, '__init__.py')

    if (!fs.existsSync(init)) {
      continue
    }
    sources.push({ id: entry.name, source: fs.readFileSync(init, 'utf8') })
  }

  sources.push({ id: 'apexnodes_gateway.py', source: fs.readFileSync(GATEWAY_CLIENT, 'utf8') })

  return sources
}

/** The env names DESKTOP_SPAWN_ENV_CONTRACT resolves to, read from the .py. */
function readPythonContract() {
  const source = fs.readFileSync(GATEWAY_CLIENT, 'utf8')
  const constants: Record<string, string> = {}

  for (const line of source.split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(["'])([A-Za-z0-9_]+)\2\s*$/)

    if (match) {
      constants[match[1]] = match[3]
    }
  }

  const declaration = source.match(/^DESKTOP_SPAWN_ENV_CONTRACT\s*=\s*\(([^)]*)\)/m)

  assert.ok(declaration, 'plugins/apexnodes_gateway.py must declare DESKTOP_SPAWN_ENV_CONTRACT')

  return declaration[1]
    .split(',')
    .map(part => part.trim().replace(/^(["'])([\s\S]*)\1$/, '$2'))
    .filter(Boolean)
    .map(token => constants[token] ?? token)
}

describe('the injected fragment', () => {
  test('carries the credential, the gateway base and the legacy Scheduler base', () => {
    const env = buildPlatformToolSpawnEnv({ apiBase: API_BASE, key: KEY })

    expect(env).toEqual({
      HERMES_PLATFORM_API_BASE: 'https://api.apex-nodes.com/api/v1',
      TOOLS_GATEWAY_BASE: 'https://api.apex-nodes.com',
      TOOLS_GATEWAY_KEY: KEY
    })
  })

  test('does NOT set API_SERVER_KEY', () => {
    // API_SERVER_KEY is the runtime's OWN api-server bearer ("server refuses to
    // start without it" once the api server is enabled). Carrying the relay key
    // there would silently change what the local API server authenticates.
    const env = buildPlatformToolSpawnEnv({ apiBase: API_BASE, key: KEY })

    expect(Object.keys(env)).not.toContain('API_SERVER_KEY')
    expect(Object.keys(env)).not.toContain('MODEL_API_KEY')
  })

  test('emits NOTHING when signed out — including the base', () => {
    // A base with no credential flips use_gateway() on and turns a clean
    // "you are not signed in" into a 401 the user cannot act on.
    expect(buildPlatformToolSpawnEnv({ apiBase: API_BASE, key: '' })).toEqual({})
    expect(buildPlatformToolSpawnEnv({ apiBase: API_BASE, key: '   ' })).toEqual({})
    expect(buildPlatformToolSpawnEnv({ apiBase: '', key: KEY })).toEqual({})
  })

  test('is add-only: an explicit parent-env value wins', () => {
    const env = buildPlatformToolSpawnEnv({
      apiBase: API_BASE,
      currentEnv: { TOOLS_GATEWAY_BASE: 'http://127.0.0.1:8000' },
      key: KEY
    })

    expect(env.TOOLS_GATEWAY_BASE).toBe('http://127.0.0.1:8000')
    expect(env.TOOLS_GATEWAY_KEY).toBe(KEY)
  })

  test('tolerates a trailing slash on the API base', () => {
    const env = buildPlatformToolSpawnEnv({ apiBase: 'https://api.apex-nodes.com/', key: KEY })

    expect(env.TOOLS_GATEWAY_BASE).toBe('https://api.apex-nodes.com')
    expect(env.HERMES_PLATFORM_API_BASE).toBe('https://api.apex-nodes.com/api/v1')
  })

  test('the log line never carries the credential', () => {
    const env = buildPlatformToolSpawnEnv({ apiBase: API_BASE, key: KEY })
    const line = describePlatformToolSpawnEnv(env)

    expect(line).not.toContain(KEY)
    expect(line).toContain('api.apex-nodes.com')
    expect(describePlatformToolSpawnEnv({})).toContain('未登录')
  })
})

describe('the cross-language contract', () => {
  test('the injected key set IS the contract declared in Python', () => {
    // One declaration, two consumers reaching it by different routes. Adding a
    // key on either side without the other is red here.
    expect([...PLATFORM_TOOL_ENV_KEYS].sort()).toEqual(readPythonContract().sort())
  })

  test('every registered plugin exists on disk', () => {
    for (const plugin of PLATFORM_TOOL_PLUGINS) {
      expect(
        fs.existsSync(path.join(PLUGINS_ROOT, plugin.id, '__init__.py')),
        `${plugin.id} is registered but not shipped`
      ).toBe(true)
    }
  })
})

describe('resolver-chain extraction', () => {
  test('reads a plain `getenv(A) or getenv(B)` fall-through', () => {
    const chains = resolverChainsIn(
      'def _agent_api_key() -> str:\n    return (os.getenv("API_SERVER_KEY") or os.getenv("MODEL_API_KEY") or "").strip()\n'
    )

    expect(chains).toEqual([{ delegates: false, envs: ['API_SERVER_KEY', 'MODEL_API_KEY'], fn: '_agent_api_key' }])
  })

  test('reads a tuple-of-constants fall-through', () => {
    // apexnodes_gateway.agent_api_key writes its chain this way. A scanner that
    // only understands os.getenv("LITERAL") sees ZERO env reads here — i.e. it
    // would report the single most important chain in the system as "nothing to
    // check" and pass.
    const chains = resolverChainsIn(
      'ENV_KEY = "TOOLS_GATEWAY_KEY"\n\ndef agent_api_key():\n    for env_name in (ENV_KEY, "API_SERVER_KEY"):\n        value = os.getenv(env_name)\n'
    )

    expect(chains[0].envs).toEqual(['TOOLS_GATEWAY_KEY', 'API_SERVER_KEY'])
  })

  test('recognises delegation to the shared resolver', () => {
    const chains = resolverChainsIn(
      'def _agent_api_key():\n    if _gateway is not None:\n        return _gateway.agent_api_key()\n    return os.getenv("API_SERVER_KEY")\n'
    )

    expect(chains[0].delegates).toBe(true)
  })

  test('ignores functions that are not credential/endpoint resolvers', () => {
    expect(resolverChainsIn('def _document_cache_dir():\n    home = os.getenv("HERMES_HOME")\n')).toEqual([])
  })
})

describe('the class-level invariant', () => {
  const sources = readPluginSources()

  test('the plugins/ tree really does contain platform-authenticating plugins', () => {
    // Guards the guard: if this ever hits zero, every assertion below passes
    // vacuously and the suite becomes decoration.
    const found = sources.filter(entry => isPlatformAuthenticatingSource(entry.source))

    expect(found.length).toBeGreaterThanOrEqual(PLATFORM_TOOL_PLUGINS.length)
  })

  test('every platform tool plugin ON DISK is covered by the injection', () => {
    const audit = auditPlatformToolPluginEnv(sources)

    expect(audit.uncovered, 'plugins the desktop injection cannot reach').toEqual([])
    expect(audit.unregistered, 'platform plugins missing from PLATFORM_TOOL_PLUGINS').toEqual([])
    expect(audit.opaque, 'plugins whose credential resolution could not be read').toEqual([])
    expect(audit.clean).toBe(true)
  })

  test('every registered capability is discovered by the auditor', () => {
    const audited = new Set(auditPlatformToolPluginEnv(sources).plugins.map(plugin => plugin.id))

    for (const plugin of PLATFORM_TOOL_PLUGINS) {
      expect(audited.has(plugin.id), `${plugin.id} was not detected as platform-authenticating`).toBe(true)
    }
  })
})

describe('reverse verification', () => {
  const sources = readPluginSources()

  test('removing ANY single injected key turns the audit red', () => {
    for (const dropped of PLATFORM_TOOL_ENV_KEYS) {
      const remaining = PLATFORM_TOOL_ENV_KEYS.filter(name => name !== dropped)
      const audit = auditPlatformToolPluginEnv(sources, remaining)

      expect(audit.clean, `dropping ${dropped} left the audit clean`).toBe(false)
      expect(audit.uncovered.length, `dropping ${dropped} named no plugin`).toBeGreaterThan(0)
    }
  })

  test('injecting nothing at all turns the audit red', () => {
    const audit = auditPlatformToolPluginEnv(sources, [])

    expect(audit.clean).toBe(false)
    expect(audit.uncovered.length).toBeGreaterThan(0)
  })

  test('a NEW platform plugin with its own credential env is caught', () => {
    // The regression the ticket asks for by name: someone adds a fifth platform
    // tool and forgets the desktop leg.
    const audit = auditPlatformToolPluginEnv([
      ...sources,
      {
        id: 'apexnodes-newthing-tools',
        source:
          'headers = {"Authorization": f"Bearer {key}"}\n\ndef _newthing_key() -> str:\n    return os.getenv("NEWTHING_TOOLS_KEY") or ""\n'
      }
    ])

    expect(audit.clean).toBe(false)
    expect(audit.uncovered).toContain('apexnodes-newthing-tools')
    expect(audit.unregistered).toContain('apexnodes-newthing-tools')
  })

  test('a platform plugin whose credential lookup cannot be read is caught', () => {
    // The scanner's own blind spot, made loud instead of silent: a
    // platform-authenticating source with no readable chain is a failure, not a
    // pass. (hc-595 shipped because a verifier treated "found nothing" as "found
    // nothing wrong".)
    const audit = auditPlatformToolPluginEnv([
      { id: 'apexnodes-opaque-tools', source: 'headers = {"Authorization": f"Bearer {resolve()}"}\n' }
    ])

    expect(audit.clean).toBe(false)
    expect(audit.opaque).toContain('apexnodes-opaque-tools')
  })

  test('a plugin that delegates to the shared resolver is NOT flagged', () => {
    // Delegation is real coverage — the shared resolver's own chain is audited
    // separately — so the plain-env fallback a bare-copy deployment needs does
    // not have to be deleted to keep the invariant green.
    const audit = auditPlatformToolPluginEnv([
      {
        id: 'apexnodes-image-tools',
        source:
          'from plugins import apexnodes_gateway as _gateway\n\ndef _agent_api_key() -> str:\n    if _gateway is not None:\n        return _gateway.agent_api_key()\n    return os.getenv("API_SERVER_KEY") or ""\n'
      }
    ])

    expect(audit.uncovered).toEqual([])
  })
})
