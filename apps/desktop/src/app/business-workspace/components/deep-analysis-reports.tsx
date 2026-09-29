import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'

import { type DeepAnalysisReport, MAX_DEEP_REPORTS } from '../../../../shared/analysis-deep-report'
import type { OverviewLocale } from '../../../../shared/analysis-video-overview'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'

import { DeepAnalysisChat } from './deep-analysis-chat'

const WORKSPACE_COPY = {
  zh: { collect: '收取', hint: '助手完成后，可从本资料的本机输出目录收取指定文件；不会搜索其他项目，也不代表已核验报告。', missing: '请先准备本资料的深度拆解草稿。', pending: '指定报告尚未生成。请在助手完成后重试。', invalid: '输出目录或文件不符合绑定要求，请重新核对。' },
  'zh-hant': { collect: '收取', hint: '助手完成後，可從本資料的本機輸出目錄收取指定檔案；不會搜尋其他專案，也不代表已核驗報告。', missing: '請先準備本資料的深度拆解草稿。', pending: '指定報告尚未產生，請在助手完成後重試。', invalid: '輸出目錄或檔案不符合綁定要求，請重新核對。' },
  en: { collect: 'Collect', hint: 'After the Agent finishes, collect a named file from this source’s local output folder. Other projects are never searched; report claims remain unverified.', missing: 'Prepare a deep breakdown draft for this source first.', pending: 'This report has not been written yet. Retry after the Agent finishes.', invalid: 'The output folder or file no longer matches its binding. Please check it.' },
  ja: { collect: '取得', hint: '助手の完了後、この資料専用のローカル出力フォルダから指定ファイルを取得します。他のプロジェクトは検索せず、内容は未検証です。', missing: '先にこの資料の詳細分析の下書きを準備してください。', pending: '指定レポートはまだありません。助手の完了後に再試行してください。', invalid: '出力フォルダまたはファイルが登録情報と一致しません。確認してください。' },
  ar: { collect: 'جمع', hint: 'بعد انتهاء الوكيل، اجمع الملف المحدد من مجلد إخراج هذا المصدر المحلي. لا تُبحث مشاريع أخرى وتظل ادعاءات التقرير غير متحققة.', missing: 'جهز مسودة تحليل متعمق لهذا المصدر أولًا.', pending: 'لم يُكتب هذا التقرير بعد. أعد المحاولة بعد انتهاء الوكيل.', invalid: 'لم يعد مجلد الإخراج أو الملف يطابق الارتباط. يرجى التحقق منه.' }
}

const COPY = {
  zh: { title: '深度分析报告', save: '保存报告文件', remove: '删除副本', pending: '正在保存…', empty: '尚未保存报告。', disclosure: '选择本资料对应的 ANALYSIS.md、TIMELINE.md 或文本报告（UTF-8，最多 64 KiB，每份资料 5 份）。副本按资料的保存方式保留。文件由你选择，内容及 Hypit 执行状态尚未核验。', old: '对应较早的资料版本，请重新核对出处。', large: '报告超过 64 KiB，请缩减后重试。', invalid: '请选择非空的 UTF-8 .md 或 .txt 文件。', changed: '资料已变更，请重新打开资料后保存。', limit: '已达 5 份报告，请先删除不需要的副本。', failed: '操作失败，请检查登录和资料保存设置后重试。' },
  'zh-hant': { title: '深度分析報告', save: '儲存報告檔案', remove: '刪除副本', pending: '正在儲存…', empty: '尚未儲存報告。', disclosure: '選擇本資料對應的 ANALYSIS.md、TIMELINE.md 或文字報告（UTF-8，最多 64 KiB，每份資料 5 份）。副本依資料的儲存方式保留。檔案由你選擇，內容及 Hypit 執行狀態尚未核驗。', old: '對應較早的資料版本，請重新核對出處。', large: '報告超過 64 KiB，請縮減後重試。', invalid: '請選擇非空的 UTF-8 .md 或 .txt 檔案。', changed: '資料已變更，請重新開啟資料後儲存。', limit: '已達 5 份報告，請先刪除不需要的副本。', failed: '操作失敗，請檢查登入和資料儲存設定後重試。' },
  en: { title: 'Deep analysis reports', save: 'Save report file', remove: 'Delete copy', pending: 'Saving…', empty: 'No saved reports yet.', disclosure: 'Select this source’s ANALYSIS.md, TIMELINE.md, or text report (UTF-8, up to 64 KiB; 5 per source). Copies follow the source’s save mode. You selected the file; its claims and Hypit execution have not been verified.', old: 'Saved for an earlier source revision. Check its references again.', large: 'The report exceeds 64 KiB. Shorten it and retry.', invalid: 'Choose a non-empty UTF-8 .md or .txt file.', changed: 'The source changed. Reopen it before saving.', limit: 'Five reports are saved. Delete an unused copy first.', failed: 'Operation failed. Check your sign-in and source storage settings, then retry.' },
  ja: { title: '詳細分析レポート', save: 'レポートファイルを保存', remove: 'コピーを削除', pending: '保存中…', empty: '保存済みレポートはありません。', disclosure: 'この資料の ANALYSIS.md、TIMELINE.md またはテキストレポートを選択してください（UTF-8、最大 64 KiB、資料ごとに 5 件）。コピーは資料と同じ保存先に保存されます。選択されたファイルの内容と Hypit の実行状況は未検証です。', old: '以前の資料バージョンに対応しています。出典を再確認してください。', large: '64 KiB を超えています。短くして再試行してください。', invalid: '空でない UTF-8 の .md または .txt ファイルを選択してください。', changed: '資料が変更されました。開き直してから保存してください。', limit: '5 件保存されています。不要なコピーを先に削除してください。', failed: '操作に失敗しました。ログインと保存設定を確認して再試行してください。' },
  ar: { title: 'تقارير التحليل المتعمق', save: 'حفظ ملف التقرير', remove: 'حذف النسخة', pending: 'جارٍ الحفظ…', empty: 'لا توجد تقارير محفوظة بعد.', disclosure: 'اختر ملف ANALYSIS.md أو TIMELINE.md أو تقريرًا نصيًا لهذا المصدر (UTF-8، حتى 64 KiB؛ 5 لكل مصدر). تتبع النسخ وضع حفظ المصدر. أنت تختار الملف؛ لم يتم التحقق من محتواه أو تنفيذ Hypit.', old: 'حُفظ لإصدار سابق من المصدر. تحقق من المراجع مجددًا.', large: 'يتجاوز التقرير 64 KiB. اختصره وأعد المحاولة.', invalid: 'اختر ملف .md أو .txt غير فارغ بترميز UTF-8.', changed: 'تغير المصدر. أعد فتحه قبل الحفظ.', limit: 'تم حفظ خمسة تقارير. احذف نسخة غير ضرورية أولًا.', failed: 'فشلت العملية. تحقق من تسجيل الدخول وإعدادات حفظ المصدر ثم أعد المحاولة.' }
}

