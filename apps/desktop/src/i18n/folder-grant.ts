/**
 * Why a folder could not be handed over to the assistant at send (hc-1207). The engine's
 * `folder.attach` answers a stable `reason`; this words it for the error the turn shows.
 *
 * Kept beside the main catalogs (past the code-health size cap) like composer-simple.ts: each
 * locale is a whole typed object, so a missing zh string is a type error. zh, zh-hant and en are
 * complete; ja and ar read en.
 */

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

/** The engine's refusal codes (apex_overlay/folder_grants.py FolderGrantRefused). */
export type FolderGrantRefusal =
  | 'no_key'
  | 'not_folder'
  | 'not_found'
  | 'not_handed_over'
  | 'sensitive'
  | 'too_broad'
  | 'unsupported_path'

type FolderGrantCopy = Record<FolderGrantRefusal, (name: string) => string>

const en: FolderGrantCopy = {
  no_key: name => `“${name}” could not be handed to the assistant: restart APEX and try again.`,
  not_folder: name => `“${name}” is no longer a folder. Pick it again.`,
  not_found: name => `“${name}” was moved or deleted. Pick it again.`,
  not_handed_over: name => `“${name}” could not be handed to the assistant. Pick it again from + or drag it in.`,
  sensitive: name => `“${name}” holds keys or APEX’s own data, so it is not handed to the assistant.`,
  too_broad: name => `“${name}” is too broad (a whole disk, your home folder or APEX’s data). Pick a folder inside it.`,
  unsupported_path: name => `“${name}” cannot be handed to the assistant from this location.`
}

const zh: FolderGrantCopy = {
  no_key: name => `「${name}」没能交给助手：请重启 APEX 后再试。`,
  not_folder: name => `「${name}」已经不是文件夹了，请重新选择。`,
  not_found: name => `「${name}」已被移动或删除，请重新选择。`,
  not_handed_over: name => `「${name}」没能交给助手，请从「+」重新选择或直接拖进来。`,
  sensitive: name => `「${name}」里有密钥或 APEX 自己的数据，不能交给助手。`,
  too_broad: name => `「${name}」范围太大（整个磁盘、主文件夹或 APEX 的数据文件夹），请选它里面的文件夹。`,
  unsupported_path: name => `「${name}」所在的位置不能交给助手。`
}

const zhHant: FolderGrantCopy = {
  no_key: name => `「${name}」沒能交給助手：請重新啟動 APEX 後再試。`,
  not_folder: name => `「${name}」已經不是資料夾了，請重新選擇。`,
  not_found: name => `「${name}」已被移動或刪除，請重新選擇。`,
  not_handed_over: name => `「${name}」沒能交給助手，請從「+」重新選擇或直接拖進來。`,
  sensitive: name => `「${name}」裡有金鑰或 APEX 自己的資料，不能交給助手。`,
  too_broad: name => `「${name}」範圍太大（整個磁碟、主資料夾或 APEX 的資料資料夾），請選它裡面的資料夾。`,
  unsupported_path: name => `「${name}」所在的位置不能交給助手。`
}

export const FOLDER_GRANT_COPY: Readonly<Record<Locale, FolderGrantCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** The refusal in the window's language; null for a reason this build does not know. */
export function folderGrantRefusalNow(reason: unknown, name: string): null | string {
  const copy = FOLDER_GRANT_COPY[getRuntimeI18nLocale()] ?? en

  return typeof reason === 'string' && Object.hasOwn(copy, reason) ? copy[reason as FolderGrantRefusal](name) : null
}
