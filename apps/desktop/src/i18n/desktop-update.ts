/**
 * hc-1030: copy for an app update that waits or fails. The deferral line sits in
 * the sidebar update entry while a requested install waits for APEX to be idle;
 * the error sentences replace raw update codes in the install overlay, with the
 * code kept underneath for support.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error; zh, zh-hant and en are
 * complete, ja and ar read en.
 */

import type { DesktopShellUpdateDeferralReason } from '@/global'

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

/** Every code the update stores can leave in the overlay; anything else reads as `generic`. */
export type DesktopUpdateErrorCode =
  | 'apply_failed'
  | 'desktop_update_required_but_not_ready'
  | 'disabled'
  | 'disposed'
  | 'failed_to_persist_update_plan'
  | 'install_failed'
  | 'no_update_ready'
  | 'not_downloaded'
  | 'runtime_check_failed'
  | 'runtime_target_changed'
  | 'runtime_target_not_active'
  | 'shell_target_changed'
  | 'shell_target_not_running'
  | 'shell_update_apply_failed'
  | 'shell_update_not_ready'
  | 'unsupported'
  | 'update_plan_transition_failed'
  | 'updated_shell_still_incompatible'

export interface DesktopUpdateCopy {
  /** Sidebar line while the requested install waits, by what it waits for. */
  deferred: Record<DesktopShellUpdateDeferralReason, string>
  /** `network` covers Chromium `net::ERR_*` failures; `generic` covers codes not listed. */
  errors: Record<DesktopUpdateErrorCode | 'generic' | 'network', string>
  /** The raw code under the sentence, for support. */
  errorCode: (code: string) => string
}

const en: DesktopUpdateCopy = {
  deferred: {
    active_work: 'A task is still running. APEX installs the update when it finishes.',
    activity_unknown: 'Checking that APEX is idle. The update installs right after.',
    engine_holders: 'Another program is using the APEX engine. The update installs once it exits.',
    gateway_busy: 'A messaging channel is still replying. The update installs once it is done.',
    previous_worker: 'An earlier APEX engine process is still exiting. The update installs after it.'
  },
  errors: {
    apply_failed: 'The AI engine update did not finish. Quit APEX completely, open it again, and retry.',
    desktop_update_required_but_not_ready:
      'The new AI engine needs a newer app, which is still downloading. Try again once it is ready.',
    disabled: 'This copy of APEX cannot install updates by itself.',
    disposed: 'APEX is closing. Open it again and retry.',
    failed_to_persist_update_plan: 'APEX could not save the update progress. Try again.',
    install_failed: 'The update could not start installing. Quit APEX completely, open it again, and retry.',
    no_update_ready: 'There is no update ready to install right now.',
    not_downloaded: 'The new version is not downloaded yet. The sidebar offers it once it is.',
    runtime_check_failed: 'Checking for the AI engine update failed. Check your connection and try again.',
    runtime_target_changed: 'The update changed while it was being prepared. Check for updates again.',
    runtime_target_not_active: 'The AI engine did not switch to the new version. Quit APEX completely and open it again.',
    shell_target_changed: 'A newer version arrived while this one waited. Install the newer one from the sidebar.',
    shell_target_not_running:
      'The new version is not installed yet; APEX is still the earlier version. The sidebar offers "Install and restart" again once it has downloaded.',
    shell_update_apply_failed: 'Installing could not start. Quit APEX completely, open it again, and retry.',
    shell_update_not_ready: 'The new version is still downloading. The sidebar offers "Install and restart" once it is ready.',
    unsupported: 'This copy of APEX cannot install updates by itself.',
    update_plan_transition_failed: 'APEX could not save the update progress. Try again.',
    updated_shell_still_incompatible:
      'The app is updated, but the new AI engine needs an even newer app. Wait for the next version.',
    generic: 'The update did not finish. Quit APEX completely, open it again, and retry.',
    network: "Couldn't reach the update server. Check your connection and try again."
  },
  errorCode: code => `Error code: ${code}`
}

