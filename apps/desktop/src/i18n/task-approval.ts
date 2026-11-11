/**
 * Copy for hc-1223 「本任务都允许」: the approval card's button that answers this card and every
 * later approval of the same task (components/assistant-ui/tool/approval.tsx). Kept beside the
 * main catalogs (past the code-health size cap); each locale is a whole typed object, so a missing
 * zh string is a type error. zh, zh-hant and en are complete; ja and ar read en.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface TaskApprovalCopy {
  /** The button. */
  allowTask: string
  /** Its tooltip: what one click covers, and when APEX asks again. */
  allowTaskHint: string
}

const en: TaskApprovalCopy = {
  allowTask: 'Allow for this task',
  allowTaskHint: 'Run this and every later step of this task that needs your OK. APEX asks again once the task is done.'
}

const zh: TaskApprovalCopy = {
  allowTask: '本任务都允许',
  allowTaskHint: '这一步和本任务后面需要你同意的步骤都直接运行，这个任务做完后恢复询问。'
}

const zhHant: TaskApprovalCopy = {
  allowTask: '本任務都允許',
  allowTaskHint: '這一步和本任務後面需要你同意的步驟都直接執行，這個任務做完後恢復詢問。'
}

export const TASK_APPROVAL_COPY: Readonly<Record<Locale, TaskApprovalCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useTaskApprovalCopy(): TaskApprovalCopy {
  return TASK_APPROVAL_COPY[useI18n().locale]
}
