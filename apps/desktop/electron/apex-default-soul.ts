import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { APEX_DESKTOP_DEFAULT_SOUL } from '../shared/apex-default-soul'

export { APEX_DESKTOP_DEFAULT_SOUL }

/**
 * hc-1042: sha256 of the normalized text (see normalizedSoul) of every SOUL.md that upstream Hermes
 * seeded by itself, collected from the whole fork history of hermes_cli/default_soul.py,
 * scripts/install.sh, scripts/install.ps1, docker/SOUL.md, `hermes doctor --fix` and profile creation.
 * Such a file carries no user intent, so boot swaps it for the APEX identity. Never add a text a user
 * could have written. The texts and their sources are in fixtures/upstream-souls.json;
 * tests/hermes_cli/test_apex_desktop_upstream_souls.py fails when an upstream sync ships a new default
 * without its hash here.
 */
export const UPSTREAM_SEEDED_SOULS: Readonly<Record<string, string>> = {
  '7ea5e02279dd4190ba8df831084b3a4c0394ac574656c6143ed8804f3b9a8822': 'installer-scaffold-2026-02',
  '700e98499261241803540c881218d5968d9a0adb406d161dde511f805e6a4bb1': 'doctor-scaffold-2026-02',
  e4d3e4f79763c4e245c4bd4bf203a24e7051e51888cac36192705ee7635a5531: 'doctor-template',
  '82fa3438d86f8b95c6e96be89d853c8b561b3e6973ed61c90e70e0231dd24a7e': 'installer-scaffold',
  a0709bd148f0011d432b42e14a13ea0ae2a015f5cdf57cf01dd955f93fa325f3: 'default-2026-03-14',
  '2765a846e1bb371d78d3b93b403dfb0f8d1ba1a9895edb5f608367abfe81194d': 'default-2026-03-26',
  '6bc146a50e8fe3bd555e89a77e93af1f781cece8cf549f0d7a02ee2389811c72': 'installer-scaffold-bare',
  '36c1f5a2e92cd1d018311eaf4c8f1e8886672eae78212e033c681d0e3d5d506f': 'default-2026-08-29',
  '731f9a403cdc6a5c5c0e5c956a9238f54dae8b6e253bc29f9e47efb38eb6081a': 'default-2026-08-29-ascii'
}

const APEX_SOUL_FILE = `${APEX_DESKTOP_DEFAULT_SOUL}\n`
const LEGACY_PROTOCOL_HEADING = '## Messaging other agents'
// tools/bot_mode_probe.py strip_legacy_protocol: the plugin-era Bot Mode section, through the next H2 or EOF.
const LEGACY_PROTOCOL_SECTION = /\n*## Messaging other agents[ \t]*\n[\s\S]*?(?=\n## |$)/

/** hermes_cli/default_soul.py _normalize_soul, minus the Bot Mode section the engine drops on read. */
export function normalizedSoul(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')

  const withoutProtocol = unified.includes(LEGACY_PROTOCOL_HEADING)
    ? unified.replace(LEGACY_PROTOCOL_SECTION, '\n')
    : unified

  return withoutProtocol.trim()
}

/** The upstream seed `text` is, or null when anyone could have written it. */
export function upstreamSeededSoul(text: string): null | string {
  const digest = createHash('sha256').update(normalizedSoul(text), 'utf8').digest('hex')

  return UPSTREAM_SEEDED_SOULS[digest] ?? null
}

export type ApexSoulOutcome =
  { kind: 'created' } | { kind: 'current' } | { kind: 'kept' } | { kind: 'replaced'; variant: string }

