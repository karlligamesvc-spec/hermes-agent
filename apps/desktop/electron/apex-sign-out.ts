/**
 * apex-sign-out.ts — signing out leaves no relay key on this computer (hc-1114).
 *
 * 「退出登录」 asks the server to revoke this computer's relay key first and only
 * then deletes the encrypted credential (desktop-device-key.ts, apex-managed.json).
 * Until hc-1114 that was all it did: every copy the key had been written into
 * stayed behind, and desktop.log had no line saying a sign-out happened.
 *
 * The copies, in each Hermes home (the root and every directory under profiles/):
 *
 *   - config.yaml — the relay-key anchors (apex-relay-key-anchors.ts
 *     MANAGED_KEY_ANCHORS: model, custom_providers[], providers.*);
 *   - backups/config/config.yaml.<reason>.<time> — the engine copies config.yaml
 *     there whenever a load finds it changed (hermes_cli/config_backups.py keeps
 *     five per reason), so they hold the current key and older, rotated ones;
 *   - config.yaml.<anything> beside it — older engines' backups
 *     (config.yaml.bak.<n>, config.yaml.corrupt.*.bak) and copies made by hand;
 *   - .env — a released runtime without model-mutation targets keeps the key as
 *     HERMES_CUSTOM_<ID>_API_KEY (desktop-legacy-managed.ts).
 *
 * In YAML files every registered anchor pointing at the relay gets `api_key: ""`
 * (whatever key it held), and any other copy of the key itself is blanked. The
 * line stays, so a list item that starts with `- api_key:` keeps its shape, and
 * the next sign-in's writer fills it in again. What is left is then judged
 * without the writer's registry: the key itself anywhere in the text, or a
 * non-empty api_key in any map that points at the relay
 * (auditManagedRelayKeyAnchors). A file that still holds one is named in the
 * log line, never silently passed.
 *
 * The running processes (the primary engine, pooled engines, the messaging
 * gateway) keep the key they were spawned with; after a sign-out they restart
 * once idle onto no key (apex-engine-relay-key.ts).
 *
 * Not copies: auth.json's credential pool stores a sha256 fingerprint of a
 * seeded key, never the key (agent/credential_pool.py); the engine's logs and
 * request dumps carry a masked form.
 *
 * Two more ways a key is left behind are closed here too: a sign-out on a
 * version before this one (the boot after the update sweeps the anchors when
 * nobody is signed in), and signing in as another account on the re-sign-in
 * screen, which replaces the stored key without signing out, so the server kept
 * the previous account's key for this computer active.
 *
 * Electron-free: plain fs, unit-tested with `vitest --project electron`.
 */

import fs from 'node:fs'
import path from 'node:path'

import { managedAccountId } from './apex-account-boundary'
import { auditManagedRelayKeyAnchors, locateManagedKeyAnchors, parseYamlMaps } from './apex-relay-key-anchors'
import { requireRevokedDeviceKey, revokeDeviceBody, signOutFailureReason } from './desktop-device-key'

type Log = (line: string) => void

/** Where the relay key is taken out, and which key. */
export interface RelayKeyTarget {
  /** The relay endpoints whose anchors lose their key: the one signed in to, and the default. */
  baseUrls: string[]
  /** The key itself, when known: every other copy of it is blanked too. */
  key?: null | string
}

/** One file that may hold a copy; `yaml` false for `.env`. */
export interface RelayKeyFile {
  file: string
  yaml: boolean
}

function uniqueUrls(urls: Array<null | string | undefined>): string[] {
  return [...new Set(urls.map(url => String(url ?? '').trim()).filter(Boolean))]
}

/** The relay endpoints a sign-out clears: the stored one (when known) and the default. */
export function relayBaseUrls(stored: null | string | undefined, fallback: string): string[] {
  return uniqueUrls([stored, fallback])
}

