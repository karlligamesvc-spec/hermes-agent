/**
 * hc-1078 (multi-bot M2): create, rename / restyle and delete an assistant in single-thread
 * product mode. One assistant = one Hermes profile (hc-1074 plan): APEX is the default profile,
 * every other assistant a named one.
 *
 * Everything goes to the default profile's engine through the same JSON-RPC methods upstream Bot
 * Mode uses (`profiles.list / create / describe / configure`), so no pool engine is woken just to
 * rename an assistant. Deleting goes through `host.deleteProfile`, which stops that profile's engine
 * before its directory goes (hermes-agent#52279).
 *
 * - The directory name is generated (`apex-bot-2`, `apex-bot-3`, …) and never changes: renaming a
 *   named profile upstream stops its engine and moves its directory.
 * - The name and look live in profile.yaml `ui_meta.apex` = `{ name, shape, color }` (`color` is the
 *   palette id, e.g. `blue`; the sidebar draws the hex), written with
 *   the per-key revision check (`ui_meta_expected_revisions`), so an edit made from a stale sheet
 *   is refused instead of silently overwriting a newer one. `ui_meta['hermes-bots']` is never
 *   touched: once a profile carries it, the engine treats it as a Bot Mode profile.
 * - A new assistant is always cloned from default (`clone_from: 'default'`): only that copy carries
 *   the plugin enable list with apex-overlay and the generation tools.
 * - APEX keeps its look (K6) and cannot be deleted; renaming it writes only `ui_meta.apex.name`.
 */

import { apexBotNameFromSoul, composeApexBotSoul, renameInApexBotSoul } from '../../shared/apex-bot-soul'

import { requestGatewayForProfile } from './gateway'

export const APEX_PROFILE = 'default'

/** The name field's limit, in characters (prototype ⑦: `maxlength="12"`). */
export const BOT_NAME_MAX = 12

const PROFILE_PREFIX = 'apex-bot-'

/** profiles.create answers 4062 for a name that is taken or invalid (tui_gateway/methods_profiles.py). */
const CREATE_REFUSED = 4062

const CREATE_ATTEMPTS = 3

/** How long a new assistant waits for the main process to finish setting it up before opening anyway. */
const SETUP_WAIT_MS = 20_000

export interface ApexBotLook {
  name: string
  shape?: string
  color?: string
}

export type BotOpFailure = 'apex' | 'conflict' | 'failed' | 'full'

export class BotOpError extends Error {
  readonly kind: BotOpFailure

  constructor(kind: BotOpFailure, message: string) {
    super(message)
    this.name = 'BotOpError'
    this.kind = kind
  }
}

interface ProfileRow {
  name?: string
  previous_names?: unknown
  ui_meta?: Record<string, unknown>
  ui_meta_revisions?: Record<string, unknown>
}

interface ConfigureResult {
  applied?: { soul?: boolean; ui_meta?: boolean; ui_meta_conflicts?: unknown }
}

function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return requestGatewayForProfile<T>(APEX_PROFILE, method, params)
}

/** Trimmed, one line, inner whitespace collapsed: the name as it is shown and stored. */
export function cleanBotName(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type BotNameProblem = 'empty' | 'taken' | 'tooLong'

/** Why `raw` cannot be saved, or null. `taken` holds the other assistants' names (APEX included). */
export function botNameProblem(raw: string, taken: readonly string[]): BotNameProblem | null {
  const name = cleanBotName(raw)

  if (!name) {
    return 'empty'
  }

  if (Array.from(name).length > BOT_NAME_MAX) {
    return 'tooLong'
  }

  const folded = name.toLocaleLowerCase()

  return taken.some(other => cleanBotName(other).toLocaleLowerCase() === folded) ? 'taken' : null
}

/** How many more assistants fit; `count` and `max` both include APEX. */
export function botsLeft(count: number, max: number): number {
  return Math.max(0, max - count)
}

/** The first free `apex-bot-N`, from 2 up (APEX is the first). */
export function nextBotProfileName(taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, name => name.toLowerCase()))
  let n = 2

  while (used.has(`${PROFILE_PREFIX}${n}`)) {
    n += 1
  }

  return `${PROFILE_PREFIX}${n}`
}

