/**
 * hc-1088: the engine's relay section lists the user's other assistants and what each one handles, so an
 * assistant can offer a job to the right one. It reads two things Desktop owns, through twins of Desktop's
 * own code (apex_overlay/handoff.py): the 「分工」 lines hc-1079 writes into each SOUL.md, and the sidebar's
 * roster (hc-1077 `botRosterFrom`). Both are pinned in shared/apex-handoff-cases.json, which the engine's
 * tests read too; these tests hold Desktop's side to the same file, so a copy edit or a roster rule change
 * here fails until the engine follows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Locale } from '@/i18n/types'
import { type BotProfileRow, botRosterFrom } from '@/store/single-thread-bots'

import { BOT_INTAKE_COPY } from './bot-intake-copy'

interface DivisionCopy {
  heading: string
  platform_prefix: string
  role_prefix: string
  same_as_apex: string
}

interface HandoffCases {
  division: {
    copy: Record<string, DivisionCopy>
    headings: string[]
    platform_prefixes: string[]
    role_prefixes: string[]
    same_as_apex: string[]
  }
  roster: {
    expected: { name: string; profile: string }[]
    profiles: { profile: string; soul: null | string; ui_meta: Record<string, unknown> }[]
  }
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'shared', 'apex-handoff-cases.json'), 'utf8')
) as HandoffCases

describe('hc-1088: the 「分工」 lines the engine reads are the ones hc-1079 writes', () => {
  it.each(Object.entries(CASES.division.copy))('%s', (locale, copy) => {
    const { soul } = BOT_INTAKE_COPY[locale as Locale]

    expect(soul.heading).toBe(copy.heading)
    expect(soul.role('剪辑出片')).toBe(`${copy.role_prefix}剪辑出片`)
    expect(soul.platforms('抖音、小红书')).toBe(`${copy.platform_prefix}抖音、小红书`)
    expect(soul.sameAsApex).toBe(copy.same_as_apex)
  })

  it('covers every locale Desktop writes a 「分工」 in', () => {
    for (const { soul } of Object.values(BOT_INTAKE_COPY)) {
      expect(CASES.division.headings).toContain(soul.heading)
      expect(CASES.division.role_prefixes).toContain(soul.role(''))
      expect(CASES.division.platform_prefixes).toContain(soul.platforms(''))
      expect(CASES.division.same_as_apex).toContain(soul.sameAsApex)
    }
  })
})

describe('hc-1088: the engine lists the assistants the sidebar shows', () => {
  it('in the same order, by the same names', () => {
    const rows: BotProfileRow[] = CASES.roster.profiles.map(({ profile, ui_meta }) => ({
      is_default: profile === 'default',
      name: profile,
      ui_meta
    }))

    const souls = new Map(CASES.roster.profiles.map(({ profile, soul }) => [profile, soul]))
    const roster = botRosterFrom(rows, profile => (souls.get(profile) ?? '').trim().length > 0)

    expect(roster.map(bot => [bot.profile, bot.name])).toEqual(
      CASES.roster.expected.map(({ name, profile }) => [profile, name])
    )
  })
})
