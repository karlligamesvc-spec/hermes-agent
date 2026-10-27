/**
 * hc-1077 多助手第一期 M1: several assistants in single-thread product mode.
 *
 * One assistant is one Hermes profile (upstream Bot Mode's model, none of its
 * UI): APEX is the default profile, every other assistant a named profile with
 * its own 「APEX 主线」 (store/main-thread.ts; the title never changes with the
 * name). This module owns
 *
 * - the switch: `desktop_features.multi_bot` or this install's
 *   APEXNODES_MULTI_BOT, counted only in single-thread PRODUCT mode (the same
 *   rule main applies for the engine, electron/apex-multi-bot.ts, plus the
 *   renderer's developer mode); `desktop_features.multi_bot_max` caps the
 *   count, APEX included (default 5, K2);
 * - the roster: `profiles.list` rows with a SOUL.md that Bot Mode has not
 *   hidden, APEX first, the rest in creation order; each row's name and look
 *   read from the profile's `ui_meta.apex` ({@link ApexBotMeta});
 * - which assistant is on screen, and its name for every line that says
 *   「APEX」 about the assistant ({@link withBotName});
 * - switching: {@link openBot} activates the profile's engine
 *   (ensureGatewayForProfile, through store/profile) without remembering it as
 *   the startup profile, so the local IM gateway stays on APEX (K7).
 *
 * Off, nothing here is read: every surface keeps its single-assistant path.
 */

import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'

import {
  APEX_AVATAR_COLOR,
  APEX_BOT_COLORS,
  APEX_BOT_DEFAULT_LOOK,
  type ApexAvatarShape,
  type ApexBotColor,
  apexBotColorHex,
  isApexAvatarShape,
  isApexBotColor
} from '@/components/apex-avatar-look'
import type { DesktopClientConfigState } from '@/global'
import { desktopFeatureOn } from '@/lib/desktop-features'
import { persistBoolean, readJson, storedBoolean, writeJson } from '@/lib/storage'

import {
  $activeGatewayProfile,
  $gatewaySwapTarget,
  ensureGatewayProfile,
  normalizeProfileKey,
  pinNewChatProfile,
  requestFreshSession
} from './profile'
import { $singleThreadMode } from './single-thread'

// ── the switch ───────────────────────────────────────────────────────────────

export const MULTI_BOT_FEATURE = 'multi_bot'

/** The value this install last settled on, so the next launch paints the right sidebar before the config read lands. */
export const MULTI_BOT_HINT_KEY = 'apex.desktop.feature.multi-bot'

/** How many assistants, APEX included, when the client config says nothing (K2: APEX + 4 on every plan). */
export const MULTI_BOT_MAX_DEFAULT = 5

/** The switch as read: the admin client config or this install's own switch. */
export const $multiBotFlag = atom<boolean>(storedBoolean(MULTI_BOT_HINT_KEY, false))

/** Several assistants on screen: the switch, in single-thread product mode only. */
export const $multiBotMode = computed([$singleThreadMode, $multiBotFlag], (singleThread, on) => singleThread && on)

/** `desktop_features.multi_bot_max`, or {@link MULTI_BOT_MAX_DEFAULT}. The new-assistant sheet (hc-1078) enforces it. */
export const $multiBotMax = atom<number>(MULTI_BOT_MAX_DEFAULT)

/**
 * For code outside React. The plain flag is read first: with the switch off no
 * computed store is touched, so the off path schedules nothing (a computed
 * store read without a listener queues its own unmount timer).
 */
export function isMultiBotMode(): boolean {
  return $multiBotFlag.get() && $multiBotMode.get()
}

export function useMultiBotMode(): boolean {
  return useStore($multiBotMode)
}