const zh: DesktopUpdateCopy = {
  deferred: {
    active_work: '有任务在进行，做完后自动安装更新。',
    activity_unknown: '正在确认 APEX 是否空闲，确认后自动安装更新。',
    engine_holders: '有别的程序在用 APEX 引擎，它退出后自动安装更新。',
    gateway_busy: '消息渠道还在回复消息，回复完自动安装更新。',
    previous_worker: '上次的 APEX 引擎进程还在退出，退出后自动安装更新。'
  },
  errors: {
    apply_failed: 'AI 引擎没有更新完。请完全退出 APEX 后重新打开，再试一次。',
    desktop_update_required_but_not_ready: '新的 AI 引擎需要先更新应用，应用新版本还在下载，好了之后再试。',
    disabled: '这个 APEX 不能自己安装更新。',
    disposed: 'APEX 正在退出，重新打开后再试。',
    failed_to_persist_update_plan: '没能保存更新进度，请再试一次。',
    install_failed: '安装没能开始。请完全退出 APEX 后重新打开，再试一次。',
    no_update_ready: '现在没有可以安装的更新。',
    not_downloaded: '新版本还没下载完，下载好后侧栏会提示安装。',
    runtime_check_failed: '检查 AI 引擎更新失败，请检查网络后再试。',
    runtime_target_changed: '准备期间更新内容有变化，请重新检查更新。',
    runtime_target_not_active: 'AI 引擎没有切换到新版本。请完全退出 APEX 后重新打开。',
    shell_target_changed: '等待期间又有更新的版本，请在侧栏安装更新的那个。',
    shell_target_not_running: '新版本还没装上，APEX 仍是旧版本。新版本下载好后，侧栏会再提示「安装并重启」。',
    shell_update_apply_failed: '安装没能开始。请完全退出 APEX 后重新打开，再试一次。',
    shell_update_not_ready: '新版本还在下载，下载好后侧栏会提示「安装并重启」。',
    unsupported: '这个 APEX 不能自己安装更新。',
    update_plan_transition_failed: '没能保存更新进度，请再试一次。',
    updated_shell_still_incompatible: '应用已经更新，但新的 AI 引擎还需要更新的应用，请等下一个版本。',
    generic: '更新没有完成。请完全退出 APEX 后重新打开，再试一次。',
    network: '连不上更新服务器，请检查网络后再试。'
  },
  errorCode: code => `错误代码：${code}`
}

const zhHant: DesktopUpdateCopy = {
  deferred: {
    active_work: '有任務在進行，做完後自動安裝更新。',
    activity_unknown: '正在確認 APEX 是否空閒，確認後自動安裝更新。',
    engine_holders: '有別的程式在用 APEX 引擎，它退出後自動安裝更新。',
    gateway_busy: '訊息渠道還在回覆訊息，回覆完自動安裝更新。',
    previous_worker: '上次的 APEX 引擎程序還在退出，退出後自動安裝更新。'
  },
  errors: {
    apply_failed: 'AI 引擎沒有更新完。請完全退出 APEX 後重新打開，再試一次。',
    desktop_update_required_but_not_ready: '新的 AI 引擎需要先更新應用，應用新版本還在下載，好了之後再試。',
    disabled: '這個 APEX 不能自己安裝更新。',
    disposed: 'APEX 正在退出，重新打開後再試。',
    failed_to_persist_update_plan: '沒能儲存更新進度，請再試一次。',
    install_failed: '安裝沒能開始。請完全退出 APEX 後重新打開，再試一次。',
    no_update_ready: '現在沒有可以安裝的更新。',
    not_downloaded: '新版本還沒下載完，下載好後側欄會提示安裝。',
    runtime_check_failed: '檢查 AI 引擎更新失敗，請檢查網路後再試。',
    runtime_target_changed: '準備期間更新內容有變化，請重新檢查更新。',
    runtime_target_not_active: 'AI 引擎沒有切換到新版本。請完全退出 APEX 後重新打開。',
    shell_target_changed: '等待期間又有更新的版本，請在側欄安裝更新的那個。',
    shell_target_not_running: '新版本還沒裝上，APEX 仍是舊版本。新版本下載好後，側欄會再提示「安裝並重啟」。',
    shell_update_apply_failed: '安裝沒能開始。請完全退出 APEX 後重新打開，再試一次。',
    shell_update_not_ready: '新版本還在下載，下載好後側欄會提示「安裝並重啟」。',
    unsupported: '這個 APEX 不能自己安裝更新。',
    update_plan_transition_failed: '沒能儲存更新進度，請再試一次。',
    updated_shell_still_incompatible: '應用已經更新，但新的 AI 引擎還需要更新的應用，請等下一個版本。',
    generic: '更新沒有完成。請完全退出 APEX 後重新打開，再試一次。',
    network: '連不上更新伺服器，請檢查網路後再試。'
  },
  errorCode: code => `錯誤代碼：${code}`
}

export const DESKTOP_UPDATE_COPY: Readonly<Record<Locale, DesktopUpdateCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useDesktopUpdateCopy(): DesktopUpdateCopy {
  return DESKTOP_UPDATE_COPY[useI18n().locale] ?? en
}

/** Outside a render (an update check's result handler). */
export function desktopUpdateCopyNow(): DesktopUpdateCopy {
  return DESKTOP_UPDATE_COPY[getRuntimeI18nLocale()] ?? en
}

/** The sentence for an update code (null without one); an engine message or an unknown code reads as `generic`. */
export function describeDesktopUpdateError(copy: DesktopUpdateCopy, code: null | string | undefined): null | string {
  if (!code) {
    return null
  }

  if (/net::ERR_/.test(code)) {
    return copy.errors.network
  }

  return Object.hasOwn(copy.errors, code) ? copy.errors[code as DesktopUpdateErrorCode] : copy.errors.generic
}
