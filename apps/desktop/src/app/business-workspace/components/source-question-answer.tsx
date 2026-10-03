import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { $authState } from '@/store/auth'
import { $activeConnectionId } from '@/store/connections'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import type { OverviewLocale } from '../../../../shared/analysis-video-overview'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'
import { answerSourceQuestion } from '../source-question-answer'

export const SOURCE_ANSWER_COPY = {
  zh: { upgrade: '此功能需要更新 APEX 资料服务；仍可查找原文证据。', ask: '让助手回答', pending: '正在依据原文回答…', disclosure: '点击后，当前资料的原文和问题会交给本机助手配置的模型处理，并按该通道计费；回答随资料保存。模型可能出错，请核对出处。', unavailable: '连接本机助手后可生成回答。', failed: '回答生成或保存失败，请重试；原文仍可查看。', large: '资料超出问答长度上限，请导入较短的章节，或继续查找原文证据。', label: '助手回答 · 请核对出处', noEvidence: '资料未提供足够证据回答这个问题。', stale: '此回答基于旧版资料，引用已停用。' },
  'zh-hant': { upgrade: '此功能需要更新 APEX 資料服務；仍可尋找原文證據。', ask: '讓助手回答', pending: '正在依據原文回答…', disclosure: '點擊後，目前資料的原文和問題會交給本機助手設定的模型處理，並依該通道計費；回答隨資料儲存。模型可能出錯，請核對出處。', unavailable: '連接本機助手後可產生回答。', failed: '回答產生或儲存失敗，請重試；仍可查看原文。', large: '資料超過問答長度上限，請匯入較短章節，或繼續尋找原文證據。', label: '助手回答 · 請核對出處', noEvidence: '資料未提供足夠證據回答這個問題。', stale: '此回答依據舊版資料，引用已停用。' },
  en: { upgrade: 'Update the APEX document service to use model answers. Original evidence search is still available.', ask: 'Ask the Agent', pending: 'Answering from the source…', disclosure: 'This sends the current source text and question to your local Agent’s configured model, billed through that channel. Answers are saved with the source. Check citations for model errors.', unavailable: 'Connect to your local Agent to generate an answer.', failed: 'Could not generate or save the answer. Try again; the source remains available.', large: 'This source exceeds the question length limit. Import a shorter section or find original evidence.', label: 'Agent answer · check the sources', noEvidence: 'The source does not provide enough evidence to answer this question.', stale: 'This answer uses an older source version. Citation links are disabled.' },
  ja: { upgrade: 'APEX 資料サービスの更新が必要です。原文検索は利用できます。', ask: '助手に質問する', pending: '原文に基づいて回答中…', disclosure: 'クリックすると現在の資料の原文と質問がローカル助手に設定されたモデルへ送られ、同じ経路で課金されます。回答は資料とともに保存されます。モデルの誤りがないか出典を確認してください。', unavailable: '回答を生成するにはローカル助手に接続してください。', failed: '回答の生成または保存に失敗しました。再試行してください。原文は閲覧できます。', large: '資料が問答の長さ制限を超えています。短い章を読み込むか、原文の検索をご利用ください。', label: '助手の回答 · 出典をご確認ください', noEvidence: 'この資料には質問に答えるための十分な根拠がありません。', stale: '旧版資料に基づく回答です。出典リンクは無効です。' },
  ar: { upgrade: 'حدّث خدمة مستندات APEX لاستخدام إجابات النموذج. لا يزال البحث في الأدلة الأصلية متاحًا.', ask: 'اسأل المساعد', pending: 'جارٍ الإجابة من المصدر…', disclosure: 'يرسل هذا نص المصدر الحالي والسؤال إلى النموذج المُعد للمساعد المحلي، وتُحتسب التكلفة عبر تلك القناة. تُحفظ الإجابات مع المصدر. تحقق من المراجع لأن النموذج قد يخطئ.', unavailable: 'اتصل بالمساعد المحلي لإنشاء إجابة.', failed: 'تعذر إنشاء الإجابة أو حفظها. حاول مجددًا؛ يبقى المصدر متاحًا.', large: 'المصدر يتجاوز حد طول الأسئلة. استورد قسمًا أقصر أو ابحث عن أدلة أصلية.', label: 'إجابة المساعد · تحقق من المصادر', noEvidence: 'لا يقدم المصدر أدلة كافية للإجابة عن هذا السؤال.', stale: 'تستند هذه الإجابة إلى إصدار أقدم من المصدر. روابط المراجع معطلة.' }
}

export function SourceQuestionAction({ source, question, locale, bridge, onSaved, children }: {
  source: AnalysisDocument; question: string; locale: OverviewLocale; bridge: AnalysisDocumentsBridge | null
  onSaved: (id: string) => Promise<void>
  children?: (state: { busy: boolean; available: boolean; submittedQuestion: string; submit: () => void }) => ReactNode
}) {
  const gateway = useStore($gateway)
  const connection = useStore($connection)
  const connectionId = useStore($activeConnectionId)
  const profile = useStore($activeGatewayProfile)
  const auth = useStore($authState)
  const lifetime = useRef<object>({})
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [submittedQuestion, setSubmittedQuestion] = useState('')
  const c = SOURCE_ANSWER_COPY[locale]
  // Attempt lifetime/lock only; reactive values are read directly from stores below.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    lifetime.current = {}
    running.current = false
    setBusy(false)
    setError('')

    return () => { lifetime.current = {} }
  }, [source.id, source.analysis_scope, source.analysis_revision, gateway, connection, connectionId, profile, auth.status, auth.account.email])
  const needsUpgrade = source.storageMode === 'cloud' && source.source_answers_supported !== true
  const available = !needsUpgrade && gateway && connection?.mode !== 'remote' && typeof bridge?.questionContext === 'function' && typeof bridge?.saveAnswer === 'function' && source.analysis_scope

  const ask = async () => {
    if (!available || !gateway || !bridge || running.current || question.trim().length < 2 || question.length > 1000) {return}
    const token = lifetime.current

    const current = () => token === lifetime.current && $gateway.get() === gateway && $connection.get() === connection &&
      $activeConnectionId.get() === connectionId && $activeGatewayProfile.get() === profile &&
      $authState.get().status === auth.status && $authState.get().accountId === auth.accountId && $authState.get().account.email === auth.account.email

    running.current = true
    setBusy(true)
    setSubmittedQuestion(question)
    setError('')

    try {
      await answerSourceQuestion(source, question, locale, bridge, gateway, current)

      if (current()) {await onSaved(source.id)}
    } catch (error) {
      if (current()) {setError(error instanceof Error ? error.message : 'answer_unavailable')}
    } finally {
      if (token === lifetime.current) {running.current = false; setBusy(false)}
    }
  }

  return <div className="space-y-2">
    {children ? children({ busy, available: !!available, submittedQuestion, submit: () => void ask() }) : <>
    <p className="text-xs text-(--ui-text-tertiary)">{c.disclosure}</p>
    <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={!available || busy || question.trim().length < 2 || question.length > 1000} onClick={() => void ask()} type="button">{busy ? c.pending : c.ask}</button>
    </>}
    {!available && <p className="text-sm">{needsUpgrade ? c.upgrade : c.unavailable}</p>}
    {error && <p className="text-sm" role="status">{error === 'answer_source_too_large' ? c.large : error === 'answer_backend_upgrade_required' ? c.upgrade : c.failed}</p>}
  </div>
}
