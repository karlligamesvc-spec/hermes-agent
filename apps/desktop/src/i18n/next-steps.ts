/**
 * Copy for the 「下一步」 buttons under a result (apex-next/1, components/assistant-ui/next-steps).
 *
 * Kept beside the main catalogs instead of inside them, like account-team.ts: the four
 * catalog files are past the code-health size cap (they may only shrink). The button text
 * itself is the skill's own words from the block, never translated here; a failed result
 * reuses hc-973's three buttons (`assistant.tool.process.failure`). zh, zh-hant and en are
 * complete; ja and ar fall back to en like any missing key.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface NextStepsCopy {
  /** Accessible name of the button row. */
  group: string
  /** Hover text: the sentence a click sends as the user's message. */
  sends: (message: string) => string
}

const en: NextStepsCopy = {
  group: 'Next steps',
  sends: message => `Sends: ${message}`
}

const zh: NextStepsCopy = {
  group: '下一步',
  sends: message => `点一下就发：${message}`
}

const zhHant: NextStepsCopy = {
  group: '下一步',
  sends: message => `點一下就發：${message}`
}

export const NEXT_STEPS_COPY: Readonly<Record<Locale, NextStepsCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** Next-step copy in the window's language. */
export function useNextStepsCopy(): NextStepsCopy {
  return NEXT_STEPS_COPY[useI18n().locale] ?? en
}
