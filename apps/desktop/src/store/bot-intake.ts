/**
 * hc-1079 (多助手第一期 M3): a new assistant's first-open questions, kept in two
 * places of its own profile through the engine's `profiles.*` methods:
 *
 * - SOUL.md 「分工」: what the model reads (bot-intake-soul.ts);
 * - profile.yaml `ui_meta['apex-intake']`: which cards are answered and whether
 *   the intake is done or was undone, so the cards neither come back nor
 *   restart after the app does. Its own key: `ui_meta.apex` (name and look) is
 *   written whole by the new-assistant sheet, and `hermes-bots` would make the
 *   engine treat the profile as Bot Mode's.
 *
 * Every answer is saved as it is tapped, SOUL first and the record second, so
 * the record never claims an answer the SOUL lacks, and a message sent before
 * the last card still gets the answers given so far.
 */

import { atom } from 'nanostores'

import {
  BOT_INTAKE_ROLES,
  BOT_INTAKE_STEPS,
  BOT_INTAKE_STYLES,
  type BotIntakeStep
} from '@/app/single-thread/bot-intake-copy'
import {
  type BotIntakeAnswers,
  cleanRoleOther,
  divisionSection,
  withDivision,
  withoutDivision
} from '@/app/single-thread/bot-intake-soul'
import type { DesktopCreatorPlatform } from '@/global'
import type { Locale } from '@/i18n/types'

export const BOT_INTAKE_META_KEY = 'apex-intake'

export type BotIntakeStatus = 'asking' | 'noted' | 'undone'

export interface BotIntakeRecord {
  answers: BotIntakeAnswers
  status: BotIntakeStatus
  v: 1
}

export interface BotIntakeState {
  /** The profile the record was read for; a switch makes it stale. */
  profile: null | string
  /** Null when the profile has none yet: a brand-new assistant. */
  record: BotIntakeRecord | null
  status: 'error' | 'idle' | 'loading' | 'ready'
}

export const $botIntake = atom<BotIntakeState>({ profile: null, record: null, status: 'idle' })

export type BotIntakeRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

interface ProfilesListReply {
  profiles?: { name?: string; ui_meta?: Record<string, unknown> }[]
}

interface ConfigureReply {
  applied?: Record<string, unknown>
}

const PLATFORMS: readonly DesktopCreatorPlatform[] = ['bilibili', 'channels', 'douyin', 'kuaishou', 'xiaohongshu']
const STATUSES: readonly BotIntakeStatus[] = ['asking', 'noted', 'undone']

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

/** The record as profile.yaml holds it; anything unknown is dropped, a malformed record reads as none. */
export function parseBotIntakeRecord(raw: unknown): BotIntakeRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const { answers: rawAnswers, status } = raw as Record<string, unknown>

  if (!includes(STATUSES, status)) {
    return null
  }

  const given = rawAnswers && typeof rawAnswers === 'object' ? (rawAnswers as Record<string, unknown>) : {}
  const answers: BotIntakeAnswers = {}
  const other = typeof given.roleOther === 'string' ? cleanRoleOther(given.roleOther) : ''

  if (includes(BOT_INTAKE_ROLES, given.role)) {
    answers.role = given.role
  } else if (given.role === 'other' && other) {
    answers.role = 'other'
    answers.roleOther = other
  }

  if (includes(BOT_INTAKE_STYLES, given.style)) {
    answers.style = given.style
  }

  if (given.platform === 'same') {
    answers.platform = 'same'
  } else if (Array.isArray(given.platform)) {
    const platforms = [...new Set(given.platform.filter(id => includes(PLATFORMS, id)))]

    if (platforms.length) {
      answers.platform = platforms
    }
  }

  return { answers, status, v: 1 }
}

export function botIntakeAnswered(step: BotIntakeStep, answers: BotIntakeAnswers): boolean {
  return step === 'role'
    ? Boolean(answers.role === 'other' ? answers.roleOther : answers.role)
    : step === 'style'
      ? Boolean(answers.style)
      : answers.platform === 'same' || Boolean(answers.platform?.length)
}

let lookupSerial = 0

/** Read `profile`'s record; only the newest read lands, so a switch mid-read cannot publish the old one. */
export async function loadBotIntake(request: BotIntakeRequest, profile: string): Promise<void> {
  const serial = ++lookupSerial
  $botIntake.set({ profile, record: null, status: 'loading' })

  try {
    const reply = await request<ProfilesListReply>('profiles.list', { include_sessions: false })
    const row = reply?.profiles?.find(candidate => candidate?.name === profile)

    if (serial !== lookupSerial) {
      return
    }

    // Fails closed: a profile the roster does not list is not asked anything.
    $botIntake.set(
      row
        ? { profile, record: parseBotIntakeRecord(row.ui_meta?.[BOT_INTAKE_META_KEY]), status: 'ready' }
        : { profile, record: null, status: 'error' }
    )
  } catch {
    if (serial === lookupSerial) {
      $botIntake.set({ profile, record: null, status: 'error' })
    }
  }
}

async function writeSoul(request: BotIntakeRequest, profile: string, edit: (soul: string) => string): Promise<boolean> {
  const described = await request<{ soul?: unknown }>('profiles.describe', { name: profile })
  const soul = typeof described?.soul === 'string' ? described.soul : ''

  // A profile without its identity text must not end up with only a 「分工」 section as its SOUL.
  if (!soul.trim()) {
    return false
  }

  const next = edit(soul)

  if (next === soul) {
    return true
  }

  const reply = await request<ConfigureReply>('profiles.configure', { name: profile, soul: next })

  return reply?.applied?.soul === true
}

async function writeRecord(request: BotIntakeRequest, profile: string, record: BotIntakeRecord): Promise<boolean> {
  const reply = await request<ConfigureReply>('profiles.configure', {
    name: profile,
    ui_meta: { [BOT_INTAKE_META_KEY]: record }
  })

  if (reply?.applied?.ui_meta !== true) {
    return false
  }

  if ($botIntake.get().profile === profile) {
    $botIntake.set({ profile, record, status: 'ready' })
  }

  return true
}

/** Save the answers so far: the SOUL's 「分工」, then the record (`noted` once all three are in). */
export async function saveBotIntakeAnswers(
  request: BotIntakeRequest,
  profile: string,
  answers: BotIntakeAnswers,
  locale: Locale
): Promise<boolean> {
  const status = BOT_INTAKE_STEPS.every(step => botIntakeAnswered(step, answers)) ? 'noted' : 'asking'

  try {
    return (
      (await writeSoul(request, profile, soul => withDivision(soul, divisionSection(answers, locale)))) &&
      (await writeRecord(request, profile, { answers, status, v: 1 }))
    )
  } catch {
    return false
  }
}

/** 撤销: the SOUL goes back to how it was before the intake, and the record says not to ask again. */
export async function undoBotIntake(request: BotIntakeRequest, profile: string): Promise<boolean> {
  try {
    return (
      (await writeSoul(request, profile, withoutDivision)) &&
      (await writeRecord(request, profile, { answers: {}, status: 'undone', v: 1 }))
    )
  } catch {
    return false
  }
}

export function resetBotIntakeForTest(): void {
  lookupSerial += 1
  $botIntake.set({ profile: null, record: null, status: 'idle' })
}
