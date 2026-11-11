/**
 * apex-platform-skills-sync.ts
 *
 * hc-1081 (multi-bot M5): the platform SKILL refresh, moved out of main.ts and
 * widened from the root `skills/` to every profile home main passes in (the
 * profiles that run on the managed relay, hc-1080 apex-profile-homes.ts). One
 * manifest, one writer per place:
 *
 *   - the root home (APEX) is written from the cloud manifest by
 *     applyPlatformSkills exactly as before: same fetch, same known_hash fast
 *     path, same fail-soft rules, same log lines;
 *   - every other listed home gets a copy of the root's installed
 *     `skills/apexnodes/`, stamped with the manifest hash it came from. A home
 *     whose stamp already matches is left alone, so a profile is written once
 *     per manifest change, plus once if it never had a stamp: a new assistant,
 *     or a profile created before this build that still holds the snapshot
 *     cloned from the root back then.
 *
 * Only `<home>/skills/apexnodes/` (exclusively ours, see apex-platform-skills.ts)
 * and a staging dir outside `skills/` are ever touched: bundled skills, other
 * categories and skills the user installed are never read or written. Profiles
 * do not read the root through `skills.external_dirs`: a profile cloned from the
 * root holds its own copy of the category, and a local skill outranks an
 * external one of the same name (agent/skill_utils.py), so the stale copy would
 * keep winning.
 *
 * A failed fetch (offline, garbage, a 401 on the stored login JWT) still leaves
 * the root's installed set standing; apex-cloud-login.ts hears the 401 in the
 * transport and asks the user to sign in again (hc-1073). The profile copy runs
 * on those paths too, from what the root holds, because it needs no network.
 *
 * M2 (hc-1078) calls `window.hermesDesktop.syncApexProfileSkills(profile)` right
 * after it creates an assistant and hc-1080 has put its config on the relay, so
 * the new assistant has the skills from its first turn.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { IpcHandleRegistry } from './apex-account-reads'
import { desktopClientHeaders } from './apex-desktop-client'
import {
  applyPlatformSkills,
  fetchPlatformSkills,
  isPlatformSkillsEnabled,
  normalizeStoredManifest,
  PLATFORM_SKILLS_STAGING,
  platformSkillsCategoryDir,
  removePlatformSkills,
  shouldApplyManifest
} from './apex-platform-skills'

/** Inside a profile's `skills/apexnodes/`: the root manifest hash that copy came from. */
export const PROFILE_SKILLS_STAMP = '.apex-manifest'

/** Per home, OUTSIDE `skills/`: the runtime indexes every SKILL.md under skills/,
 * so a half-copied sibling there would list each platform skill twice (the
 * hc-1002 `.bak` class). The root's install builds there too (hc-1205). */
export const PROFILE_SKILLS_STAGING = PLATFORM_SKILLS_STAGING

type Log = (msg: string) => void

/** One Hermes home; hc-1080's ApexProfileHome has this shape (root = profile `default`). */
export interface SkillsHome {
  home: string
  profile: string
}

interface FillArgs {
  env: Record<string, string | undefined>
  homes: unknown
  log?: Log
  manifestHash: unknown
  skillsRoot: string
}

function readStamp(categoryDir: string) {
  try {
    return fs.readFileSync(path.join(categoryDir, PROFILE_SKILLS_STAMP), 'utf8').trim()
  } catch {
    return ''
  }
}

/** The listed homes other than the root itself (the root is written from the manifest). */
function otherHomes(skillsRoot: string, homes: unknown): SkillsHome[] {
  const root = path.resolve(skillsRoot)

  return (Array.isArray(homes) ? homes : []).filter(
    entry => typeof entry?.home === 'string' && entry.home !== '' && path.resolve(entry.home, 'skills') !== root
  )
}

