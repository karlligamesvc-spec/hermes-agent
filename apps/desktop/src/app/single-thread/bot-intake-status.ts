/**
 * hc-1079 (prototype ⑧): what a new assistant's sidebar row says under its name
 * before its first conversation — its three questions are still to come
 * (「先问 3 个小问题」), the role it was given (「分工定了：剪辑出片」), or that
 * they were undone (「分工没记，随时再说」). Read from the row's
 * `ui_meta['apex-intake']`; store/bot-intake.ts writes it.
 */

import { parseBotIntakeRecord } from '@/store/bot-intake'

import type { BotIntakeCopy } from './bot-intake-copy'
import type { BotIntakeAnswers } from './bot-intake-soul'

/** The role as a sentence uses it: 「剪辑出片」, or what was typed. */
export function botRoleWork(answers: BotIntakeAnswers, copy: BotIntakeCopy): string {
  return answers.role === 'other' ? (answers.roleOther ?? '') : answers.role ? copy.roleWork[answers.role] : ''
}

export function botIntakeStatusLine(raw: unknown, copy: BotIntakeCopy): string {
  const record = parseBotIntakeRecord(raw)
  const work = record?.status === 'noted' ? botRoleWork(record.answers, copy) : ''

  if (work) {
    return copy.sidebar.noted(work)
  }

  return record?.status === 'undone' ? copy.sidebar.undone : copy.sidebar.asking
}
