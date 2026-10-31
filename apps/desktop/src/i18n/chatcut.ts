/**
 * Copy for hc-1122: the ChatCut page in product mode's Settings.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink). Each locale is a whole typed
 * object, so a missing zh string is a type error rather than an English
 * fallback; zh, zh-hant and en are complete, ja and ar read en.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface ChatcutCopy {
  /** The rail, and the page's heading. */
  title: string
  intro: string
  connected: string
  connectedHint: string
  notConnected: string
  notConnectedHint: string
  /** The state could not be read: the engine is starting, or did not answer. */
  unknown: string
  disconnect: string
  disconnecting: string
  disconnectConfirm: string
  disconnectFailed: string
  /** What leaves this computer, and whose account it is. */
  privacy: string
}

const en: ChatcutCopy = {
  title: 'ChatCut',
  intro: 'Edit footage you already shot: remove flubs, add captions, cut it down, export it.',
  connected: 'Connected',
  connectedHint: 'This assistant can edit in your ChatCut account.',
  notConnected: 'Not connected',
  notConnectedHint: 'Ask in the chat to edit a video, and the assistant will offer to connect.',
  unknown: 'Can’t read the connection right now. Try again in a moment.',
  disconnect: 'Disconnect',
  disconnecting: 'Disconnecting…',
  disconnectConfirm:
    'Disconnect removes this assistant’s sign-in from this computer. To also withdraw the approval, do that in your ChatCut account.',
  disconnectFailed: 'Couldn’t disconnect. Try again.',
  privacy:
    'ChatCut is a third-party service with servers in the United States. It uses your own ChatCut account and credits, and asks before the first upload.'
}

const zh: ChatcutCopy = {
  title: 'ChatCut 剪辑',
  intro: '剪你已经拍好的素材：去口误、加字幕、粗剪、导出。',
  connected: '已连接',
  connectedHint: '这个助手可以用你的 ChatCut 账号剪辑。',
  notConnected: '未连接',
  notConnectedHint: '在对话里说要剪视频，助手会问你要不要连接。',
  unknown: '现在读不到连接状态，稍后再试。',
  disconnect: '断开',
  disconnecting: '正在断开…',
  disconnectConfirm: '断开后，这台电脑上这个助手的授权会被清掉。ChatCut 账号那边的授权记录，需要你到 ChatCut 里处理。',
  disconnectFailed: '没有断开成功，请再试一次。',
  privacy: 'ChatCut 是第三方服务，服务器在美国。用的是你自己的 ChatCut 账号和额度，第一次上传素材前会先问你。'
}

const zhHant: ChatcutCopy = {
  title: 'ChatCut 剪輯',
  intro: '剪你已經拍好的素材：去口誤、加字幕、粗剪、匯出。',
  connected: '已連接',
  connectedHint: '這個助手可以用你的 ChatCut 帳號剪輯。',
  notConnected: '未連接',
  notConnectedHint: '在對話裡說要剪影片，助手會問你要不要連接。',
  unknown: '現在讀不到連接狀態，稍後再試。',
  disconnect: '斷開',
  disconnecting: '正在斷開…',
  disconnectConfirm: '斷開後，這台電腦上這個助手的授權會被清掉。ChatCut 帳號那邊的授權記錄，需要你到 ChatCut 裡處理。',
  disconnectFailed: '沒有斷開成功，請再試一次。',
  privacy: 'ChatCut 是第三方服務，伺服器在美國。用的是你自己的 ChatCut 帳號和額度，第一次上傳素材前會先問你。'
}

const COPY: Readonly<Record<Locale, ChatcutCopy>> = { ar: en, en, ja: en, zh, 'zh-hant': zhHant }

export function useChatcutCopy(): ChatcutCopy {
  return COPY[useI18n().locale]
}