function copyIntoHome(sourceDir: string, home: string, manifestHash: string) {
  const target = platformSkillsCategoryDir(path.join(home, 'skills'))

  if (readStamp(target) === manifestHash) {
    return false
  }

  const staging = path.join(home, PROFILE_SKILLS_STAGING)
  fs.rmSync(staging, { force: true, recursive: true })
  fs.cpSync(sourceDir, staging, { recursive: true })
  fs.writeFileSync(path.join(staging, PROFILE_SKILLS_STAMP), `${manifestHash}\n`, 'utf8')
  fs.rmSync(target, { force: true, recursive: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(staging, target)

  return true
}

/**
 * Bring each listed profile home to the platform skills the root holds
 * (`manifestHash` = main's stored manifest). Runs at the end of every refresh,
 * and is the entry M2 (hc-1078) calls right after it creates an assistant.
 * A no-op while the switch is off or nothing was ever installed. Never throws:
 * a home that fails is logged and the rest still run.
 *
 * @returns the profiles it wrote
 */
export function fillProfilePlatformSkills({
  env,
  homes,
  log = () => {},
  manifestHash,
  skillsRoot
}: FillArgs): string[] {
  const hash = typeof manifestHash === 'string' ? manifestHash.trim() : ''
  const targets = otherHomes(skillsRoot, homes)

  if (!isPlatformSkillsEnabled(env) || !hash || targets.length === 0) {
    return []
  }

  const sourceDir = platformSkillsCategoryDir(skillsRoot)

  if (!fs.existsSync(sourceDir)) {
    log(
      `[platform-skills] root has no ${path.basename(sourceDir)}/ for manifest=${hash.slice(0, 12)}; profiles left as they are`
    )

    return []
  }

  const filled: string[] = []

  for (const { home, profile } of targets) {
    try {
      if (copyIntoHome(sourceDir, home, hash)) {
        filled.push(profile)
      }
    } catch (error: any) {
      log(`[platform-skills] profile copy skipped ${profile} (${home}): ${(error && error.message) || error}`)
    }
  }

  if (filled.length) {
    log(`[platform-skills] copied manifest=${hash.slice(0, 12)} into ${filled.length} profile(s): ${filled.join(', ')}`)
  }

  return filled
}

/**
 * The M2 entry for one assistant. `ok` is false when `profile` is not among the
 * listed homes (not a profile, or its config is not on the managed relay yet)
 * and nothing is written; the root (`default`) is written from the manifest, so
 * it reports ok without a copy. Never throws.
 */
export function syncProfilePlatformSkills({ profile, ...args }: FillArgs & { profile: unknown }) {
  const entry = (Array.isArray(args.homes) ? args.homes : []).find(
    candidate => typeof profile === 'string' && candidate?.profile === profile
  )

  if (!entry) {
    return { filled: false, ok: false }
  }

  return { filled: fillProfilePlatformSkills({ ...args, homes: [entry] }).length > 0, ok: true }
}

/** main.ts registers the M2 entry with one call; `current` is read on every invoke. */
export function registerProfileSkillsSync(ipcMain: IpcHandleRegistry, current: () => FillArgs): void {
  ipcMain.handle('hermes:apex:syncProfileSkills', async (_event, profile) =>
    syncProfilePlatformSkills({ ...current(), profile })
  )
}

/** A manifest the server sent because it differs from the installed one; its skills are already validated. */
export interface FetchedPlatformSkills {
  manifestHash: string
  skills: { files: { content: string; path: string }[]; hash: string; name: string; version: string }[]
}

/** What main persists after an install (userData/apex-platform-skills.json). */
export interface StoredPlatformSkills {
  count: number
  installedAt: number
  manifestHash: string
}

/**
 * The fetch half of a refresh (hc-1205 runs it on its own while the app is open): one
 * request with the installed hash as `known_hash`, saying which Desktop asks (hc-1201).
 * Null when there is nothing to install (no login JWT, offline, a 401, garbage, an
 * unchanged or identical manifest), each logged as before. Writes nothing.
 *
 * @param opts.env main's environment, where the Desktop version and platform are
 * @param opts.token a getter, read only here
 */
export async function fetchNewPlatformSkills({
  apiBase,
  env,
  fetchJson,
  log = () => {},
  reason,
  stored,
  timeoutMs = 12_000,
  token
}: any): Promise<FetchedPlatformSkills | null> {
  const state = normalizeStoredManifest(stored)
  const jwt = String(token() || '').trim()

  if (!jwt) {
    log(`[platform-skills] no login JWT on hand; skipping (${reason})`)

    return null
  }

  const fetched = await fetchPlatformSkills({
    apiBase,
    fetchJson,
    // Which Desktop asks (hc-1201): `env` is main's, where registerOpenfilmStudio wrote it before any sync.
    headers: desktopClientHeaders(env),
    knownHash: state.manifestHash,
    log,
    timeoutMs,
    token: jwt
  })

  if (!fetched) {
    return null // offline / 401 (cloudLogin shows 「登录已失效」) / garbage, already logged
  }

  if (fetched.unchanged) {
    log(`[platform-skills] manifest ${fetched.manifestHash.slice(0, 12)} unchanged (${reason})`)

    return null
  }

  if (!shouldApplyManifest(fetched.manifestHash, state.manifestHash)) {
    log(`[platform-skills] manifest matches installed; no re-apply (${reason})`)

    return null
  }

  return { manifestHash: fetched.manifestHash, skills: fetched.skills }
}

/**
 * The install half: the root from the manifest, then a stamped copy in every listed
 * profile. Returns the state main persists. fs errors on the root propagate.
 */
export function installPlatformSkills({
  env,
  fetched,
  homes,
  log = () => {},
  now = Date.now,
  reason,
  skillsRoot
}: {
  env: Record<string, string | undefined>
  fetched: FetchedPlatformSkills
  homes: unknown
  log?: Log
  now?: () => number
  reason: string
  skillsRoot: string
}): StoredPlatformSkills {
  const result = applyPlatformSkills({ log, skills: fetched.skills, skillsRoot })
  log(
    `[platform-skills] installed ${result.installed.length} skill(s) manifest=${fetched.manifestHash.slice(0, 12)} (${reason})`
  )

  if (result.skippedUnsafe.length) {
    log(
      `[platform-skills] skipped ${result.skippedUnsafe.length} unsafe entr(ies): ${result.skippedUnsafe.slice(0, 5).join(', ')}`
    )
  }

  fillProfilePlatformSkills({ env, homes, log, manifestHash: fetched.manifestHash, skillsRoot })

  return { count: result.installed.length, installedAt: now(), manifestHash: fetched.manifestHash }
}

/**
 * The whole refresh, dependency-injected like syncPlatformPlugins: main.ts
 * passes the real transport, paths and stored state, then persists `newStored`
 * when it is not null. Never throws past a failing fetch; fs errors on the root
 * propagate to main's catch-all, as before.
 *
 * @param opts.token a getter, so the switch-off path never reads the login JWT
 */
export async function syncPlatformSkills({
  apiBase,
  env,
  fetchJson,
  homes,
  log = () => {},
  now = Date.now,
  reason,
  skillsRoot,
  stored,
  timeoutMs = 12_000,
  token
}: any): Promise<{ newStored: null | StoredPlatformSkills }> {
  const state = normalizeStoredManifest(stored)

  // Feature switch OFF → revert every listed home to the no-platform-SKILL
  // state (idempotent) and clear the cache so a later re-enable re-pulls.
  if (!isPlatformSkillsEnabled(env)) {
    const { removed } = removePlatformSkills({ log, skillsRoot })

    for (const { home } of otherHomes(skillsRoot, homes)) {
      removePlatformSkills({ log, skillsRoot: path.join(home, 'skills') })
    }

    log(`[platform-skills] disabled via APEXNODES_PLATFORM_SKILLS; reverted (${reason})`)

    return { newStored: removed || state.manifestHash ? { count: 0, installedAt: now(), manifestHash: '' } : null }
  }

  const fetched = await fetchNewPlatformSkills({
    apiBase,
    env,
    fetchJson,
    log,
    reason,
    stored: state,
    timeoutMs,
    token
  })

  if (!fetched) {
    // The root keeps what it has; the profiles still catch up to it.
    fillProfilePlatformSkills({ env, homes, log, manifestHash: state.manifestHash, skillsRoot })

    return { newStored: null }
  }

  return { newStored: installPlatformSkills({ env, fetched, homes, log, now, reason, skillsRoot }) }
}
