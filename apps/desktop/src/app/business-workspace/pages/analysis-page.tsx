import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/i18n'

import type { AnalysisDocument, AnalysisDocumentsBridge, AnalysisQuestion } from '../analysis-types'
import { BusinessPageHeader } from '../components/business-page-header'

const COPY = {
  zh: {
    title: '沉浸式分析', description: '导入资料，沿着原文证据提问和记笔记。', import: '导入文档',
    link: '粘贴资料链接', linkHint: '飞书文档需要本人授权及读取权限。', openLink: '在原站打开', importLink: '读取链接', authorize: '授权飞书', authorizing: '等待飞书授权…', authorized: '已授权，可读取链接',
    local: '本地保存', cloud: '云端保存', localDisclosure: '本地保存：导入文件的原件、飞书正文快照、证据和笔记留在这台设备；解析请求会经过 APEX，飞书授权令牌由 APEX 加密保管。',
    cloudDisclosure: '云端保存：导入文件的原件或飞书正文快照，以及证据和笔记保存在当前账号下，可跨设备回看。飞书授权令牌由 APEX 加密保管。',
    cloudUnavailable: '云端资料存储尚未配置，请联系平台管理员。',
    empty: '尚无资料。导入 PDF、Word、Excel 或文本文件开始。', processing: '正在解析原文…', ready: '可提问', failed: '解析失败',
    retry: '重试解析', chooseAgain: '重新选择文件', open: '打开原文件', remove: '删除资料',
    question: '针对当前资料提问', ask: '查找证据', noEvidence: '这份资料中未找到相关原文证据。', excerpts: '匹配的原文片段',
    note: '保存笔记', notePlaceholder: '记录你的发现', notes: '笔记', evidence: '原文证据', source: '资料记录',
    noSourceText: '尚未取得可读取的正文。', select: '选择一份资料查看原文。', deleteNote: '删除笔记',
    error: '操作失败，请重试。', permission: '此链接的正文尚未获授权读取，无法生成问答。', page: '第 {n} 页', paragraph: '第 {n} 段', sheet: '{sheet} · {cell}',
    anchorNote: '记到此处', selectedAnchor: '当前引用', citation: '查看出处', unsupportedLink: '暂不支持直接读取此链接，请下载文档后导入。'
  },
  'zh-hant': {
    title: '沉浸式分析', description: '匯入資料，沿著原文證據提問和記筆記。', import: '匯入文件',
    link: '貼上資料連結', linkHint: '飛書文件需要本人授權及讀取權限。', openLink: '在原站開啟', importLink: '讀取連結', authorize: '授權飛書', authorizing: '等待飛書授權…', authorized: '已授權，可讀取連結',
    local: '本機儲存', cloud: '雲端儲存', localDisclosure: '本機儲存：匯入文件原件、飛書正文快照、證據和筆記留在此裝置；解析請求會經過 APEX，飛書授權令牌由 APEX 加密保管。',
    cloudDisclosure: '雲端儲存：匯入文件原件或飛書正文快照，以及證據和筆記保存在目前帳號下，可跨裝置回看。飛書授權令牌由 APEX 加密保管。',
    cloudUnavailable: '雲端資料儲存尚未設定，請聯絡平台管理員。',
    empty: '尚無資料。匯入 PDF、Word、Excel 或文字文件開始。', processing: '正在解析原文…', ready: '可提問', failed: '解析失敗',
    retry: '重試解析', chooseAgain: '重新選擇文件', open: '開啟原文件', remove: '刪除資料',
    question: '針對目前資料提問', ask: '尋找證據', noEvidence: '這份資料中未找到相關原文證據。', excerpts: '匹配的原文片段',
    note: '儲存筆記', notePlaceholder: '記錄你的發現', notes: '筆記', evidence: '原文證據', source: '資料記錄',
    noSourceText: '尚未取得可讀取的正文。', select: '選擇一份資料查看原文。', deleteNote: '刪除筆記',
    error: '操作失敗，請重試。', permission: '此連結的正文尚未獲授權讀取，無法產生問答。', page: '第 {n} 頁', paragraph: '第 {n} 段', sheet: '{sheet} · {cell}',
    anchorNote: '記到此處', selectedAnchor: '目前引用', citation: '查看出處', unsupportedLink: '目前無法直接讀取此連結，請下載文件後匯入。'
  },
  en: {
    title: 'Immersive analysis', description: 'Import a document, ask against its original text, and keep notes.', import: 'Import document',
    link: 'Paste a source link', linkHint: 'Feishu documents require your authorization and read access.', openLink: 'Open original site', importLink: 'Read link', authorize: 'Authorize Feishu', authorizing: 'Waiting for Feishu authorization…', authorized: 'Authorized. You can read the link.',
    local: 'Saved locally', cloud: 'Saved in cloud', localDisclosure: 'Local save: imported files, Feishu text snapshots, evidence, and notes stay on this device. Parsing passes through APEX; Feishu authorization tokens are encrypted on APEX.',
    cloudDisclosure: 'Cloud save: imported files or Feishu text snapshots, evidence, and notes are stored under your account across devices. Feishu authorization tokens are encrypted on APEX.',
    cloudUnavailable: 'Cloud document storage is not configured. Contact the platform administrator.',
    empty: 'No sources yet. Import a PDF, Word, Excel, or text file.', processing: 'Reading original text…', ready: 'Ready for questions', failed: 'Parsing failed',
    retry: 'Retry parsing', chooseAgain: 'Choose file again', open: 'Open original file', remove: 'Delete source',
    question: 'Ask about this source', ask: 'Find evidence', noEvidence: 'No matching original text was found in this source.', excerpts: 'Matching original passages',
    note: 'Save note', notePlaceholder: 'Record your finding', notes: 'Notes', evidence: 'Original evidence', source: 'Source history',
    noSourceText: 'No readable body has been obtained.', select: 'Select a source to inspect its text.', deleteNote: 'Delete note',
    error: 'The action failed. Try again.', permission: 'The body of this link has not been authorized for reading. Questions are unavailable.', page: 'Page {n}', paragraph: 'Paragraph {n}', sheet: '{sheet} · {cell}',
    anchorNote: 'Note this passage', selectedAnchor: 'Current citation', citation: 'Jump to source', unsupportedLink: 'Direct reading is unavailable for this link. Download the document and import it.'
  },
  ja: {
    title: '資料分析', description: '原文の根拠を確認しながら質問し、メモを残せます。', import: '文書を読み込む',
    link: '資料リンクを貼り付け', linkHint: 'Feishu 文書には本人の認証と閲覧権限が必要です。', openLink: '元サイトを開く', importLink: 'リンクを読む', authorize: 'Feishu を認証', authorizing: 'Feishu の認証を待機中…', authorized: '認証済み。リンクを読めます。',
    local: 'ローカル保存', cloud: 'クラウド保存', localDisclosure: 'ローカル保存：読み込んだファイル、Feishu の本文、根拠、メモはこの端末に保存されます。解析は APEX を経由し、Feishu 認証トークンは APEX で暗号化して保管します。',
    cloudDisclosure: 'クラウド保存：ファイルまたは Feishu の本文、根拠、メモをアカウントに保存します。Feishu 認証トークンは APEX で暗号化して保管します。',
    cloudUnavailable: 'クラウド保存が設定されていません。管理者に連絡してください。',
    empty: '資料はまだありません。PDF、Word、Excel、テキストを読み込んでください。', processing: '原文を解析中…', ready: '質問できます', failed: '解析に失敗',
    retry: '解析を再試行', chooseAgain: 'ファイルを選び直す', open: '原本を開く', remove: '資料を削除',
    question: 'この資料について質問', ask: '根拠を探す', noEvidence: '一致する原文は見つかりませんでした。', excerpts: '一致した原文',
    note: 'メモを保存', notePlaceholder: '発見を記録', notes: 'メモ', evidence: '原文の根拠', source: '資料履歴',
    noSourceText: '読める本文がありません。', select: '資料を選択してください。', deleteNote: 'メモを削除',
    error: '失敗しました。再試行してください。', permission: 'このリンクの本文を読む権限がないため、質問できません。', page: '{n} ページ', paragraph: '{n} 段落', sheet: '{sheet} · {cell}',
    anchorNote: 'ここにメモ', selectedAnchor: '選択中の引用', citation: '出典へ移動', unsupportedLink: 'このリンクは直接読み込めません。文書をダウンロードしてから読み込んでください。'
  },
  ar: {
    title: 'تحليل المستندات', description: 'اطرح أسئلة مستندة إلى النص الأصلي واحفظ ملاحظاتك.', import: 'استيراد مستند',
    link: 'ألصق رابط المصدر', linkHint: 'تتطلب مستندات Feishu موافقتك وصلاحية القراءة.', openLink: 'فتح الموقع الأصلي', importLink: 'قراءة الرابط', authorize: 'تفويض Feishu', authorizing: 'بانتظار تفويض Feishu…', authorized: 'تم التفويض؛ يمكنك قراءة الرابط.',
    local: 'حفظ محلي', cloud: 'حفظ سحابي', localDisclosure: 'الحفظ المحلي: تبقى الملفات المستوردة ونسخة نص Feishu والأدلة والملاحظات على هذا الجهاز. تمر القراءة عبر APEX، وتُحفظ رموز تفويض Feishu مشفرة لدى APEX.',
    cloudDisclosure: 'الحفظ السحابي: تُخزن الملفات أو نسخة نص Feishu والأدلة والملاحظات ضمن حسابك عبر الأجهزة. تُحفظ رموز تفويض Feishu مشفرة لدى APEX.',
    cloudUnavailable: 'لم يتم إعداد التخزين السحابي. تواصل مع مسؤول المنصة.',
    empty: 'لا توجد مصادر بعد. استورد ملف PDF أو Word أو Excel أو نصًا.', processing: 'جارٍ قراءة النص الأصلي…', ready: 'جاهز للأسئلة', failed: 'فشل التحليل',
    retry: 'إعادة التحليل', chooseAgain: 'اختر ملفًا مجددًا', open: 'فتح الملف الأصلي', remove: 'حذف المصدر',
    question: 'اسأل عن هذا المصدر', ask: 'البحث عن أدلة', noEvidence: 'لم يُعثر على نص أصلي مطابق في هذا المصدر.', excerpts: 'مقاطع من النص الأصلي',
    note: 'حفظ ملاحظة', notePlaceholder: 'سجل ما وجدته', notes: 'ملاحظات', evidence: 'الأدلة الأصلية', source: 'سجل المصادر',
    noSourceText: 'لم يُحصل على نص قابل للقراءة.', select: 'اختر مصدرًا لقراءة النص.', deleteNote: 'حذف الملاحظة',
    error: 'فشلت العملية. حاول مجددًا.', permission: 'لم يُمنح إذن قراءة محتوى هذا الرابط، فلا يمكن طرح الأسئلة.', page: 'صفحة {n}', paragraph: 'فقرة {n}', sheet: '{sheet} · {cell}',
    anchorNote: 'ملاحظة لهذا المقطع', selectedAnchor: 'المرجع الحالي', citation: 'انتقل إلى المصدر', unsupportedLink: 'لا يمكن قراءة هذا الرابط مباشرةً. نزّل المستند ثم استورده.'
  }
} as const

