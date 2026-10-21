/**
 * Copy for the team line in the account menu (hc-971).
 *
 * Kept beside the main catalogs instead of inside them, like model-tier.ts: the
 * four catalog files are past the code-health size cap (they may only shrink).
 * zh, zh-hant and en are complete; ja and ar fall back to en like any missing
 * key. The team name itself is the customer's own text and is never translated.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface AccountTeamCopy {
  /** Shown after the name when this account is the team's admin. */
  admin: string
  /** "Team: <name>" — the line in the account menu. */
  line: (team: string) => string
  /** Shown after the name while the back office has not opened the team yet. */
  pending: string
}

const en: AccountTeamCopy = {
  admin: 'Admin',
  line: team => `Team: ${team}`,
  pending: 'Not open yet'
}

const zh: AccountTeamCopy = {
  admin: '管理员',
  line: team => `团队：${team}`,
  pending: '待开通'
}

const zhHant: AccountTeamCopy = {
  admin: '管理員',
  line: team => `團隊：${team}`,
  pending: '待開通'
}

export const ACCOUNT_TEAM_COPY: Readonly<Record<Locale, AccountTeamCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** Team-line copy in the window's language. */
export function useAccountTeamCopy(): AccountTeamCopy {
  return ACCOUNT_TEAM_COPY[useI18n().locale] ?? en
}
