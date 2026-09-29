import type { SubmitTextOptions } from '@/app/session/hooks/use-prompt-actions/utils'
import { $activeConnectionId } from '@/store/connections'
import { notify } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import { validAnalysisWorkspaceId } from '../../../shared/analysis-chat-link'
import type { OverviewLocale } from '../../../shared/analysis-video-overview'

import { analysisDocumentsBridge } from './analysis-bridge'

export const ANALYSIS_CHAT_COPY = {
  zh: { open: '打开最近发送的拆解会话', hint: '仅在本机记录已发送的会话；不代表报告已完成或内容已核验。', none: '本机尚无已发送的拆解会话。', failed: '无法读取或打开拆解会话，请重试。', recordFailed: '消息已发送，但资料的会话链接保存失败。请从历史会话查看；不要重复发送。', context: '请切回准备草稿时的本机连接和档案，再发送或打开会话。' },
  'zh-hant': { open: '開啟最近傳送的拆解對話', hint: '僅在本機記錄已傳送的對話；不代表報告已完成或內容已核驗。', none: '本機尚無已傳送的拆解對話。', failed: '無法讀取或開啟拆解對話，請重試。', recordFailed: '訊息已傳送，但資料的對話連結儲存失敗。請從歷史對話查看，勿重複傳送。', context: '請切回準備草稿時的本機連線及設定檔，再傳送或開啟對話。' },
  en: { open: 'Open latest submitted breakdown chat', hint: 'This device records the submitted chat only; report completion and claims remain unverified.', none: 'No submitted breakdown chat recorded on this device.', failed: 'Could not read or open the breakdown chat. Please retry.', recordFailed: 'Your message was sent, but its source link could not be saved. Open chat history; do not resend.', context: 'Switch back to the local connection and profile used to prepare this draft before sending or opening the chat.' },
  ja: { open: '最近送信した分析チャットを開く', hint: '送信済みの会話をこの端末だけに記録します。レポートの完成や内容の検証を示すものではありません。', none: 'この端末に送信済みの分析チャットはありません。', failed: '分析チャットを読み込みまたは開けませんでした。再試行してください。', recordFailed: 'メッセージは送信済みですが、資料とのリンクを保存できませんでした。再送せず会話履歴を確認してください。', context: '下書きを準備したローカル接続とプロファイルに戻ってから、送信または会話を開いてください。' },
  ar: { open: 'فتح آخر محادثة تحليل مُرسلة', hint: 'يسجل هذا الجهاز المحادثة المُرسلة فقط؛ لا يثبت اكتمال التقرير أو صحة محتواه.', none: 'لا توجد محادثة تحليل مُرسلة مسجلة على هذا الجهاز.', failed: 'تعذرت قراءة محادثة التحليل أو فتحها. أعد المحاولة.', recordFailed: 'أُرسلت رسالتك لكن تعذر حفظ رابط المصدر. افتح سجل المحادثات ولا تعِد الإرسال.', context: 'عُد إلى الاتصال المحلي والملف الشخصي المستخدمين لإعداد المسودة قبل الإرسال أو فتح المحادثة.' }
}

export function analysisChatContextMatches(target: { connectionId: string | null; profile: string }): boolean {
  return $connection.get()?.mode !== 'remote' && $activeConnectionId.get() === target.connectionId &&
    ($activeGatewayProfile.get() || 'default') === target.profile
}

/** Route metadata is a draft, never a receipt. Only the submit pipeline can accept it. */
export function analysisChatSubmitOptions(value: unknown, text: string): SubmitTextOptions | false | undefined {
  if (!value || typeof value !== 'object') {return undefined}
  const draft = value as Record<string, unknown>

  if (typeof draft.sourceId !== 'string' || typeof draft.scope !== 'string' || typeof draft.revision !== 'string' ||
    typeof draft.directory !== 'string' || !draft.directory || typeof draft.profile !== 'string' ||
    (draft.connectionId !== null && typeof draft.connectionId !== 'string') ||
    (draft.workspaceId !== undefined && !validAnalysisWorkspaceId(draft.workspaceId)) ||
    typeof draft.locale !== 'string' || !Object.hasOwn(ANALYSIS_CHAT_COPY, draft.locale)) {return undefined}

  // If the user replaces the draft, the new message must not inherit this source association.
  if (!text.includes(JSON.stringify(draft.directory))) {return undefined}
  const { sourceId, scope, revision, connectionId, profile } = draft
  const copy = ANALYSIS_CHAT_COPY[draft.locale as OverviewLocale]
  const target = { connectionId, profile, ...(typeof draft.workspaceId === 'string' ? { workspaceId: draft.workspaceId } : {}) }

  if (!analysisChatContextMatches(target)) {
    notify({ kind: 'error', title: copy.context, message: '' })

    return false
  }

  const record = analysisDocumentsBridge()?.recordDeepChat

  if (!record) {return undefined} // Older native bridge: ordinary explicit send, no claimed receipt.

  return { onAccepted: async ({ storedSessionId, turn }) => {
    try {
      if (!analysisChatContextMatches(target)) {throw new Error('analysis_context_changed')}
      const result = await record(sourceId, scope, revision, { ...target, sessionId: storedSessionId, ...(turn ? { turn } : {}) })

      if (!result.ok) {throw new Error(result.code)}
    } catch {notify({ kind: 'error', title: copy.recordFailed, message: '' })}
  } }
}
