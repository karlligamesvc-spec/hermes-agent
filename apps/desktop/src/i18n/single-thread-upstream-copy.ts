/**
 * Copy for hc-1116 上游话术不进产品, in single-thread product mode: what APEX
 * says where the engine's own English used to show.
 *
 *  - the row the engine writes under a turn that failed (agent/turn_failure_copy.py
 *    FAILED_TURN_NOTICE / PARTIAL_FAILED_TURN_NOTICE), seen when the
 *    conversation is opened again;
 *  - the body of the error card under a failed reply, which otherwise prints
 *    the engine's failure text (/model, /retry, `hermes setup`, Hermes).
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap. Each locale is a whole typed object, so a missing
 * zh string is a type error; zh, zh-hant and en are complete, ja and ar read en.
 */

import type { ErrorSurfaceLayer } from '@/lib/error-surface'

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface SingleThreadUpstreamCopy {
  /** A turn that stopped before any step ran: nothing was done. */
  failedTurn: string
  /** A turn that stopped after a step may have run. */
  failedTurnPartial: string
  /** The error card's body, by the layer that failed; `generic` when the engine names none. */
  errorBody: Record<'generic' | ErrorSurfaceLayer, string>
  /** Before the service's own words, when the failure carries them. */
  serviceSaid: string
}

const zh: SingleThreadUpstreamCopy = {
  failedTurn: '这条没有处理。还需要的话，再发一次。',
  failedTurnPartial: '这一轮没做完，有些步骤可能已经执行了。再发之前，先看看已经做了什么。',
  errorBody: {
    generic: '这一轮没做完，你的消息还没有得到回答。',
    provider: '模型服务这次没有正常回应，你的消息还没有得到回答。',
    endpoint: '连不上设定的模型地址，你的消息还没有得到回答。',
    streaming: '回复传到一半断开了，你的消息还没有得到完整的回答。',
    auth: '模型服务没有接受这次登录。请重新登录 APEX 后再试（用自己密钥的，检查一下密钥）。',
    billing: '额度不够了，你的消息还没有得到回答。',
    gateway: '连接模型服务时出了问题，你的消息还没有得到回答。',
    runtime: 'APEX 在这台电脑上的引擎出了问题，你的消息还没有得到回答。一直这样的话，退出 APEX 再重新打开。',
    disk: '磁盘空间不够，这一轮没法继续。腾出一些空间后再试。'
  },
  serviceSaid: '服务方说：'
}

const zhHant: SingleThreadUpstreamCopy = {
  failedTurn: '這條沒有處理。還需要的話，再發一次。',
  failedTurnPartial: '這一輪沒做完，有些步驟可能已經執行了。再發之前，先看看已經做了什麼。',
  errorBody: {
    generic: '這一輪沒做完，你的訊息還沒有得到回答。',
    provider: '模型服務這次沒有正常回應，你的訊息還沒有得到回答。',
    endpoint: '連不上設定的模型位址，你的訊息還沒有得到回答。',
    streaming: '回覆傳到一半斷開了，你的訊息還沒有得到完整的回答。',
    auth: '模型服務沒有接受這次登入。請重新登入 APEX 後再試（用自己金鑰的，檢查一下金鑰）。',
    billing: '額度不夠了，你的訊息還沒有得到回答。',
    gateway: '連線模型服務時出了問題，你的訊息還沒有得到回答。',
    runtime: 'APEX 在這台電腦上的引擎出了問題，你的訊息還沒有得到回答。一直這樣的話，結束 APEX 再重新開啟。',
    disk: '磁碟空間不夠，這一輪沒辦法繼續。騰出一些空間後再試。'
  },
  serviceSaid: '服務方說：'
}

const en: SingleThreadUpstreamCopy = {
  failedTurn: "This message wasn't processed. Send it again if you still need it.",
  failedTurnPartial:
    "This turn didn't finish, and some steps may already have run. Check what was done before sending it again.",
  errorBody: {
    generic: "This turn didn't finish; your message hasn't been answered.",
    provider: "The model service didn't respond properly; your message hasn't been answered.",
    endpoint: "The configured model address can't be reached; your message hasn't been answered.",
    streaming: "The reply was cut off on the way; your message hasn't been fully answered.",
    auth: "The model service didn't accept this sign-in. Sign in to APEX again, then try again (or check your own key, if you use one).",
    billing: "Your usage quota has run out; your message hasn't been answered.",
    gateway: "Something went wrong while reaching the model service; your message hasn't been answered.",
    runtime:
      "APEX's engine on this computer ran into a problem; your message hasn't been answered. If it keeps happening, quit APEX and open it again.",
    disk: "There isn't enough disk space to continue. Free some space, then try again."
  },
  serviceSaid: 'The service said: '
}

export const SINGLE_THREAD_UPSTREAM_COPY: Readonly<Record<Locale, SingleThreadUpstreamCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadUpstreamCopy(): SingleThreadUpstreamCopy {
  return SINGLE_THREAD_UPSTREAM_COPY[useI18n().locale] ?? en
}

/** For code outside React (transcript hydration): the app's active locale. */
export function singleThreadUpstreamCopyNow(): SingleThreadUpstreamCopy {
  return SINGLE_THREAD_UPSTREAM_COPY[getRuntimeI18nLocale()] ?? en
}