function regularFiles(dir: string, keep: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && keep(entry.name))
      .map(entry => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * The root, then every directory under `profiles/` — hidden clone staging dirs
 * and profiles without a SOUL.md too, unlike listProfileHomes: a copy of
 * config.yaml there holds the key all the same.
 */
export function relayKeyHomes(root: string): string[] {
  const profiles = path.join(root, 'profiles')

  try {
    const named = fs
      .readdirSync(profiles, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(profiles, entry.name))
      .sort()

    return [root, ...named]
  } catch {
    return [root]
  }
}

/** The files in one home that may hold a copy (see the header). Symlinked backups are left alone. */
export function relayKeyFiles(home: string): RelayKeyFile[] {
  const siblings = regularFiles(home, name => name.startsWith('config.yaml.'))
  const backups = regularFiles(path.join(home, 'backups', 'config'), () => true)

  return [
    { file: path.join(home, 'config.yaml'), yaml: true },
    ...siblings.map(file => ({ file, yaml: true })),
    ...backups.map(file => ({ file, yaml: true })),
    { file: path.join(home, '.env'), yaml: false }
  ]
}

/** `raw` with the relay key taken out (see the header). Pure. */
export function scrubRelayKeyText(raw: string, target: RelayKeyTarget, yaml: boolean): string {
  let next = String(raw ?? '')

  if (yaml) {
    for (const baseUrl of target.baseUrls) {
      const holding = locateManagedKeyAnchors(next, baseUrl).filter(anchor => anchor.keyLine >= 0 && anchor.value)

      if (holding.length === 0) {
        continue
      }

      const { lines } = parseYamlMaps(next)
      const eol = next.includes('\r\n') ? '\r\n' : '\n'

      for (const anchor of holding) {
        lines[anchor.keyLine] = lines[anchor.keyLine].replace(/(api_key:\s*).*$/, '$1""')
      }

      next = lines.join(eol)
    }
  }

  const key = String(target.key ?? '').trim()

  return key ? next.split(key).join('') : next
}

/**
 * What in `raw` still holds a relay key, judged without the writer's registry:
 * `key` when the key itself is anywhere in the text, and the path of every map
 * that points at the relay and carries a non-empty api_key. Empty = clean. Pure.
 */
export function relayKeyLeftIn(raw: string, target: RelayKeyTarget, yaml: boolean): string[] {
  const text = String(raw ?? '')
  const key = String(target.key ?? '').trim()
  const left = key && text.includes(key) ? ['key'] : []

  if (yaml) {
    for (const baseUrl of target.baseUrls) {
      left.push(...auditManagedRelayKeyAnchors(text, baseUrl, '').stale)
    }
  }

  return [...new Set(left)]
}

export interface RelayKeyScrubReport {
  /** Files that held a copy and no longer do, relative to the root. */
  scrubbed: string[]
  /** Files that still hold one: `<file> (<what>)`, relative to the root. */
  failed: string[]
}

function readIfPresent(file: string): null | string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

/** One file: scrub, write in place, read back and judge. */
function scrubFile(entry: RelayKeyFile, target: RelayKeyTarget, name: string, report: RelayKeyScrubReport) {
  let raw: null | string

  try {
    raw = readIfPresent(entry.file)
  } catch (error: any) {
    report.failed.push(`${name} (unreadable: ${error?.code || 'error'})`)

    return
  }

  if (raw === null) {
    return
  }

  const next = scrubRelayKeyText(raw, target, entry.yaml)

  if (next === raw) {
    // Nothing the writer knows how to take out; anything still here is an anchor nobody registered.
    const left = relayKeyLeftIn(raw, target, entry.yaml)

    if (left.length > 0) {
      report.failed.push(`${name} (${left.join(', ')})`)
    }

    return
  }

  try {
    // In place, like every other config.yaml writer: the engine and the config guard watch these paths.
    fs.writeFileSync(entry.file, next, { encoding: 'utf8' })
    const left = relayKeyLeftIn(readIfPresent(entry.file) ?? '', target, entry.yaml)

    if (left.length > 0) {
      report.failed.push(`${name} (${left.join(', ')})`)
    } else {
      report.scrubbed.push(name)
    }
  } catch (error: any) {
    report.failed.push(`${name} (unwritable: ${error?.code || 'error'})`)
  }
}

/** Take the relay key out of every file in every home under `root`. Never throws. */
export function scrubRelayKeyFromHomes(root: string, target: RelayKeyTarget): RelayKeyScrubReport {
  const report: RelayKeyScrubReport = { scrubbed: [], failed: [] }

  for (const home of relayKeyHomes(root)) {
    for (const entry of relayKeyFiles(home)) {
      scrubFile(entry, target, path.relative(root, entry.file) || entry.file, report)
    }
  }

  return report
}

/** The scrub, for a log line: file names and counts only. */
export function describeRelayKeyScrub(report: RelayKeyScrubReport): string {
  const removed = report.scrubbed.length
    ? `relay key removed from ${report.scrubbed.length} local file(s)`
    : 'no local file held the relay key'

  return report.failed.length ? `${removed}; STILL IN ${report.failed.join(', ')}` : removed
}

export interface SignOutCleanupDeps {
  /** HERMES_HOME. */
  root: string
  /** The credential the sign-out just cleared (resolveManagedConfig() read before it). */
  managed: { baseUrl?: null | string; key?: null | string }
  /** resolveApexEndpoints(process.env).relayBaseUrl. */
  defaultRelayBaseUrl: string
  /** Restart every process still on a key, once idle (StaleRelayKeyRestarts). */
  restartHolders: (reason: string) => unknown
}

/**
 * After a sign-out the server confirmed: no copy of the key left in any home,
 * and every engine or gateway still on it restarts once idle. Returns the
 * detail for the sign-out log line.
 */
export function cleanUpAfterSignOut(deps: SignOutCleanupDeps): string {
  const report = scrubRelayKeyFromHomes(deps.root, {
    baseUrls: relayBaseUrls(deps.managed.baseUrl, deps.defaultRelayBaseUrl),
    key: deps.managed.key
  })

  void deps.restartHolders('sign-out')

  return `${describeRelayKeyScrub(report)}; engines still on it restart once idle`
}

export interface SignedOutSweepDeps {
  /** HERMES_HOME. */
  root: string
  /** isManagedEnabled(process.env). */
  managedEnabled: boolean
  /** resolveManagedConfig().key: the stored or env key, '' when there is none. */
  key: null | string | undefined
  /** apex-managed.json exists: one that failed to decrypt is still somebody's sign-in. */
  credentialStored: boolean
  baseUrls: string[]
  log: Log
}

/**
 * While nobody is signed in (managed on, no key, no stored credential at all),
 * a relay key left in an anchor or a backup came from a sign-out on an older
 * version, or one whose scrub failed: take it out. The exact key is unknown by
 * then, so only the anchors are cleared. Logs only when it found something.
 */
export function sweepSignedOutRelayKeys(deps: SignedOutSweepDeps): RelayKeyScrubReport {
  if (!deps.managedEnabled || deps.key || deps.credentialStored) {
    return { scrubbed: [], failed: [] }
  }

  const report = scrubRelayKeyFromHomes(deps.root, { baseUrls: uniqueUrls(deps.baseUrls) })

  if (report.scrubbed.length || report.failed.length) {
    deps.log(`[managed] signed out: ${describeRelayKeyScrub(report)} (left by an earlier sign-out)`)
  }

  return report
}

export interface PreviousAccountKeyDeps {
  /** The credential before this sign-in committed (resolveManagedConfig()). */
  previous: { accessToken?: null | string; key?: null | string }
  /** The login token of the account just signed in. */
  nextAccessToken: string
  deviceInstanceId: string
  /** POST the revoke body to provision-key/revoke with `bearer`. */
  post: (bearer: string, body: Record<string, unknown>) => Promise<unknown>
  log: Log
}

/**
 * Signing in as another account (the re-sign-in screen takes any account)
 * replaces the stored key without signing out. Revoke the previous account's
 * key for this computer with that account's own login, by the hash of the exact
 * key it held: the server's held-key path, which needs no revision and touches
 * nothing else (desktop_provisioning.revoke_desktop_agent_key). Best effort: an
 * expired login cannot revoke it, and the server then retires it when that
 * account fills its eight computers (hc-1111). Never throws.
 */
export async function revokePreviousAccountKey(deps: PreviousAccountKeyDeps): Promise<'failed' | 'kept' | 'revoked'> {
  const key = String(deps.previous.key || '').trim()
  const token = String(deps.previous.accessToken || '').trim()
  const before = managedAccountId(token)

  if (!key || !before || before === managedAccountId(deps.nextAccessToken)) {
    return 'kept'
  }

  try {
    requireRevokedDeviceKey(await deps.post(token, revokeDeviceBody(deps.deviceInstanceId, key)))
    deps.log(
      "[managed] signed in as another account: the server revoked the previous account's relay key for this computer"
    )

    return 'revoked'
  } catch (error: any) {
    deps.log(
      `[managed] signed in as another account: the previous account's relay key for this computer was not revoked ` +
        `(${signOutFailureReason(error, [key, token])}); the server retires it when that account reaches its computer limit`
    )

    return 'failed'
  }
}
