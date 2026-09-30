import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { $gateway } from '@/store/gateway'
import { $connection } from '@/store/session'

import { type OverviewLocale, validateVideoOverview, type VideoSemanticOverview } from '../../../../shared/analysis-video-overview'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'
import { loadVideoSemanticOverview } from '../video-semantic-overview'

const COPY = {
  zh: { title: '语音内容摘要', pending: '正在概括转写内容…', disclosure: '转写文本会交给本机助手配置的模型处理，并按该通道计费；摘要按资料的保存方式保存。仅概括语音，模型可能出错，请核对出处。', unavailable: '连接本机助手后可生成摘要。', failed: '摘要生成或保存失败，原文仍可查看。', large: '转写超出快速摘要长度上限，请用深度拆解分段分析。', retry: '重试摘要', citation: '查看出处', saved: '摘要已保存' },
  'zh-hant': { title: '語音內容摘要', pending: '正在概括逐字稿…', disclosure: '逐字稿會交給本機助手設定的模型處理，並依該通道計費；摘要依資料的儲存方式保存。僅概括語音，模型可能出錯，請核對出處。', unavailable: '連接本機助手後可產生摘要。', failed: '摘要產生或儲存失敗，仍可查看原文。', large: '逐字稿超過快速摘要長度上限，請用深度拆解分段分析。', retry: '重試摘要', citation: '查看出處', saved: '摘要已儲存' },
  en: { title: 'Audio content summary', pending: 'Summarizing the transcript…', disclosure: 'The transcript is sent to the model configured for your local Agent and billed through that channel. The summary follows this source’s save mode. Audio only; check citations for model errors.', unavailable: 'Connect to your local Agent to generate a summary.', failed: 'Could not generate or save the summary. The transcript is still available.', large: 'The transcript exceeds the quick-summary limit. Use deep breakdown to analyze it in sections.', retry: 'Retry summary', citation: 'View source', saved: 'Summary saved' },
  ja: { title: '音声内容の要約', pending: '文字起こしを要約中…', disclosure: '文字起こしはローカル助手に設定されたモデルで処理・課金されます。要約は資料と同じ保存先に保存します。音声のみの要約です。誤りがないか出典を確認してください。', unavailable: 'ローカル助手に接続すると要約できます。', failed: '要約の生成または保存に失敗しました。原文は引き続き確認できます。', large: '文字起こしが長さの上限を超えています。詳細分析で分割してください。', retry: '要約を再試行', citation: '出典を確認', saved: '要約を保存しました' },
  ar: { title: 'ملخص محتوى الصوت', pending: 'جارٍ تلخيص النص…', disclosure: 'يُرسل النص إلى النموذج المُعد للمساعد المحلي وتُحتسب التكلفة عبر تلك القناة. يتبع الملخص وضع حفظ المصدر. يُلخص الصوت فقط؛ تحقق من المراجع لأن النموذج قد يخطئ.', unavailable: 'اتصل بالمساعد المحلي لإنشاء ملخص.', failed: 'تعذر إنشاء الملخص أو حفظه. لا يزال النص الأصلي متاحًا.', large: 'النص يتجاوز حد الملخص السريع. استخدم التحليل المتعمق على أجزاء.', retry: 'إعادة المحاولة', citation: 'عرض المصدر', saved: 'تم حفظ الملخص' }
}

export function VideoSemanticOverviewPanel({ source, locale, bridge, jump, label }: {
  source: AnalysisDocument; locale: OverviewLocale; bridge: AnalysisDocumentsBridge | undefined | null
  jump: (id: string) => void; label: (location: Record<string, number | string>) => string
}) {
  const gateway = useStore($gateway)
  const connection = useStore($connection)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ item?: VideoSemanticOverview; error?: string }>({})
  const c = COPY[locale]
  const cached = useMemo(() => {
    try {return validateVideoOverview(source.video_overviews?.[locale], source, source.analysis_revision ?? '', locale)}
    catch {return undefined}
  }, [source, locale])

  useEffect(() => {
    let active = true
    setState({ item: cached })

    if (cached) {return}

    if (!gateway || connection?.mode === 'remote' || !bridge?.overviewContext || !source.analysis_scope) {return}
    void loadVideoSemanticOverview(source, locale, bridge, gateway, () =>
      $gateway.get() === gateway && $connection.get() === connection
    ).then(item => { if (active) {setState({ item })} }).catch(error => {
      if (active) {setState({ error: error instanceof Error ? error.message : 'overview_unavailable' })}
    })

    return () => { active = false }
    // Source identity/revision, rather than refreshed notes, owns this operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.analysis_scope, source.analysis_revision, locale, gateway, connection, bridge, attempt, cached])

  const available = gateway && connection?.mode !== 'remote' && bridge?.overviewContext && source.analysis_scope

  return <section aria-label={c.title} className="space-y-3 rounded-xl border p-4">
    <h3 className="font-medium">{c.title}</h3>
    <p className="text-xs text-(--ui-text-tertiary)">{c.disclosure}</p>
    {state.item ? <>
      <p className="text-xs text-(--ui-text-secondary)">{c.saved}</p>
      <ul className="space-y-3">{state.item.points.map((point, index) => <li className="text-sm" key={index}>
        <p>{point.text}</p><div className="flex flex-wrap gap-3">{point.anchor_ids.map(id => {
          const anchor = source.anchors?.find(a => a.id === id)

          return anchor && <button className="text-xs underline" key={id} onClick={() => jump(id)} type="button">{c.citation} · {label(anchor.location)}</button>
        })}</div>
      </li>)}</ul>
    </> : !available ? <p className="text-sm">{c.unavailable}</p> : state.error ? <>
      <p className="text-sm" role="status">{state.error === 'overview_source_too_large' ? c.large : c.failed}</p>
      {state.error !== 'overview_source_too_large' && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => setAttempt(value => value + 1)} type="button">{c.retry}</button>}
    </> : <p className="text-sm" role="status">{c.pending}</p>}
  </section>
}
