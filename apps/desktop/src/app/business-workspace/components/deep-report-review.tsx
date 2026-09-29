import { useState } from 'react'

import { Button } from '@/components/ui/button'

import type { DeepAnalysisReport, DeepReportReviewInput } from '../../../../shared/analysis-deep-report'
import type { OverviewLocale } from '../../../../shared/analysis-video-overview'

import { ANALYSIS_TURN_COPY } from './deep-analysis-turn'

const COPY = {
  zh: { collection: '收取对应发送', observation: '收取时已记录的状态', unknown: '尚未确认', missing: '未记录对应发送（手动导入或旧版报告）。', disclosure: '发送信息由收取设备记录，不证明报告作者或 Hypit 执行。验收只代表你的判断。', pending: '待你验收', accepted: '你已标记可用', changes_requested: '你已要求修改', note: '验收备注', accept: '标记可用', changes: '要求修改', clear: '撤销验收', unavailable: '请更新客户端后记录验收。', limit: '备注最多 2000 UTF-8 字节。' },
  'zh-hant': { collection: '收取對應傳送', observation: '收取時已記錄的狀態', unknown: '尚未確認', missing: '未記錄對應傳送（手動匯入或舊版報告）。', disclosure: '傳送資訊由收取裝置記錄，不證明報告作者或 Hypit 執行。驗收只代表你的判斷。', pending: '待你驗收', accepted: '你已標記可用', changes_requested: '你已要求修改', note: '驗收備註', accept: '標記可用', changes: '要求修改', clear: '撤銷驗收', unavailable: '請更新客戶端後記錄驗收。', limit: '備註最多 2000 UTF-8 位元組。' },
  en: { collection: 'Collected from submission', observation: 'Status recorded at collection', unknown: 'Not confirmed', missing: 'No submission recorded (manual import or older report).', disclosure: 'Submission details are reported by the collecting device, not proof of authorship or Hypit execution. Review records only your judgment.', pending: 'Awaiting your review', accepted: 'You marked this usable', changes_requested: 'You requested changes', note: 'Review note', accept: 'Mark usable', changes: 'Request changes', clear: 'Clear review', unavailable: 'Update the client to record a review.', limit: 'Notes must fit within 2000 UTF-8 bytes.' },
  ja: { collection: '取得元の送信', observation: '取得時に記録された状態', unknown: '未確認', missing: '対応する送信の記録なし（手動取込または旧版）。', disclosure: '送信情報は取得した端末の記録であり、作成者や Hypit の実行を証明しません。確認記録はあなたの判断のみを示します。', pending: 'あなたの確認待ち', accepted: '利用可能と判断済み', changes_requested: '修正を依頼済み', note: '確認メモ', accept: '利用可能にする', changes: '修正を依頼', clear: '確認を取り消す', unavailable: '確認を記録するにはクライアントを更新してください。', limit: 'メモは UTF-8 で 2000 バイト以内です。' },
  ar: { collection: 'جُمع من الإرسال', observation: 'الحالة المسجلة عند الجمع', unknown: 'غير مؤكدة', missing: 'لا يوجد إرسال مسجل (استيراد يدوي أو تقرير أقدم).', disclosure: 'الجهاز الذي جمع التقرير يسجل بيانات الإرسال؛ وهي لا تثبت المؤلف أو تنفيذ Hypit. المراجعة تسجل حكمك فقط.', pending: 'بانتظار مراجعتك', accepted: 'علّمته صالحًا للاستخدام', changes_requested: 'طلبت تعديلات', note: 'ملاحظة المراجعة', accept: 'تحديده كصالح للاستخدام', changes: 'طلب تعديلات', clear: 'إلغاء المراجعة', unavailable: 'حدّث التطبيق لتسجيل مراجعة.', limit: 'الحد الأقصى للملاحظة 2000 بايت UTF-8.' }
}

export function DeepReportReview({ report, locale, disabled, onReview }: {
  report: DeepAnalysisReport; locale: OverviewLocale; disabled: boolean
  onReview?: (decision: DeepReportReviewInput['decision'], note: string) => void
}) {
  const c = COPY[locale]
  const [note, setNote] = useState(report.review?.note ?? '')
  const overLimit = new TextEncoder().encode(note).length > 2000
  const collection = report.collection
  const formatTime = (value: string) => new Date(value).toLocaleString(locale === 'zh-hant' ? 'zh-TW' : locale)

  return <div className="mt-3 space-y-2 border-t pt-3 text-xs">
    {collection ? <>
      <p>{c.collection}: <time dateTime={collection.submitted_at}>{formatTime(collection.submitted_at)}</time> · {collection.workspace_id.slice(0, 8)}</p>
      <p>{c.observation}: {collection.observed_status ? ANALYSIS_TURN_COPY[locale][collection.observed_status] : c.unknown}</p>
    </> : <p>{c.missing}</p>}
    <p className="text-(--ui-text-tertiary)">{c.disclosure}</p>
    <p role="status">{report.review ? c[report.review.decision] : c.pending}{report.review && <> · <time dateTime={report.review.reviewed_at}>{formatTime(report.review.reviewed_at)}</time></>}</p>
    <label className="block space-y-1"><span>{c.note}</span>
      <textarea className="block w-full rounded border bg-transparent p-2 text-sm" disabled={disabled || !onReview} onChange={event => setNote(event.target.value)} rows={2} value={note} />
    </label>
    {overLimit && <p className="text-destructive" role="alert">{c.limit}</p>}
    {onReview ? <div className="flex flex-wrap gap-2">
      <Button disabled={disabled || overLimit} onClick={() => onReview('accepted', note)} size="sm" type="button" variant="outline">{c.accept}</Button>
      <Button disabled={disabled || overLimit} onClick={() => onReview('changes_requested', note)} size="sm" type="button" variant="outline">{c.changes}</Button>
      {report.review && <Button disabled={disabled} onClick={() => onReview('unreviewed', '')} size="sm" type="button" variant="ghost">{c.clear}</Button>}
    </div> : <p>{c.unavailable}</p>}
  </div>
}
