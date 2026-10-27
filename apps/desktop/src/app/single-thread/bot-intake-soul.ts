/**
 * hc-1079: a new assistant's answers as the 「分工」 section of its own SOUL.md
 * (K1/K4: the answers are this assistant's, never the shared memory ledger).
 * The engine reads SOUL.md from disk each time a new session builds its system
 * prompt (agent/prompt_builder.py load_soul_md), and an assistant's thread has
 * no session before its first message, so writing the file before that message
 * is all the first reply needs: no engine restart.
 *
 * The section is always the file's last one and nothing else is touched, so
 * taking it out again gives back the file as it was (byte for byte when that
 * file ended in exactly one newline, as every SOUL Desktop writes does).
 */

import { CREATOR_INTAKE_COPY } from '@/app/business-workspace/creator-intake-copy'
import type { DesktopCreatorPlatform } from '@/global'
import type { Locale } from '@/i18n/types'

import { BOT_INTAKE_COPY, type BotIntakeRole, type BotIntakeStyle } from './bot-intake-copy'

export interface BotIntakeAnswers {
  role?: BotIntakeRole
  /** What was typed in 「别的，我直接说」 when `role` is `other`. */
  roleOther?: string
  style?: BotIntakeStyle
  /** `same` follows the account's own answer (the shared 用户画像), so a later change there carries over. */
  platform?: 'same' | DesktopCreatorPlatform[]
}

/** The same bound the account's 「其他（自己写）」 has: a short phrase that lands in every prompt. */
export const BOT_ROLE_OTHER_MAX_CHARS = 40

/**
 * Typed text as one short phrase: no line breaks (a `## ` line would start a
 * section of its own) and none of the characters the cloud strips so typed
 * text cannot fake a prompt frame.
 */
export function cleanRoleOther(text: string): string {
  return text
    .replace(/[【】<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BOT_ROLE_OTHER_MAX_CHARS)
    .trim()
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every locale's heading, so a section written in one language is still found after a language switch.
const HEADINGS = [...new Set(Object.values(BOT_INTAKE_COPY).map(copy => copy.soul.heading))]

// The blank lines before the heading, the heading line, and everything up to the next H2 or the end.
const SECTION = new RegExp(`(?:^|\\n+)(?:${HEADINGS.map(escapeRegExp).join('|')})[ \\t]*(?:\\n[\\s\\S]*?)?(?=\\n## |$)`)

const unified = (soul: string) => soul.replace(/\r\n?/g, '\n')

export function hasDivision(soul: string): boolean {
  return SECTION.test(unified(soul))
}

/** The SOUL without its 「分工」 section; unchanged when it has none. */
export function withoutDivision(soul: string): string {
  const text = unified(soul)
  const match = SECTION.exec(text)

  if (!match) {
    return text
  }

  const before = text.slice(0, match.index)
  const after = text.slice(match.index + match[0].length)

  if (after) {
    return `${before}\n${after}`
  }

  return before ? `${before}\n` : ''
}

/** The section the answers so far make, in `locale`; empty when nothing is answered. */
export function divisionSection(answers: BotIntakeAnswers, locale: Locale): string {
  const { roleWork, soul } = BOT_INTAKE_COPY[locale]
  const { listSeparator, platforms } = CREATOR_INTAKE_COPY[locale]
  const lines: string[] = []

  const role =
    answers.role === 'other' ? cleanRoleOther(answers.roleOther ?? '') : answers.role && roleWork[answers.role]

  if (role) {
    lines.push(soul.role(role))
  }

  if (answers.style) {
    lines.push(soul.style(answers.style))
  }

  if (answers.platform === 'same') {
    lines.push(soul.sameAsApex)
  } else if (answers.platform?.length) {
    lines.push(soul.platforms(answers.platform.map(id => platforms[id]).join(listSeparator)))
  }

  return lines.length ? [soul.heading, '', soul.intro, ...lines, ''].join('\n') : ''
}

/** The SOUL with `section` as its 「分工」: replaces the one it has, or adds it at the end. */
export function withDivision(soul: string, section: string): string {
  const base = withoutDivision(soul)

  if (!section) {
    return base
  }

  const kept = base.replace(/\s+$/, '')

  return kept ? `${kept}\n\n${section}` : section
}
