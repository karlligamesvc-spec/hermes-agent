import { useNavigate } from 'react-router'

import { useI18n } from '@/i18n'

import { ImEntryView } from '../../im-entry'
import { deliverableDetailRoute, DELIVERABLES_ROUTE, HISTORY_ROUTE, projectDetailRoute, PROJECTS_ROUTE, workflowRunRoute } from '../../routes'
import { BusinessPageHeader } from '../components/business-page-header'
import { BusinessLimitation, BusinessSection } from '../components/business-section'
import { useWorkflowDeliverables } from '../hooks/use-workflow-deliverables'
import { useWorkflowProjects } from '../hooks/use-workflow-domain-lists'

const COPY = {
  zh: { title: '连接助手', description: '查看消息渠道、最近项目运行、待处理事项和交付成果。对话仍从“开始”进入。', connections: '消息渠道', current: '当前项目运行', attention: '需要处理', recent: '最近交付', projects: '查看项目', deliverables: '查看交付物', history: '查看会话历史', emptyCurrent: '最近项目中没有正在运行的任务。', emptyAttention: '最近项目中没有待处理事项。', emptyRecent: '还没有项目交付物。', loading: '正在读取账号数据…', unavailable: '暂时无法读取账号数据，请从对应页面重试。', partial: '部分项目没有运行摘要，请到项目页查看。', queued: '排队中', running: '执行中', review: '待验收', failed: '运行失败' },
  'zh-hant': { title: '連接助手', description: '查看訊息渠道、近期專案執行、待處理事項和交付成果。對話仍從「開始」進入。', connections: '訊息渠道', current: '目前專案執行', attention: '需要處理', recent: '最近交付', projects: '查看專案', deliverables: '查看交付物', history: '查看對話歷史', emptyCurrent: '近期專案中沒有正在執行的任務。', emptyAttention: '近期專案中沒有待處理事項。', emptyRecent: '尚無專案交付物。', loading: '正在讀取帳號資料…', unavailable: '暫時無法讀取帳號資料，請到對應頁面重試。', partial: '部分專案沒有執行摘要，請到專案頁查看。', queued: '排隊中', running: '執行中', review: '待驗收', failed: '執行失敗' },
  en: { title: 'Connected assistant', description: 'See messaging channels, recent project runs, items needing attention, and delivered results. Start a conversation from Start.', connections: 'Messaging channels', current: 'Current project runs', attention: 'Needs attention', recent: 'Recent deliverables', projects: 'View projects', deliverables: 'View deliverables', history: 'View conversation history', emptyCurrent: 'No active runs among recent projects.', emptyAttention: 'No items need attention among recent projects.', emptyRecent: 'No project deliverables yet.', loading: 'Loading account data…', unavailable: 'Account data is unavailable. Retry from the corresponding page.', partial: 'Some projects have no run summary. Open Projects for details.', queued: 'Queued', running: 'Running', review: 'Review needed', failed: 'Run failed' },
  ja: { title: 'アシスタント接続', description: 'チャネル、最近のプロジェクト実行、要対応項目、成果を確認できます。会話は「開始」から開きます。', connections: 'メッセージチャネル', current: '現在のプロジェクト実行', attention: '要対応', recent: '最近の成果', projects: 'プロジェクトを見る', deliverables: '成果を見る', history: '会話履歴を見る', emptyCurrent: '最近のプロジェクトに実行中のタスクはありません。', emptyAttention: '最近のプロジェクトに要対応項目はありません。', emptyRecent: 'プロジェクトの成果はまだありません。', loading: 'アカウント情報を読み込み中…', unavailable: 'アカウント情報を取得できません。該当ページから再試行してください。', partial: '実行概要のないプロジェクトがあります。プロジェクトページで確認してください。', queued: '待機中', running: '実行中', review: '確認待ち', failed: '実行失敗' },
  ar: { title: 'المساعد المتصل', description: 'راجع قنوات الرسائل وعمليات المشاريع الحديثة وما يحتاج إلى متابعة والنتائج المسلمة. ابدأ المحادثة من «البدء».', connections: 'قنوات الرسائل', current: 'عمليات المشاريع الحالية', attention: 'تحتاج إلى متابعة', recent: 'آخر النتائج المسلمة', projects: 'عرض المشاريع', deliverables: 'عرض النتائج', history: 'عرض سجل المحادثات', emptyCurrent: 'لا توجد عمليات نشطة ضمن المشاريع الحديثة.', emptyAttention: 'لا توجد عناصر تحتاج إلى متابعة ضمن المشاريع الحديثة.', emptyRecent: 'لا توجد نتائج مشاريع بعد.', loading: 'جارٍ تحميل بيانات الحساب…', unavailable: 'بيانات الحساب غير متاحة. أعد المحاولة من الصفحة المعنية.', partial: 'بعض المشاريع بلا ملخص تشغيل. راجع صفحة المشاريع.', queued: 'في الانتظار', running: 'قيد التشغيل', review: 'بانتظار المراجعة', failed: 'فشل التشغيل' }
} as const