/** The switch for one cached client-config state: an install switch wins, else the platform's literal `true`. */
export function multiBotSwitchFrom(
  state: null | Pick<DesktopClientConfigState, 'installSwitches' | 'payload'> | undefined
): boolean {
  const install = state?.installSwitches?.[MULTI_BOT_FEATURE]

  return typeof install === 'boolean' ? install : desktopFeatureOn(state?.payload, MULTI_BOT_FEATURE)
}

/** The cap from a client-config payload: a whole number of at least 1, else the default. */
export function multiBotMaxFrom(payload: unknown): number {
  const features =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { desktop_features?: unknown }).desktop_features
      : null

  const raw =
    features && typeof features === 'object' && !Array.isArray(features)
      ? (features as Record<string, unknown>).multi_bot_max
      : undefined

  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : MULTI_BOT_MAX_DEFAULT
}

function settle(on: boolean): void {
  $multiBotFlag.set(on)
  persistBoolean(MULTI_BOT_HINT_KEY, on)
}

let reading: null | Promise<boolean> = null

/** Read the switch once per window (a local disk read through main); never throws. */
export function loadMultiBotFlag(): Promise<boolean> {
  reading ??= (async () => {
    try {
      const state = await window.hermesDesktop?.clientConfig?.get()

      if (state) {
        settle(multiBotSwitchFrom(state))
        $multiBotMax.set(multiBotMaxFrom(state.payload))
      }
    } catch {
      // Keep the hint: a broken bridge is not the platform turning the feature off.
    }

    return $multiBotFlag.get()
  })()

  return reading
}

/** Tests only: forget the read and set the switch. */
export function setMultiBotFlagForTest(on: boolean): void {
  reading = null
  settle(on)
}

// ── the roster ───────────────────────────────────────────────────────────────

/** The profile that is APEX. */
export const APEX_PROFILE = 'default'

/** APEX's name until it is given another (K6: it can be renamed). The same in every locale. */
export const APEX_NAME = 'APEX'

/** The `ui_meta` key an assistant's name and look live under in its profile.yaml (never Bot Mode's `hermes-bots`). */
export const APEX_BOT_META_KEY = 'apex'

/**
 * What `ui_meta.apex` holds. Written through `profiles.configure` with
 * `ui_meta_expected_revisions: { apex: bot.revision }` (hc-1078 creates and
 * renames, hc-1082's rename tool writes `name`). Unknown values read as unset.
 */
export interface ApexBotMeta {
  /** An id from APEX_BOT_COLORS. Ignored on APEX, whose look is fixed. */
  color?: ApexBotColor
  /** Creation time, epoch ms: the roster's order after APEX. */
  created?: number
  name?: string
  /** One of APEX_AVATAR_SHAPES. Ignored on APEX. */
  shape?: ApexAvatarShape
}

export interface ApexBot {
  /** The Hermes profile; {@link APEX_PROFILE} is APEX. */
  profile: string
  isApex: boolean
  /** `ui_meta.apex.name`; else the profile name, or {@link APEX_NAME} for APEX. */
  name: string
  shape: ApexAvatarShape
  /** The hex drawn (APEX's purple for APEX). */
  color: string
  created: null | number
  /** The `apex` key's ui_meta revision (0 when never written): the compare-and-swap value for the next write. */
  revision: number
}

/** A `profiles.list` row, as far as the roster reads it. */
export interface BotProfileRow {
  is_default?: boolean
  last_session?: null | { id?: string; preview?: string }
  name: string
  ui_meta?: Record<string, unknown>
  ui_meta_revisions?: Record<string, number>
}

