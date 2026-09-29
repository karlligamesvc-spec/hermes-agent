import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'

import type { AnalysisChatLink } from '../../../../shared/analysis-chat-link'
import type { OverviewLocale } from '../../../../shared/analysis-video-overview'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'
import { refreshAnalysisTurnOutcome } from '../video-analysis-turn-outcome'

const COPY = {
  zh: { label: '最近读取的本次发送状态', refresh: '刷新本次发送状态', pending: '正在读取状态…', unknown: '尚未确认；请打开聊天查看。', failed: '状态读取或保存失败，请重试。', running: '执行中', complete: '执行已结束；报告及内容尚未核验。', error: '本次执行失败，请打开聊天查看。', interrupted: '本次执行已中断。', unavailable: '运行时已无法提供本次状态；请打开聊天查看。' },
  'zh-hant': { label: '最近讀取的本次傳送狀態', refresh: '重新讀取本次傳送狀態', pending: '正在讀取狀態…', unknown: '尚未確認；請開啟對話查看。', failed: '狀態讀取或儲存失敗，請重試。', running: '執行中', complete: '執行已結束；報告及內容尚未核驗。', error: '本次執行失敗，請開啟對話查看。', interrupted: '本次執行已中斷。', unavailable: '執行環境已無法提供本次狀態；請開啟對話查看。' },
  en: { label: 'Last observed status of this submission', refresh: 'Refresh this submission status', pending: 'Reading status…', unknown: 'Not confirmed; open the chat to inspect it.', failed: 'Could not read or save status. Please retry.', running: 'Running', complete: 'Execution ended; the report and its claims remain unverified.', error: 'This execution failed. Open the chat for details.', interrupted: 'This execution was interrupted.', unavailable: 'The runtime no longer has this outcome. Open the chat to inspect it.' },
  ja: { label: 'この送信の最終確認状態', refresh: 'この送信の状態を更新', pending: '状態を読み込み中…', unknown: '未確認です。会話を開いて確認してください。', failed: '状態の読み込みまたは保存に失敗しました。再試行してください。', running: '実行中', complete: '実行は終了しました。レポートと内容は未検証です。', error: '今回の実行は失敗しました。会話を確認してください。', interrupted: '今回の実行は中断されました。', unavailable: '実行環境に今回の結果がありません。会話を確認してください。' },
  ar: { label: 'آخر حالة تمت قراءتها لهذا الإرسال', refresh: 'تحديث حالة هذا الإرسال', pending: 'جارٍ قراءة الحالة…', unknown: 'لم يتم التأكد؛ افتح المحادثة للمراجعة.', failed: 'تعذرت قراءة الحالة أو حفظها. أعد المحاولة.', running: 'قيد التنفيذ', complete: 'انتهى التنفيذ؛ التقرير ومحتواه لم يخضعا للتحقق.', error: 'فشل هذا التنفيذ. افتح المحادثة للتفاصيل.', interrupted: 'تم إيقاف هذا التنفيذ.', unavailable: 'لم تعد نتيجة هذا الإرسال متاحة لدى بيئة التشغيل. راجع المحادثة.' }
}

export function DeepAnalysisTurn({ source, link, locale, bridge }: {
  source: AnalysisDocument; link: AnalysisChatLink; locale: OverviewLocale; bridge: AnalysisDocumentsBridge
}) {
  const copy = COPY[locale]
  const [outcome, setOutcome] = useState(link.outcome)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const terminal = Boolean(outcome && ['complete', 'error', 'interrupted'].includes(outcome.status))
  // Request-scoped lifecycle only; the runtime, not a renderer atom, owns this result.
  useEffect(() => {
    let active = true

    if (!link.turn || !bridge.updateDeepChatOutcome || terminal) {return}
    setLoading(true); setFailed(false)
    void refreshAnalysisTurnOutcome(source, link, bridge, () => active).then(saved => {
      if (active) {setLoading(false); setOutcome(saved.outcome)}
    }).catch(() => {if (active) {setFailed(true)}}).finally(() => {if (active) {setLoading(false)}})

    return () => {active = false}
  }, [source, link, bridge, terminal, attempt])

  return <div className="space-y-2" data-analysis-turn-status>
    <p>{copy.label}: {outcome ? copy[outcome.status] : copy.unknown}</p>
    {loading && <p role="status">{copy.pending}</p>}
    {failed && <p role="alert">{copy.failed}</p>}
    {link.turn && bridge.updateDeepChatOutcome && !terminal && <Button disabled={loading} onClick={() => setAttempt(value => value + 1)} size="sm" variant="outline">{copy.refresh}</Button>}
  </div>
}