export function AssistantWorkspaceView() {
  const { locale } = useI18n()
  const c = COPY[locale]
  const navigate = useNavigate()
  const projects = useWorkflowProjects()
  const { state: deliverables } = useWorkflowDeliverables()
  const projectItems = projects.mode === 'ready' ? projects.items : []
  const running = projectItems.flatMap(item => {
    const runId = item.summary?.currentRunId

    return runId && ['queued', 'running'].includes(item.summary?.currentRunStatus ?? '') ? [{ item, runId }] : []
  }).slice(0, 3)
  const needsAttention = projectItems.filter(item => item.summary?.attention === 'failed' || item.summary?.attention === 'review').slice(0, 3)
  const incompleteSummary = projectItems.some(item => !item.summary)
  const recent = deliverables.mode === 'ready' ? [...deliverables.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3) : []
  const projectFallback = projects.mode === 'loading' ? c.loading : projects.mode === 'ready' ? null : c.unavailable
  const deliverableFallback = deliverables.mode === 'loading' ? c.loading : deliverables.mode === 'ready' ? null : c.unavailable

  return (
    <section className="apex-business-surface apex-business-page apex-primary-page overflow-y-auto" data-assistant-workspace="">
      <div className="apex-primary-page-column space-y-6 pb-10">
        <BusinessPageHeader description={c.description} eyebrow={c.title} icon="organization" title={c.title} />
        <BusinessSection action={c.history} onAction={() => navigate(HISTORY_ROUTE)} title={c.connections}>
          <ImEntryView className="w-full" embedded />
        </BusinessSection>
        <BusinessSection action={c.projects} onAction={() => navigate(PROJECTS_ROUTE)} title={c.current}>
          {projectFallback ? <BusinessLimitation text={projectFallback} /> : running.length ? running.map(({ item, runId }) => (
            <button className="flex w-full items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) py-3 text-left text-sm" key={item.id} onClick={() => navigate(workflowRunRoute(runId))} type="button">
              <span className="truncate font-medium">{item.name}</span>
              <span className="shrink-0 text-(--ui-text-tertiary)">{item.summary?.currentRunStatus === 'queued' ? c.queued : c.running}</span>
            </button>
          )) : <BusinessLimitation text={c.emptyCurrent} />}
          {!projectFallback && incompleteSummary && <BusinessLimitation text={c.partial} />}
        </BusinessSection>
        <BusinessSection action={c.projects} onAction={() => navigate(PROJECTS_ROUTE)} title={c.attention}>
          {projectFallback ? <BusinessLimitation text={projectFallback} /> : needsAttention.length ? needsAttention.map(item => (
            <button className="flex w-full items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) py-3 text-left text-sm" key={item.id} onClick={() => navigate(projectDetailRoute(item.id))} type="button">
              <span className="truncate font-medium">{item.name}</span>
              <span className="shrink-0 text-(--ui-text-tertiary)">{item.summary?.attention === 'review' ? c.review : c.failed}</span>
            </button>
          )) : <BusinessLimitation text={c.emptyAttention} />}
        </BusinessSection>
        <BusinessSection action={c.deliverables} onAction={() => navigate(DELIVERABLES_ROUTE)} title={c.recent}>
          {deliverableFallback ? <BusinessLimitation text={deliverableFallback} /> : recent.length ? recent.map(item => (
            <button className="flex w-full items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) py-3 text-left text-sm" key={item.id} onClick={() => navigate(deliverableDetailRoute(item.id))} type="button">
              <span className="truncate font-medium">{item.title}</span>
              <span className="shrink-0 text-(--ui-text-tertiary)">{item.updatedAt.slice(0, 10)}</span>
            </button>
          )) : <BusinessLimitation text={c.emptyRecent} />}
        </BusinessSection>
      </div>
    </section>
  )
}
