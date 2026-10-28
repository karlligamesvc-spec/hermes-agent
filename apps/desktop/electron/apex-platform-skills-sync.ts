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
import {
  applyPlatformSkills,
  fetchPlatformSkills,
  isPlatformSkillsEnabled,
  normalizeStoredManifest,
  platformSkillsCategoryDir,
  removePlatformSkills,
  shouldApplyManifest
} from './apex-platform-skills'

/** Inside a profile's `skills/apexnodes/`: the root manifest hash that copy came from. */
export const PROFILE_SKILLS_STAMP = '.apex-manifest'

/** Per home, OUTSIDE `skills/`: the runtime indexes every SKILL.md under skills/,
 * so a half-copied sibling there would list each platform skill twice (the
 * hc-1002 `.bak` class). */
export const PROFILE_SKILLS_STAGING = '.apexnodes-skill-staging'

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
}: any): Promise<{ newStored: null | { count: number; installedAt: number; manifestHash: string } }> {
  const state = normalizeStoredManifest(stored)
  const fill = (manifestHash: string) => fillProfilePlatformSkills({ env, homes, log, manifestHash, skillsRoot })

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

  // The root keeps what it has; the profiles still catch up to it.
  const keepInstalled = (line: string) => {
    if (line) {
      log(line)
    }

    fill(state.manifestHash)

    return { newStored: null }
  }

  const jwt = String(token() || '').trim()

  if (!jwt) {
    return keepInstalled(`[platform-skills] no login JWT on hand; skipping (${reason})`)
  }

  const fetched = await fetchPlatformSkills({
    apiBase,
    fetchJson,
    knownHash: state.manifestHash,
    log,
    timeoutMs,
    token: jwt
  })

  if (!fetched) {
    return keepInstalled('') // offline / 401 (cloudLogin shows 「登录已失效」) / garbage, already logged
  }

  if (fetched.unchanged) {
    return keepInstalled(`[platform-skills] manifest ${fetched.manifestHash.slice(0, 12)} unchanged (${reason})`)
  }

  if (!shouldApplyManifest(fetched.manifestHash, state.manifestHash)) {
    return keepInstalled(`[platform-skills] manifest matches installed; no re-apply (${reason})`)
  }

  const result = applyPlatformSkills({ log, skills: fetched.skills, skillsRoot })
  log(
    `[platform-skills] installed ${result.installed.length} skill(s) manifest=${fetched.manifestHash.slice(0, 12)} (${reason})`
  )

  if (result.skippedUnsafe.length) {
    log(
      `[platform-skills] skipped ${result.skippedUnsafe.length} unsafe entr(ies): ${result.skippedUnsafe.slice(0, 5).join(', ')}`
    )
  }

  fill(fetched.manifestHash)

  return { newStored: { count: result.installed.length, installedAt: now(), manifestHash: fetched.manifestHash } }
}
