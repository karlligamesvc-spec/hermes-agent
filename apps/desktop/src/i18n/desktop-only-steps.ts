/**
 * Steps for engine tools that only APEX Desktop runs, never a cloud container.
 *
 * They stay out of {en,zh,zh-hant}-process.ts on purpose: apex-nodes mirrors
 * those tables for the cloud's progress lines (hc-997) and its sync test wants
 * the same tool set on both sides, so a Desktop-only tool there would turn the
 * mirror red for a tool the cloud can never call. This is the twin of the
 * cloud's `progress_steps.CLOUD_ONLY_STEPS`; a tool both sides run belongs in
 * the main tables.
 *
 * hc-1063: the memory ledger's tool (hc-1016 `apex_memory`, registered only
 * while `desktop_features.single_thread` is on) read 「处理 · 好了」 in 「看过程」.
 * hc-1097: its `list` action reads the ledger; that step is named for looking.
 * hc-1082: `apex_rename`, an assistant renaming itself (only while several
 * assistants are on).
 */

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'
import type { StepCopy } from './types-process'

/** `apex_memory` with `action: "forget"`: named for what it did, so a removal never reads 「记住一条」. */
export const MEMORY_FORGET_STEP = 'apex_memory:forget'
/** `apex_memory` with `action: "list"`: a look at the ledger, not a new memory. */
export const MEMORY_LIST_STEP = 'apex_memory:list'

/** The step key for apex_memory calls: named for forgetting or looking when every call did that. */
export function memoryStepKey(actions: readonly unknown[]): string {
  const [first] = actions
  const same = actions.every(action => action === first)

  return same && first === 'forget' ? MEMORY_FORGET_STEP : same && first === 'list' ? MEMORY_LIST_STEP : 'apex_memory'
}

const said = (text: string) => () => text

const en: Record<string, StepCopy> = {
  apex_memory: { running: 'Noting it down', title: 'Remember one thing', done: said('Noted') },
  [MEMORY_FORGET_STEP]: { running: 'Forgetting it', title: 'Forget one thing', done: said('Forgotten') },
  [MEMORY_LIST_STEP]: { running: 'Checking what I remember', title: 'Check what I remember', done: said('Checked') },
  apex_rename: { running: 'Changing my name', title: 'Change my name', done: said('Renamed') }
}

const zh: Record<string, StepCopy> = {
  apex_memory: { running: '正在记下来', title: '记住一条', done: said('记好了') },
  [MEMORY_FORGET_STEP]: { running: '正在忘掉', title: '忘掉一条', done: said('忘掉了') },
  [MEMORY_LIST_STEP]: { running: '正在翻记得的事', title: '查一下记得什么', done: said('查好了') },
  apex_rename: { running: '正在改名字', title: '改名字', done: said('改好了') }
}

const zhHant: Record<string, StepCopy> = {
  apex_memory: { running: '正在記下來', title: '記住一條', done: said('記好了') },
  [MEMORY_FORGET_STEP]: { running: '正在忘掉', title: '忘掉一條', done: said('忘掉了') },
  [MEMORY_LIST_STEP]: { running: '正在翻記得的事', title: '查一下記得什麼', done: said('查好了') },
  apex_rename: { running: '正在改名字', title: '改名字', done: said('改好了') }
}

export const DESKTOP_ONLY_STEPS: Readonly<Record<Locale, Readonly<Record<string, StepCopy>>>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function desktopOnlyStepCopy(key: string): StepCopy | undefined {
  return DESKTOP_ONLY_STEPS[getRuntimeI18nLocale()][key]
}
