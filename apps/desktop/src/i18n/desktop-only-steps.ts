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
 * hc-1122: ChatCut's MCP tools, while `desktop_features.chatcut` is on. Their
 * raw names (`mcp__chatcut__read_script`) must never reach the screen; a tool
 * without its own row reads as editing in general. Its two file tools (a local
 * file going in, a finished export saved) are the engine's own, named as is.
 */

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'
import type { StepCopy } from './types-process'

/** `apex_memory` with `action: "forget"`: named for what it did, so a removal never reads 「记住一条」. */
export const MEMORY_FORGET_STEP = 'apex_memory:forget'
/** `apex_memory` with `action: "list"`: a look at the ledger, not a new memory. */
export const MEMORY_LIST_STEP = 'apex_memory:list'

const CHATCUT_TOOL_PREFIX = 'mcp__chatcut__'
const CHATCUT_GENERAL_STEP = 'chatcut:edit'
const CHATCUT_CAPTIONS_STEP = 'chatcut:captions'
const CHATCUT_CUT_STEP = 'chatcut:cut'
const CHATCUT_EXPORT_STEP = 'chatcut:export'
const CHATCUT_READ_STEP = 'chatcut:read'

const CHATCUT_STEPS: Readonly<Record<string, string>> = {
  apply_script: CHATCUT_CUT_STEP,
  browse_assets: CHATCUT_READ_STEP,
  clean_script: CHATCUT_CUT_STEP,
  edit_captions: CHATCUT_CAPTIONS_STEP,
  preview_timeline: CHATCUT_READ_STEP,
  read_captions: CHATCUT_CAPTIONS_STEP,
  read_project: CHATCUT_READ_STEP,
  read_script: CHATCUT_READ_STEP,
  split_item: CHATCUT_CUT_STEP,
  submit_export: CHATCUT_EXPORT_STEP,
  track_export: CHATCUT_EXPORT_STEP
}

/** The step key for one of ChatCut's MCP tools; any other tool keeps its own name. */
export function chatcutStepKey(toolName: string): string {
  return toolName.startsWith(CHATCUT_TOOL_PREFIX)
    ? (CHATCUT_STEPS[toolName.slice(CHATCUT_TOOL_PREFIX.length)] ?? CHATCUT_GENERAL_STEP)
    : toolName
}

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
  apex_rename: { running: 'Changing my name', title: 'Change my name', done: said('Renamed') },
  [CHATCUT_GENERAL_STEP]: { running: 'Editing in ChatCut', title: 'Edit in ChatCut', done: said('Done') },
  [CHATCUT_CAPTIONS_STEP]: { running: 'Working on the captions', title: 'Captions', done: said('Done') },
  [CHATCUT_CUT_STEP]: { running: 'Cutting the video', title: 'Cut the video', done: said('Cut') },
  [CHATCUT_EXPORT_STEP]: { running: 'Exporting the video', title: 'Export the video', done: said('Done') },
  [CHATCUT_READ_STEP]: {
    running: 'Looking through the project',
    title: 'Look through the project',
    done: said('Done')
  },
  chatcut_upload_files: { running: 'Sending the files to ChatCut', title: 'Send files to ChatCut', done: said('Sent') },
  chatcut_save_export: { running: 'Saving the video', title: 'Save the video', done: said('Saved') },
  jianying_draft: { running: 'Writing the JianyingPro draft', title: 'Write a JianyingPro draft', done: said('Written') }
}

const zh: Record<string, StepCopy> = {
  apex_memory: { running: '正在记下来', title: '记住一条', done: said('记好了') },
  [MEMORY_FORGET_STEP]: { running: '正在忘掉', title: '忘掉一条', done: said('忘掉了') },
  [MEMORY_LIST_STEP]: { running: '正在翻记得的事', title: '查一下记得什么', done: said('查好了') },
  apex_rename: { running: '正在改名字', title: '改名字', done: said('改好了') },
  [CHATCUT_GENERAL_STEP]: { running: '正在用 ChatCut 剪辑', title: '用 ChatCut 剪辑', done: said('好了') },
  [CHATCUT_CAPTIONS_STEP]: { running: '正在处理字幕', title: '处理字幕', done: said('好了') },
  [CHATCUT_CUT_STEP]: { running: '正在剪视频', title: '剪视频', done: said('剪好了') },
  [CHATCUT_EXPORT_STEP]: { running: '正在导出视频', title: '导出视频', done: said('好了') },
  [CHATCUT_READ_STEP]: { running: '正在看工程内容', title: '看工程内容', done: said('看好了') },
  chatcut_upload_files: { running: '正在把文件传到 ChatCut', title: '把文件传到 ChatCut', done: said('传好了') },
  chatcut_save_export: { running: '正在保存成片', title: '保存成片', done: said('存好了') },
  jianying_draft: { running: '正在写剪映草稿', title: '写剪映草稿', done: said('写好了') }
}

const zhHant: Record<string, StepCopy> = {
  apex_memory: { running: '正在記下來', title: '記住一條', done: said('記好了') },
  [MEMORY_FORGET_STEP]: { running: '正在忘掉', title: '忘掉一條', done: said('忘掉了') },
  [MEMORY_LIST_STEP]: { running: '正在翻記得的事', title: '查一下記得什麼', done: said('查好了') },
  apex_rename: { running: '正在改名字', title: '改名字', done: said('改好了') },
  [CHATCUT_GENERAL_STEP]: { running: '正在用 ChatCut 剪輯', title: '用 ChatCut 剪輯', done: said('好了') },
  [CHATCUT_CAPTIONS_STEP]: { running: '正在處理字幕', title: '處理字幕', done: said('好了') },
  [CHATCUT_CUT_STEP]: { running: '正在剪影片', title: '剪影片', done: said('剪好了') },
  [CHATCUT_EXPORT_STEP]: { running: '正在匯出影片', title: '匯出影片', done: said('好了') },
  [CHATCUT_READ_STEP]: { running: '正在看工程內容', title: '看工程內容', done: said('看好了') },
  chatcut_upload_files: { running: '正在把檔案傳到 ChatCut', title: '把檔案傳到 ChatCut', done: said('傳好了') },
  chatcut_save_export: { running: '正在儲存成片', title: '儲存成片', done: said('存好了') },
  jianying_draft: { running: '正在寫剪映草稿', title: '寫剪映草稿', done: said('寫好了') }
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