function locationLabel(location: Record<string, number | string>, copy: { page: string; paragraph: string; sheet: string }): string {
  if (location.page) {return copy.page.replace('{n}', String(location.page))}

  if (location.sheet) {return copy.sheet.replace('{sheet}', String(location.sheet)).replace('{cell}', String(location.cell))}

  return copy.paragraph.replace('{n}', String(location.paragraph || 1))
}

function bridge(): AnalysisDocumentsBridge | null {
  return window.hermesDesktop?.analysisDocuments ?? null
}

function isHttpsUrl(value: string): boolean {
  try {return new URL(value).protocol === 'https:'} catch {return false}
}

function isFeishuUrl(value: string): boolean {
  if (!isHttpsUrl(value)) {return false}

  const host = new URL(value).hostname.toLowerCase()

  return host === 'feishu.cn' || host.endsWith('.feishu.cn') || host === 'larksuite.com' || host.endsWith('.larksuite.com')
}

function humanError(code: string, copy: { cloudUnavailable: string; empty: string; error: string; failed: string; noSourceText: string; permission: string }): string {
  if (['no_readable_text', 'empty_file'].includes(code)) {return copy.noSourceText}

  if (['analysis_cloud_storage_unavailable', 'cloud_upload_failed', 'download_unavailable'].includes(code)) {return copy.cloudUnavailable}

  if (['permission_denied', 'analysis_cloud_storage_disabled', 'feishu_permission_denied', 'feishu_authorization_required', 'feishu_identity_mismatch', 'feishu_binding_required', 'feishu_scope_unavailable'].includes(code)) {return copy.permission}

  if (code === 'unsupported_format') {return copy.empty}

  if (code === 'parse_failed') {return copy.failed}

  return copy.error
}

