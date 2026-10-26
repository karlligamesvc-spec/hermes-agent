/**
 * hc-1033: copy for an AI engine that did not update with the app. The About page shows it when this
 * boot kept an engine other than the one APEX ships, each sentence naming the fix.
 *
 * Kept beside the main catalogs instead of inside them: those files are past the code-health size cap
 * (they may only shrink). Each locale is a whole typed object, so a missing zh string is a type error;
 * zh, zh-hant and en are complete, ja and ar read en.
 */

import type { DesktopEngineKeptBack } from '@/global'

import { useI18n } from './context'
import type { Locale } from './types'

export interface EngineKeptBackCopy {
  title: string
  /** By why the engine was kept; the argument is the shipped engine's display version. */
  detail: Record<DesktopEngineKeptBack['reason'], (bundled: string) => string>
  switchAction: string
  switching: string
  /** The engine is busy, so the switch did not start. */
  deferred: string
}

const en: EngineKeptBackCopy = {
  title: 'The AI engine was not updated',
  detail: {
    'newer-or-unknown': bundled =>
      `APEX ships with ${bundled}, but it can't confirm the engine on this computer is older, so it kept that one in case you installed it yourself. If you didn't change the engine yourself, click "Use the built-in engine" to switch to ${bundled}. Your chats and settings stay.`,
    'upgrade-failed': bundled =>
      `The engine that ships with APEX (${bundled}) didn't install, so APEX is still on the previous one. Quit APEX completely and open it again; if that doesn't help, click "Use the built-in engine" to retry. Your chats and settings stay.`
  },
  switchAction: 'Use the built-in engine',
  switching: 'Preparing…',
  deferred: 'A task is still using the engine. Click again once it finishes.'
}

const zh: EngineKeptBackCopy = {
  title: 'AI 引擎没有跟着更新',
  detail: {
    'newer-or-unknown': bundled =>
      `APEX 自带的是${bundled}，但没法确认这台电脑上现在的引擎比它旧，为了不换掉你自己装的引擎，先保留了原来的。如果你没有自己换过引擎，点「换成自带引擎」就能用上${bundled}，对话和设置都会保留。`,
    'upgrade-failed': bundled =>
      `APEX 自带的${bundled}没有装上，现在还在用原来的引擎。请完全退出 APEX 后重新打开；还不行就点「换成自带引擎」再试一次，对话和设置都会保留。`
  },
  switchAction: '换成自带引擎',
  switching: '正在准备…',
  deferred: 'APEX 还有任务在用引擎，做完后再点一次。'
}

const zhHant: EngineKeptBackCopy = {
  title: 'AI 引擎沒有跟著更新',
  detail: {
    'newer-or-unknown': bundled =>
      `APEX 自帶的是${bundled}，但沒法確認這台電腦上現在的引擎比它舊，為了不換掉你自己裝的引擎，先保留了原來的。如果你沒有自己換過引擎，點「換成自帶引擎」就能用上${bundled}，對話和設定都會保留。`,
    'upgrade-failed': bundled =>
      `APEX 自帶的${bundled}沒有裝上，現在還在用原來的引擎。請完全退出 APEX 後重新打開；還不行就點「換成自帶引擎」再試一次，對話和設定都會保留。`
  },
  switchAction: '換成自帶引擎',
  switching: '正在準備…',
  deferred: 'APEX 還有任務在用引擎，做完後再點一次。'
}

export const ENGINE_KEPT_BACK_COPY: Readonly<Record<Locale, EngineKeptBackCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useEngineKeptBackCopy(): EngineKeptBackCopy {
  return ENGINE_KEPT_BACK_COPY[useI18n().locale] ?? en
}