export function DeepAnalysisReports({ source, locale, bridge, onChange }: {
  source: AnalysisDocument; locale: OverviewLocale; bridge: AnalysisDocumentsBridge | null | undefined
  onChange: (reports: DeepAnalysisReport[]) => void
}) {
  const c = COPY[locale]
  const w = WORKSPACE_COPY[locale]
  const reports = source.deep_reports ?? []
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  const pending = useRef(false)
  // This ref tracks mount lifetime, not a mirrored atom or reactive value.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => { active.current = true;

 return () => { active.current = false } }, [])

  async function perform(operation: () => Promise<DeepAnalysisReport[] | undefined>) {
    if (pending.current) {return}
    pending.current = true
    setBusy(true); setError('')

    try {
      const next = await operation()

      if (active.current && next) {onChange(next)}
    } catch (e) {
      const code = e instanceof Error ? e.message : ''

      const workspaceError = ({ workspace_missing: w.missing, workspace_report_missing: w.pending, workspace_invalid: w.invalid } as Record<string, string>)[code]

      const message = workspaceError ?? (code === 'report_too_large' ? c.large : code === 'report_limit' ? c.limit
        : ['report_invalid', 'report_unreadable'].includes(code) ? c.invalid
          : ['source_not_found', 'report_source_changed', 'report_source_unavailable'].includes(code) ? c.changed : c.failed)

      if (active.current) {setError(message)}
    } finally {
      pending.current = false

      if (active.current) {setBusy(false)}
    }
  }

  return <section aria-label={c.title} className="space-y-3 rounded-xl border p-4">
    <h3 className="font-medium">{c.title}</h3>
    {bridge?.readDeepChat && <DeepAnalysisChat bridge={bridge} locale={locale} source={source} />}
    <p className="text-xs text-(--ui-text-tertiary)">{c.disclosure}</p>
    <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !bridge?.importDeepReport || !source.analysis_scope || !source.analysis_revision || source.status !== 'ready' || reports.length >= MAX_DEEP_REPORTS} onClick={() => void perform(async () => {
      const result = await bridge!.importDeepReport(source.id, source.analysis_scope!, source.analysis_revision!)

      if (result.code === 'cancelled') {return}

      if (!result.ok || !result.item) {throw new Error(result.code)}

      return [...reports.filter(item => item.id !== result.item!.id), result.item]
    })} type="button">{busy ? c.pending : c.save}</button>
    {bridge?.collectDeepReport && <>
      <p className="text-xs text-(--ui-text-tertiary)">{w.hint}</p>
      <div className="flex flex-wrap gap-2">
        {(['ANALYSIS.md', 'TIMELINE.md'] as const).map(filename => <Button disabled={busy || !source.analysis_scope || !source.analysis_revision || source.status !== 'ready'} key={filename} onClick={() => void perform(async () => {
          const result = await bridge.collectDeepReport(source.id, source.analysis_scope!, source.analysis_revision!, filename)

          if (!result.ok || !result.item) {throw new Error(result.code)}

          return [...reports.filter(item => item.id !== result.item!.id), result.item]
        })} size="sm" type="button" variant="outline">{w.collect} {filename}</Button>)}
      </div>
    </>}
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    {!reports.length && <p className="text-sm text-(--ui-text-secondary)">{c.empty}</p>}
    {reports.map(report => <article className="space-y-2 rounded-lg border p-3" key={report.id}>
      <details>
        <summary className="cursor-pointer text-sm">{report.filename} · {new Date(report.created_at).toLocaleString(locale === 'zh-hant' ? 'zh-TW' : locale)}</summary>
        {report.revision !== source.analysis_revision && <p className="my-2 text-xs" role="status">{c.old}</p>}
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{report.body}</pre>
      </details>
      <button className="text-xs underline disabled:opacity-50" disabled={busy || !bridge?.deleteDeepReport || !source.analysis_scope} onClick={() => void perform(async () => {
        const result = await bridge!.deleteDeepReport(source.id, source.analysis_scope!, report.id)

        if (!result.ok) {throw new Error(result.code)}

        return reports.filter(item => item.id !== report.id)
      })} type="button">{c.remove} · {report.filename}</button>
    </article>)}
  </section>
}