/** `ui_meta.apex` as stored, keeping only well-formed fields. */
export function apexLookFrom(uiMeta: unknown): Partial<ApexBotLook> {
  const raw = uiMeta && typeof uiMeta === 'object' ? (uiMeta as { apex?: unknown }).apex : null

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const look: Partial<ApexBotLook> = {}

  for (const key of ['name', 'shape', 'color'] as const) {
    const value = (raw as Record<string, unknown>)[key]

    if (typeof value === 'string' && value.trim()) {
      look[key] = value
    }
  }

  return look
}

function revisionOf(row: ProfileRow | undefined): number {
  const value = row?.ui_meta_revisions?.apex

  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

async function listProfiles(): Promise<ProfileRow[]> {
  const result = await request<{ profiles?: ProfileRow[] }>('profiles.list', { include_sessions: false })

  return Array.isArray(result?.profiles) ? result.profiles : []
}

function takenProfileNames(rows: readonly ProfileRow[]): Set<string> {
  const taken = new Set<string>()

  for (const row of rows) {
    if (row.name) {
      taken.add(row.name)
    }

    // A renamed profile's old names still resolve to it.
    if (Array.isArray(row.previous_names)) {
      for (const old of row.previous_names) {
        if (typeof old === 'string') {
          taken.add(old)
        }
      }
    }
  }

  return taken
}

function storedLook(profile: string, look: ApexBotLook): ApexBotLook {
  const name = cleanBotName(look.name)

  return profile === APEX_PROFILE ? { name } : { name, shape: look.shape, color: look.color }
}

async function writeLook(profile: string, look: ApexBotLook, revision: number): Promise<void> {
  const result = await request<ConfigureResult>('profiles.configure', {
    name: profile,
    ui_meta: { apex: storedLook(profile, look) },
    ui_meta_expected_revisions: { apex: revision }
  })

  if (result?.applied?.ui_meta === true) {
    return
  }

  if (result?.applied?.ui_meta_conflicts) {
    throw new BotOpError('conflict', `ui_meta.apex of ${profile} changed since revision ${revision}`)
  }

  throw new BotOpError('failed', `profiles.configure did not write ui_meta.apex for ${profile}`)
}

/**
 * The main-process steps that put APEX's config and platform skills into a profile. hc-1080 writes the
 * managed relay config; hc-1081 then copies the root's platform skills into every profile that config
 * marks as managed, so it must run second (before the first step it does not see the new profile and
 * answers `{ ok: false, filled: false }`). Typed here: global.d.ts is past its size cap.
 */
interface ProfileSetupBridge {
  healApexProfileConfig?: (profile: string) => Promise<unknown>
  syncApexProfileSkills?: (profile: string) => Promise<{ filled: boolean; ok: boolean }>
}

/** `step` settled, or SETUP_WAIT_MS gone by: a stuck main process must not hold the sheet open. */
async function settleWithin(step: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const waited = new Promise<void>(resolve => {
    timer = setTimeout(resolve, SETUP_WAIT_MS)
  })

  await Promise.race([
    Promise.resolve()
      .then(step)
      .catch(() => undefined),
    waited
  ])
  clearTimeout(timer)
}

/**
 * Run whichever setup steps this build has on a new profile, config first, then skills. Each is
 * best-effort: the clone already carries default's config and skills as of now, and both steps run
 * again at every launch and sign-in.
 */
export async function prepareNewBotProfile(profile: string): Promise<void> {
  const bridge = window.hermesDesktop as unknown as ProfileSetupBridge | undefined
  const heal = bridge?.healApexProfileConfig
  const skills = bridge?.syncApexProfileSkills

  if (typeof heal === 'function') {
    await settleWithin(() => heal.call(bridge, profile))
  }

  if (typeof skills === 'function') {
    await settleWithin(() => skills.call(bridge, profile))
  }
}

/** Delete through the Electron-intercepted door; loaded late, it is the plugin SDK's whole surface. */
async function deleteProfileDir(profile: string): Promise<void> {
  const { host } = await import('@/sdk')

  await host.deleteProfile(profile)
}

/**
 * Create an assistant and return its profile name. `count` is how many the sidebar lists now (APEX
 * included) and `max` the limit (`desktop_features.multi_bot_max`).
 */
export async function createBot(look: ApexBotLook, { count, max }: { count: number; max: number }): Promise<string> {
  if (count >= max) {
    throw new BotOpError('full', `already ${count} of ${max} assistants`)
  }

  const name = cleanBotName(look.name)
  const taken = takenProfileNames(await listProfiles())
  let profile = ''

  for (let attempt = 0; attempt < CREATE_ATTEMPTS && !profile; attempt += 1) {
    const candidate = nextBotProfileName(taken)

    try {
      await request('profiles.create', {
        name: candidate,
        clone_from: APEX_PROFILE,
        no_alias: true,
        share_auth: true,
        soul: composeApexBotSoul({ name })
      })
      profile = candidate
    } catch (error) {
      // Another window took the same name first: try the next one.
      if ((error as { code?: unknown })?.code !== CREATE_REFUSED) {
        throw error
      }

      taken.add(candidate)
    }
  }

  if (!profile) {
    throw new BotOpError('failed', 'no free profile name')
  }

  try {
    // A brand-new profile.yaml has no ui_meta revisions: 0 is the only right answer.
    await writeLook(profile, { ...look, name }, 0)
  } catch (error) {
    // Without its name the assistant would show up as `apex-bot-N`: take the half-made one back.
    await deleteProfileDir(profile).catch(() => undefined)

    throw error
  }

  await prepareNewBotProfile(profile)

  return profile
}

/** The look as stored now and the revision an edit of it must name. */
export async function readBotLook(profile: string): Promise<{ look: Partial<ApexBotLook>; revision: number }> {
  const row = (await listProfiles()).find(candidate => candidate.name === profile)

  if (!row) {
    throw new BotOpError('failed', `profile ${profile} is gone`)
  }

  return { look: apexLookFrom(row.ui_meta), revision: revisionOf(row) }
}

/**
 * Bring a named assistant's SOUL first line to `name` (`ui_meta.apex.name` is the authority). Runs
 * after every save, not only a rename, so a line left behind by an earlier failed write catches up.
 * A hand-written line keeps its words (renameInApexBotSoul answers null). Best-effort.
 */
async function syncSoulName(profile: string, name: string): Promise<void> {
  try {
    const described = await request<{ soul?: unknown }>('profiles.describe', { name: profile })
    const soul = typeof described?.soul === 'string' ? described.soul : ''
    const current = apexBotNameFromSoul(soul)
    const renamed = current === null || current === name ? null : renameInApexBotSoul(soul, name)

    if (renamed !== null) {
      await request('profiles.configure', { name: profile, soul: renamed })
    }
  } catch {
    // The sidebar already shows the new name; the line catches up on the next save.
  }
}

/**
 * Save a rename / new look made from a sheet that showed `revision`, then move a named assistant's
 * SOUL line to the saved name. APEX's SOUL is never touched: it is the APEX identity (hc-1042).
 */
export async function saveBotLook(profile: string, look: ApexBotLook, revision: number): Promise<void> {
  const name = cleanBotName(look.name)

  await writeLook(profile, { ...look, name }, revision)

  if (profile !== APEX_PROFILE) {
    await syncSoulName(profile, name)
  }
}

export async function deleteBot(profile: string): Promise<void> {
  if (profile.trim().toLowerCase() === APEX_PROFILE) {
    throw new BotOpError('apex', 'APEX cannot be deleted')
  }

  await deleteProfileDir(profile)
}