function metaOf(row: BotProfileRow | undefined, key: string): Record<string, unknown> {
  const value = row?.ui_meta?.[key]

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function isApexRow(row: BotProfileRow): boolean {
  return row.is_default === true || normalizeProfileKey(row.name) === APEX_PROFILE
}

/** Hidden through Bot Mode in developer mode: kept out of the product sidebar too. */
function isHiddenRow(row: BotProfileRow): boolean {
  return metaOf(row, 'hermes-bots').hidden === true
}

function createdOf(row: BotProfileRow): null | number {
  for (const created of [metaOf(row, APEX_BOT_META_KEY).created, metaOf(row, 'hermes-bots').created]) {
    if (typeof created === 'number' && Number.isFinite(created)) {
      return created
    }
  }

  return null
}

function nameOf(row: BotProfileRow | undefined, fallback: string): string {
  const name = metaOf(row, APEX_BOT_META_KEY).name

  return typeof name === 'string' && name.trim() ? name.trim() : fallback
}

function revisionOf(row: BotProfileRow | undefined): number {
  const revision = row?.ui_meta_revisions?.[APEX_BOT_META_KEY]

  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0
}

/** APEX's row: always present, always the purple circle; only the name is its own. */
export function apexBot(row?: BotProfileRow): ApexBot {
  return {
    color: APEX_AVATAR_COLOR,
    created: null,
    isApex: true,
    name: nameOf(row, APEX_NAME),
    profile: APEX_PROFILE,
    revision: revisionOf(row),
    shape: 'circle'
  }
}

/** Another assistant's row. A look it was never given (or one this build does not know) reads as the default look. */
export function namedBot(row: BotProfileRow): ApexBot {
  const meta = metaOf(row, APEX_BOT_META_KEY)
  const color = isApexBotColor(meta.color) ? meta.color : APEX_BOT_DEFAULT_LOOK.color

  return {
    color: apexBotColorHex(color),
    created: createdOf(row),
    isApex: false,
    name: nameOf(row, normalizeProfileKey(row.name)),
    profile: normalizeProfileKey(row.name),
    revision: revisionOf(row),
    shape: isApexAvatarShape(meta.shape) ? meta.shape : APEX_BOT_DEFAULT_LOOK.shape
  }
}

/**
 * The sidebar's assistants from a `profiles.list` answer: APEX first whatever
 * the list says, then every named profile that has a SOUL.md (`hasSoul`; an
 * unknown answer leaves it out for now) and is not hidden, oldest first. A
 * profile with no creation time goes after the dated ones, by name.
 */
export function botRosterFrom(rows: readonly BotProfileRow[], hasSoul: (profile: string) => boolean | null): ApexBot[] {
  const others = rows
    .filter(row => !isApexRow(row) && !isHiddenRow(row) && hasSoul(normalizeProfileKey(row.name)) === true)
    .map(namedBot)
    .sort(
      (a, b) =>
        (a.created ?? Number.POSITIVE_INFINITY) - (b.created ?? Number.POSITIVE_INFINITY) ||
        a.profile.localeCompare(b.profile)
    )

  return [apexBot(rows.find(isApexRow)), ...others]
}

const ROSTER_CACHE_KEY = 'apex.single-thread.bots.v1'

/**
 * The last roster this install showed, read back through the same checks a
 * fresh one passes. Only a first paint: its revisions are 0, so a write waits
 * for {@link refreshBotRoster}.
 */
function cachedRoster(): ApexBot[] {
  const raw = readJson<unknown>(ROSTER_CACHE_KEY)

  const rows = (Array.isArray(raw) ? raw : []).filter(
    (row): row is Partial<ApexBot> => Boolean(row) && typeof row === 'object'
  )

  const meta = (row: Partial<ApexBot>) => ({
    [APEX_BOT_META_KEY]: {
      color: APEX_BOT_COLORS.find(color => color.hex === row.color)?.id,
      created: row.created,
      name: row.name,
      shape: row.shape
    }
  })

  const apex = rows.find(row => row.profile === APEX_PROFILE)

  const others = rows
    .filter(row => typeof row.profile === 'string' && row.profile && row.profile !== APEX_PROFILE)
    .map(row => namedBot({ name: row.profile!, ui_meta: meta(row) }))

  return [apexBot(apex ? { name: APEX_PROFILE, ui_meta: meta(apex) } : undefined), ...others]
}

/** The assistants, APEX first. Painted from this install's last roster until the first read lands. */
export const $botRoster = atom<readonly ApexBot[]>(cachedRoster())

/** Per profile, the newest conversation `profiles.list` reported, with its last line (≤80 characters). */
export const $botLastSessions = atom<Readonly<Record<string, { id: string; preview: string }>>>({})

type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/** Named profiles known to have (true) or lack (false, with when) a SOUL.md. A yes holds; a no is asked again. */
const soulChecks = new Map<string, { at: number; has: boolean }>()
const SOUL_RECHECK_MS = 60_000

async function hasSoul(request: RequestGateway, profile: string, now: number): Promise<boolean | null> {
  const known = soulChecks.get(profile)

  if (known && (known.has || now - known.at < SOUL_RECHECK_MS)) {
    return known.has
  }

  try {
    const described = await request<{ soul?: unknown }>('profiles.describe', { name: profile })
    const has = typeof described?.soul === 'string' && described.soul.trim().length > 0

    soulChecks.set(profile, { at: now, has })

    return has
  } catch {
    return known?.has ?? null
  }
}

let rosterSerial = 0

/**
 * Read the roster through the active gateway (any profile's engine lists every
 * profile). A failed read keeps the roster on screen. Returns what is shown.
 */
export async function refreshBotRoster(request: RequestGateway): Promise<readonly ApexBot[]> {
  const serial = ++rosterSerial
  let rows: BotProfileRow[]

  try {
    const listed = await request<{ profiles?: BotProfileRow[] }>('profiles.list', {})

    rows = (listed?.profiles ?? []).filter(row => row && typeof row.name === 'string' && row.name.trim())
  } catch {
    return $botRoster.get()
  }

  const now = Date.now()
  const souls = new Map<string, boolean | null>()

  await Promise.all(
    rows
      .filter(row => !isApexRow(row))
      .map(async row => {
        const profile = normalizeProfileKey(row.name)

        souls.set(profile, await hasSoul(request, profile, now))
      })
  )

  if (serial !== rosterSerial) {
    return $botRoster.get()
  }

  const roster = botRosterFrom(rows, profile => souls.get(profile) ?? null)
  const lastSessions: Record<string, { id: string; preview: string }> = {}

  for (const row of rows) {
    const last = row.last_session

    if (last?.id) {
      lastSessions[isApexRow(row) ? APEX_PROFILE : normalizeProfileKey(row.name)] = {
        id: String(last.id),
        preview: String(last.preview || '')
      }
    }
  }

  $botRoster.set(roster)
  $botLastSessions.set(lastSessions)
  writeJson(ROSTER_CACHE_KEY, roster)

  return roster
}

// ── the assistant on screen ──────────────────────────────────────────────────

/** The assistant a click asked for, until its engine is active (or the switch failed). */
export const $botIntent = atom<null | string>(null)

/** The profile of the assistant on screen: the one asked for or being switched to, else the active one. */
export const $currentBotProfile = computed(
  [$botIntent, $gatewaySwapTarget, $activeGatewayProfile],
  (intent, swapping, active) => normalizeProfileKey(intent ?? swapping ?? active)
)

/** `profile`'s roster row, or what can be said of it before the roster lists it. */
export function botFor(roster: readonly ApexBot[], profile: string): ApexBot {
  const key = normalizeProfileKey(profile)

  return roster.find(bot => bot.profile === key) ?? (key === APEX_PROFILE ? apexBot() : namedBot({ name: key }))
}

/** The assistant on screen while several are; null in every other mode (callers keep their APEX copy). */
export const $currentBot = computed([$multiBotMode, $botRoster, $currentBotProfile], (on, roster, profile) =>
  on ? botFor(roster, profile) : null
)

/** APEX's row while several assistants are on screen (its name may have changed); null otherwise. */
export const $apexBot = computed([$multiBotMode, $botRoster], (on, roster) =>
  on ? botFor(roster, APEX_PROFILE) : null
)

/**
 * `text` with the assistant's name where it says APEX: unchanged when `name`
 * is null (one assistant) or APEX's own. Only for copy whose every 「APEX」 is
 * the assistant speaking or being spoken to — never the app's name.
 */
export function withBotName(text: string, name: null | string | undefined): string {
  return !name || name === APEX_NAME ? text : text.split(APEX_NAME).join(name)
}

/** The on-screen assistant's name while several are on screen; null otherwise. */
export function useBotName(): null | string {
  return useStore($currentBot)?.name ?? null
}

const NO_LOOK: { color?: string; shape?: ApexAvatarShape } = {}

/** The on-screen assistant's face, for `<ApexAvatar {...look} />`; empty (APEX's own) with one assistant. */
export function useBotLook(): { color?: string; shape?: ApexAvatarShape } {
  const bot = useStore($currentBot)

  return bot ? { color: bot.color, shape: bot.shape } : NO_LOOK
}

/** APEX is always first, keeps its purple circle and cannot be deleted (K6): hc-1078's row menu reads these. */
export function canDeleteBot(bot: Pick<ApexBot, 'isApex'>): boolean {
  return !bot.isApex
}

export function canRestyleBot(bot: Pick<ApexBot, 'isApex'>): boolean {
  return !bot.isApex
}

/** For code outside React (the approval sentence). */
export function currentBotNameNow(): null | string {
  return isMultiBotMode() ? ($currentBot.get()?.name ?? null) : null
}

/** The name of the assistant `profile` belongs to (a notification from a background one); null with one assistant. */
export function botNameForProfile(profile: null | string | undefined): null | string {
  return isMultiBotMode() ? botFor($botRoster.get(), profile || APEX_PROFILE).name : null
}

/** What 「正在唤醒 …」 names while an engine starts: the assistant's name, not its profile directory. */
export function botSwapLabel(profile: null | string): string {
  return profile && isMultiBotMode() ? botFor($botRoster.get(), profile).name : (profile ?? '')
}

// ── switching ────────────────────────────────────────────────────────────────

/**
 * Put `profile`'s assistant on screen: point new chats at it, drop to a fresh
 * draft (the shell then opens that profile's thread) and activate its engine,
 * cold-starting a pool backend when it is not running. Unlike the developer
 * profile rail it never remembers the profile for the next launch: the
 * startup profile is what the local IM gateway and the config heal follow,
 * and that stays APEX's (K7). Rejects when the engine cannot be reached.
 */
export async function openBot(profile: string): Promise<void> {
  const target = normalizeProfileKey(profile)

  if (target === normalizeProfileKey($activeGatewayProfile.get()) && !$gatewaySwapTarget.get() && !$botIntent.get()) {
    return
  }

  // Before anything renders: the sidebar, the header and the shell's
  // redirect follow the assistant asked for, not the engine still answering.
  $botIntent.set(target)
  pinNewChatProfile(target)
  requestFreshSession()

  try {
    await ensureGatewayProfile(target)
  } finally {
    if ($botIntent.get() === target) {
      $botIntent.set(null)
    }
  }
}

/** The sidebar's 「+」: the new-assistant sheet (hc-1078) listens for this. */
export const $botCreateRequest = atom(0)

export function requestBotCreate(): void {
  $botCreateRequest.set($botCreateRequest.get() + 1)
}

/** Tests only. */
export function resetBotRosterForTest(roster: readonly ApexBot[] = [apexBot()]): void {
  rosterSerial += 1
  $botIntent.set(null)
  soulChecks.clear()
  $botRoster.set(roster)
  $botLastSessions.set({})
  writeJson(ROSTER_CACHE_KEY, null)
}

// Read as soon as anything in the window imports the switch.
void loadMultiBotFlag()