export function AnalysisView() {
  const { locale } = useI18n()
  const c = COPY[locale]
  const [policy, setPolicy] = useState<{ mode: 'cloud' | 'local'; cloud_storage_configured: boolean } | null>(null)
  const [items, setItems] = useState<AnalysisDocument[]>([])
  const [selected, setSelected] = useState<AnalysisDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [authFlow, setAuthFlow] = useState<{ id: string; interval: number } | null>(null)
  const [feishuAuthorized, setFeishuAuthorized] = useState(false)
  const [question, setQuestion] = useState('')
  const [note, setNote] = useState('')
  const [anchorId, setAnchorId] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    const result = await bridge()?.list()

    if (result?.ok) {
      setItems(result.items ?? [])

      if (result.cloudUnavailable) {setError(c.error)}
    }
    else {setError(result?.code ?? c.error)}
  }, [c.error])

  const openDocument = useCallback(async (id: string) => {
    const result = await bridge()?.get(id)

    if (result?.ok && result.item) {setSelected(result.item)}
    else {setError(result?.code ?? c.error)}
  }, [c.error])

  useEffect(() => {
    void bridge()?.policy().then(result => {
      if (result.ok && result.policy) {setPolicy(result.policy)}
      else {setError(result.code ?? c.error)}
    })
    void refreshList()
  }, [c.error, refreshList])

  useEffect(() => {
    if (selected?.status !== 'processing') {return}

    const timer = window.setInterval(() => {
      void openDocument(selected.id)
      void refreshList()
    }, 2000)

    return () => window.clearInterval(timer)
  }, [selected?.id, selected?.status, openDocument, refreshList])

  useEffect(() => {
    if (!authFlow) {return}
    const timer = window.setTimeout(() => {
      void bridge()?.pollFeishu(authFlow.id).then(result => {
        if (!result?.ok) {setAuthFlow(null); setError(result?.code ?? c.error);

 return }
        if (result.status === 'authorized') {setAuthFlow(null); setFeishuAuthorized(true);

 return }
        if (result.status !== 'pending') {setAuthFlow(null); setError('feishu_authorization_required');

 return }
        setAuthFlow({ ...authFlow, interval: result.interval ?? authFlow.interval })
      })
    }, authFlow.interval * 1000)

    return () => window.clearTimeout(timer)
  }, [authFlow, c.error])

  const perform = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')

    try { await action() } catch { setError(c.error) } finally { setBusy(false) }
  }

  const jump = (id: string) => document.getElementById(`analysis-anchor-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  const answer = (item: AnalysisQuestion) => (
    <article className="rounded-xl border border-(--ui-border) p-4" key={item.id}>
      <h4 className="font-medium">{item.question}</h4>
      <p className="mt-2 whitespace-pre-wrap text-sm text-(--ui-text-secondary)">{item.answer_type === 'no_evidence' ? c.noEvidence : item.answer}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {item.citations.map(citation => (
          <button className="rounded-lg border px-2 py-1 text-xs" key={citation.anchor_id} onClick={() => jump(citation.anchor_id)} type="button">
            {c.citation} · {locationLabel(citation.location, c)}
          </button>
        ))}
      </div>
    </article>
  )

  return <section className="apex-business-surface apex-business-page apex-primary-page overflow-y-auto">
    <div className="apex-primary-page-column space-y-5 pb-10">
      <BusinessPageHeader description={c.description} eyebrow={c.source} icon="book" title={c.title} />
      <div className="rounded-xl border border-(--ui-border) p-4 text-sm">
        <div className="font-medium">{policy ? policy.mode === 'cloud' ? c.cloud : c.local : c.error}</div>
        {policy && <p className="mt-1 text-(--ui-text-secondary)">{policy.mode === 'cloud' ? c.cloudDisclosure : c.localDisclosure}</p>}
        {policy?.mode === 'cloud' && !policy.cloud_storage_configured && <p className="mt-2 text-destructive">{c.cloudUnavailable}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)} onClick={() => void perform(async () => {
          const result = await bridge()?.importFile()

          if (result?.code === 'cancelled') {return}

          if (!result?.ok || !result.item) { setError(result?.code ?? c.error);

 return }

          await refreshList()
          await openDocument(result.item.id)
        })} type="button">{c.import}</button>
        <input aria-label={c.link} className="min-w-52 flex-1 rounded-lg border bg-transparent px-3 py-2" onChange={event => setLink(event.target.value)} placeholder={c.link} type="url" value={link} />
        {isFeishuUrl(link) && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void perform(async () => {
          const result = await bridge()?.importLink(link.trim())

          if (!result?.ok || !result.item) {setError(result?.code ?? c.error);

 return }

          setLink(''); await refreshList(); await openDocument(result.item.id)
        })} type="button">{c.importLink}</button>}
        {isFeishuUrl(link) && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !!authFlow} onClick={() => void perform(async () => {
          const result = await bridge()?.authorizeFeishu()

          if (!result?.ok || !result.flow_id) {setError(result?.code ?? c.error);

 return }

          setAuthFlow({ id: result.flow_id, interval: result.interval ?? 5 }); setFeishuAuthorized(false)
        })} type="button">{c.authorize}</button>}
        {isHttpsUrl(link) && <button className="rounded-lg border px-3 py-2" onClick={() => void window.hermesDesktop.openExternal(link)} type="button">{c.openLink}</button>}
      </div>
      {link && <p className="text-sm text-(--ui-text-secondary)">{isFeishuUrl(link) ? authFlow ? c.authorizing : feishuAuthorized ? c.authorized : c.linkHint : c.unsupportedLink}</p>}
      {error && <p className="text-sm text-destructive" role="alert">{humanError(error, c)}</p>}
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="space-y-2">
          <h3 className="font-medium">{c.source}</h3>
          {items.length === 0 && <p className="text-sm text-(--ui-text-secondary)">{c.empty}</p>}
          {items.map(item => <button className={`block w-full rounded-xl border p-3 text-left ${selected?.id === item.id ? 'bg-(--ui-row-active-background)' : ''}`} key={item.id} onClick={() => void openDocument(item.id)} type="button">
            <span className="block truncate font-medium">{item.filename}</span>
            <span className="text-xs text-(--ui-text-secondary)">{item.storageMode === 'cloud' ? c.cloud : c.local} · {item.status === 'ready' ? c.ready : item.status === 'processing' ? c.processing : c.failed}</span>
          </button>)}
        </aside>
        <main className="min-w-0 space-y-5">
          {!selected && <p className="rounded-xl border p-6 text-sm text-(--ui-text-secondary)">{c.select}</p>}
          {selected && <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <div><h3 className="font-semibold">{selected.filename}</h3><p className="text-xs text-(--ui-text-secondary)">{selected.status === 'ready' ? c.ready : selected.status === 'processing' ? c.processing : humanError(selected.error_code ?? '', c)}</p></div>
              <div className="flex gap-2">
                <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void bridge()?.openSource(selected.id)} type="button">{c.open}</button>
                {selected.status === 'failed' && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void perform(async () => {
                  const result = await bridge()?.retry(selected.id)

                  if (!result?.ok) { setError(result?.code ?? c.error);

 return }

                  await openDocument(selected.id)
                })} type="button">{selected.storageMode === 'local' ? c.chooseAgain : c.retry}</button>}
                <button className="rounded-lg border px-3 py-2 text-sm text-destructive" onClick={() => void perform(async () => {
                  const result = await bridge()?.delete(selected.id)

                  if (!result?.ok) { setError(result?.code ?? c.error);

 return }

                  setSelected(null)
                  await refreshList()
                })} type="button">{c.remove}</button>
              </div>
            </div>
            {selected.status === 'ready' && <>
              <section className="space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">{c.question}</h3>
                <div className="flex gap-2"><input aria-label={c.question} className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" onChange={event => setQuestion(event.target.value)} value={question} /><button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || question.trim().length < 2} onClick={() => void perform(async () => {
                  const result = await bridge()?.ask(selected.id, question)

                  if (!result?.ok) { setError(result?.code ?? c.error);

 return }

                  setQuestion('')
                  await openDocument(selected.id)
                })} type="button">{c.ask}</button></div>
                {(selected.questions ?? []).map(answer)}
              </section>
              <section className="space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">{c.notes}</h3>
                {anchorId && <p className="text-xs text-(--ui-text-secondary)">{c.selectedAnchor}: {anchorId}</p>}
                <textarea aria-label={c.notePlaceholder} className="min-h-20 w-full rounded-lg border bg-transparent p-3" onChange={event => setNote(event.target.value)} placeholder={c.notePlaceholder} value={note} />
                <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !note.trim()} onClick={() => void perform(async () => {
                  const result = await bridge()?.addNote(selected.id, note, anchorId)

                  if (!result?.ok) { setError(result?.code ?? c.error);

 return }

                  setNote(''); setAnchorId(null); await openDocument(selected.id)
                })} type="button">{c.note}</button>
                {(selected.notes ?? []).map(item => <div className="flex justify-between gap-3 rounded-lg border p-3 text-sm" key={item.id}><div><p>{item.body}</p>{item.anchor_id && <button className="text-xs underline" onClick={() => jump(item.anchor_id!)} type="button">{c.citation} · {item.anchor_id}</button>}</div><button aria-label={c.deleteNote} onClick={() => void perform(async () => { await bridge()?.deleteNote(selected.id, item.id); await openDocument(selected.id) })} type="button">×</button></div>)}
              </section>
              <section className="space-y-3"><h3 className="font-medium">{c.evidence}</h3>
                {(selected.anchors ?? []).length === 0 && <p>{c.noSourceText}</p>}
                {(selected.anchors ?? []).map(anchor => <article className="scroll-mt-5 rounded-xl border p-4" id={`analysis-anchor-${anchor.id}`} key={anchor.id}><div className="flex justify-between gap-3 text-xs text-(--ui-text-secondary)"><span>{locationLabel(anchor.location, c)}</span><button className="underline" onClick={() => { setAnchorId(anchor.id); setNote('') }} type="button">{c.anchorNote}</button></div><p className="mt-2 whitespace-pre-wrap text-sm">{anchor.text}</p></article>)}
              </section>
            </>}
          </>}
        </main>
      </div>
    </div>
  </section>
}