/** Swap an untouched upstream seed for the APEX identity; anything else is the user's and stays. */
function replaceUpstreamSoul(soulPath: string): ApexSoulOutcome {
  let before: string

  try {
    // A symlink or directory is the user's own arrangement.
    if (!fs.lstatSync(soulPath).isFile()) {
      return { kind: 'kept' }
    }

    before = fs.readFileSync(soulPath, 'utf8')
  } catch {
    return { kind: 'kept' }
  }

  if (normalizedSoul(before) === APEX_DESKTOP_DEFAULT_SOUL) {
    return { kind: 'current' }
  }

  const variant = upstreamSeededSoul(before)

  if (!variant) {
    return { kind: 'kept' }
  }

  const staged = `${soulPath}.apex-${process.pid}.tmp`
  fs.writeFileSync(staged, APEX_SOUL_FILE, { encoding: 'utf8', mode: 0o600 })

  try {
    // A save that landed after the read wins: only the exact text judged above is swapped.
    if (fs.readFileSync(soulPath, 'utf8') !== before) {
      fs.rmSync(staged, { force: true })

      return { kind: 'kept' }
    }

    fs.renameSync(staged, soulPath)
  } catch (error) {
    fs.rmSync(staged, { force: true })
    throw error
  }

  return { kind: 'replaced', variant }
}

/**
 * The default profile's SOUL.md: seed the APEX identity when absent, upgrade an untouched upstream seed
 * (installers and engines before hc-813 wrote "Hermes Agent, built by Nous Research"), keep the rest.
 */
export function ensureApexDesktopSoul(hermesHome: string): ApexSoulOutcome {
  const soulPath = path.join(hermesHome, 'SOUL.md')

  fs.mkdirSync(hermesHome, { recursive: true })

  try {
    fs.writeFileSync(soulPath, APEX_SOUL_FILE, { encoding: 'utf8', flag: 'wx', mode: 0o600 })

    return { kind: 'created' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  return replaceUpstreamSoul(soulPath)
}

/**
 * Named profiles get the same upgrade but never a new file: SOUL.md is what marks a directory under
 * profiles/ as a real profile (hermes_cli/container_boot.py, service_manager.py).
 */
export function upgradeProfileSouls(hermesHome: string): Record<string, ApexSoulOutcome | { kind: 'failed' }> {
  const results: Record<string, ApexSoulOutcome | { kind: 'failed' }> = {}
  let entries: fs.Dirent[]

  try {
    entries = fs.readdirSync(path.join(hermesHome, 'profiles'), { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const soulPath = path.join(hermesHome, 'profiles', entry.name, 'SOUL.md')

    // Hidden entries are clone staging dirs (profiles/.<name>.staging-<pid>).
    if (!entry.isDirectory() || entry.name.startsWith('.') || !fs.existsSync(soulPath)) {
      continue
    }

    try {
      results[entry.name] = replaceUpstreamSoul(soulPath)
    } catch {
      results[entry.name] = { kind: 'failed' }
    }
  }

  return results
}

function describeOutcome(outcome: ApexSoulOutcome): string {
  switch (outcome.kind) {
    case 'created':
      return 'created APEX default'

    case 'current':
      return 'APEX default in place'

    case 'kept':
      return 'kept user SOUL.md'

    case 'replaced':
      return `replaced untouched upstream SOUL.md (${outcome.variant}) with APEX default`
  }
}

/** Boot step for the default profile and every named profile; returns the one `[soul]` log line. */
export function ensureApexDesktopSouls(hermesHome: string): string {
  const line = `default: ${describeOutcome(ensureApexDesktopSoul(hermesHome))}`
  const profiles = Object.entries(upgradeProfileSouls(hermesHome))

  if (profiles.length === 0) {
    return line
  }

  const replaced: string[] = []
  const failed: string[] = []
  let unchanged = 0

  for (const [name, outcome] of profiles) {
    if (outcome.kind === 'replaced') {
      replaced.push(`${name} (${outcome.variant})`)
    } else if (outcome.kind === 'failed') {
      failed.push(name)
    } else {
      unchanged += 1
    }
  }

  const parts = [
    replaced.length ? `replaced ${replaced.join(', ')}` : null,
    failed.length ? `could not upgrade ${failed.join(', ')}` : null,
    `${unchanged} unchanged`
  ]

  return `${line}; profiles: ${parts.filter(Boolean).join(', ')}`
}
