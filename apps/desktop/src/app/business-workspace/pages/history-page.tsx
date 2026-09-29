import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { formatBusinessDayTime } from '@/lib/time'
import { $sessions, $sessionsLoading } from '@/store/session'

import { openSession } from '../../open-session'
import { deliverableDetailRoute, routeDrawerNavigationState, SEARCH_ROUTE, workflowRunRoute } from '../../routes'
import type { WorkflowActivityItem } from '../api/types'
import { BusinessPageHeader } from '../components/business-page-header'
import { WorkflowRefreshNotice } from '../components/workflow-refresh-notice'
import { useWorkflowActivity } from '../hooks/use-workflow-deliverables'

type ActivityFilter = 'all' | 'deliverable' | 'review' | 'run'
type ActivityGroup = 'older' | 'recent' | 'today' | 'yesterday'

const HISTORY_MODES = {
  zh: { sessions: '历史会话', activity: '业务活动', description: '回看这台连接上的真实对话；项目运行与交付记录在业务活动中。', search: '搜索全部会话' },
  'zh-hant': { sessions: '歷史對話', activity: '業務活動', description: '查看此連線上的真實對話；專案執行與交付記錄在業務活動中。', search: '搜尋全部對話' },
  en: { sessions: 'Conversations', activity: 'Business activity', description: 'Reopen real conversations on this connection. Project runs and results are in Business activity.', search: 'Search all conversations' },
  ja: { sessions: '会話履歴', activity: '業務アクティビティ', description: 'この接続の実際の会話を開きます。プロジェクトの実行と成果は業務アクティビティにあります。', search: 'すべての会話を検索' },
  ar: { sessions: 'المحادثات', activity: 'نشاط العمل', description: 'أعد فتح المحادثات الفعلية في هذا الاتصال. توجد عمليات المشاريع ونتائجها في نشاط العمل.', search: 'البحث في كل المحادثات' }
} as const

function startOfLocalDay(value: Date): number {
  // Compare calendar dates rather than elapsed milliseconds between local
  // midnights. A spring-forward day is only 23 hours and would otherwise make
  // yesterday look like today; a fall-back day is 25 hours and can similarly
  // push recent items into the wrong group.
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())
}

export function activityGroup(happenedAt: string, now: Date): ActivityGroup {
  const dayDistance = Math.floor((startOfLocalDay(now) - startOfLocalDay(new Date(happenedAt))) / 86_400_000)

  if (dayDistance <= 0) {
    return 'today'
  }

  if (dayDistance === 1) {
    return 'yesterday'
  }

  if (dayDistance <= 7) {
    return 'recent'
  }

  return 'older'
}

function targetRoute(item: WorkflowActivityItem): string {
  return item.target.kind === 'run' ? workflowRunRoute(item.target.id) : deliverableDetailRoute(item.target.id)
}

export function HistoryView() {
  const { locale } = useI18n()
  const [mode, setMode] = useState<'activity' | 'sessions'>('sessions')
  const labels = HISTORY_MODES[locale]

  return (
    <section className="apex-business-surface apex-business-page apex-primary-page" data-history-page="">
      <div className="apex-primary-page-column pt-4">
        <SegmentedControl
          onChange={setMode}
          options={[{ id: 'sessions', label: labels.sessions }, { id: 'activity', label: labels.activity }]}
          value={mode}
        />
      </div>
      {mode === 'sessions' ? <SessionHistoryContent /> : <ActivityHistoryContent />}
    </section>
  )
}

function SessionHistoryContent() {
  const { locale, t } = useI18n()
  const labels = HISTORY_MODES[locale]
  const copy = t.businessWorkspace.projects
  const history = t.businessWorkspace.workflowDomain.history
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const loading = useStore($sessionsLoading)

  const visible = useMemo(
    () => sessions.filter(session => !session.archived).sort((left, right) => right.last_active - left.last_active),
    [sessions]
  )

  return <>
    <div className="apex-primary-page-column">
      <BusinessPageHeader
        action={{ icon: 'search', label: labels.search, onClick: () => navigate(SEARCH_ROUTE) }}
        description={labels.description}
        eyebrow={labels.sessions}
        icon="history"
        title={history.title}
      />
    </div>
    {loading && visible.length === 0 ? (
      <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader className="size-8" label={copy.loadingHistory} type="lemniscate-bloom" />
        <span>{copy.loadingHistory}</span>
      </div>
    ) : visible.length === 0 ? (
      <div className="mx-auto grid min-h-64 w-full max-w-[65.625rem] place-items-center py-10 text-center">
        <EmptyState description={copy.noConversations} title={labels.sessions} />
      </div>
    ) : (
      <div className="mx-auto w-full max-w-[65.625rem] space-y-1 py-5">
        {visible.map(session => (
          <Button
            className="grid min-h-20 w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 text-left"
            key={session.id}
            onClick={() => openSession(session.id, navigate)}
            variant="ghost"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
              <Codicon name="comment-discussion" />
            </span>
            <span className="min-w-0 self-center">
              <strong className="block truncate text-sm font-semibold">{session.title || copy.untitled}</strong>
              <span className="mt-1 block truncate text-xs text-muted-foreground">{session.preview || copy.noPreview}</span>
            </span>
            <span className="flex items-center gap-2 self-center text-xs text-(--ui-text-tertiary)">
              {Number.isFinite(session.last_active) && session.last_active > 0
                ? formatBusinessDayTime(new Date(session.last_active * 1000), locale)
                : null}
              <Codicon name="arrow-right" />
            </span>
          </Button>
        ))}
      </div>
    )}
  </>
}

function ActivityHistoryContent() {
  const { locale, t } = useI18n()
  const copy = t.businessWorkspace.workflowDomain.history
  const deliverableCopy = t.businessWorkspace.workflowDomain.deliverables
  const runCopy = t.businessWorkspace.workflowDomain.run
  const location = useLocation()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const { loadMore, refresh, state } = useWorkflowActivity(filter === 'all' ? undefined : filter)

  const groups = useMemo(() => {
    if (state.mode !== 'ready') {
      return []
    }

    const now = new Date()
    const grouped = new Map<ActivityGroup, WorkflowActivityItem[]>()

    for (const item of state.items) {
      const group = activityGroup(item.happenedAt, now)
      grouped.set(group, [...(grouped.get(group) || []), item])
    }

    return (['today', 'yesterday', 'recent', 'older'] as const)
      .map(group => ({ group, items: grouped.get(group) || [] }))
      .filter(entry => entry.items.length > 0)
  }, [state])

  return (
    <>
      <div className="apex-primary-page-column">
        {state.mode === 'ready' && <WorkflowRefreshNotice state={state} />}
        <BusinessPageHeader
          action={{ icon: 'refresh', label: copy.refresh, onClick: refresh }}
          description={copy.description}
          eyebrow={copy.eyebrow}
          icon="history"
          title={copy.title}
        />
      </div>

      {state.mode === 'loading' ? (
        <div className="mx-auto flex min-h-72 w-full max-w-[65.625rem] items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader className="size-8" label={copy.loading} type="lemniscate-bloom" />
          <span>{copy.loading}</span>
        </div>
      ) : state.mode === 'unavailable' || state.mode === 'failed' ? (
        <div className="mx-auto grid min-h-72 w-full max-w-[65.625rem] place-items-center py-10 text-center">
          <div>
            <Codicon className="mx-auto text-amber-500" name="warning" size="1.75rem" />
            <EmptyState
              description={state.mode === 'unavailable' ? copy.unavailableDescription : copy.loadFailedDescription}
              title={state.mode === 'unavailable' ? copy.unavailableTitle : copy.loadFailedTitle}
            />
            <Button onClick={refresh} size="sm">
              <Codicon name="refresh" />
              {copy.refresh}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-[65.625rem] py-5">
          <div aria-label={copy.filters} className="mb-4" role="group">
            <SegmentedControl
              onChange={setFilter}
              options={[
                { id: 'all', label: copy.all },
                { id: 'run', label: copy.runs },
                { id: 'deliverable', label: copy.deliverables },
                { id: 'review', label: copy.reviews }
              ]}
              value={filter}
            />
          </div>

          {state.items.length === 0 ? (
            <div className="grid min-h-64 place-items-center text-center">
              <EmptyState
                description={filter === 'all' ? copy.emptyDescription : copy.filterEmpty}
                title={copy.emptyTitle}
              />
            </div>
          ) : (
            <div className="space-y-6">
              {groups.map(({ group, items }) => (
                <section key={group}>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                    {copy[group]}
                  </h2>
                  <div className="space-y-1">
                    {items.map(item => {
                      const openerKey = `activity:${item.id}`

                      return (
                        <Button
                          className="grid min-h-20 w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 text-left"
                          data-route-drawer-return-focus={openerKey}
                          key={item.id}
                          onClick={() =>
                            navigate(targetRoute(item), {
                              state: routeDrawerNavigationState(location, openerKey)
                            })
                          }
                          variant="ghost"
                        >
                          <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                            <Codicon
                              name={
                                item.kind === 'run' ? 'run-all' : item.kind === 'review' ? 'comment-discussion' : 'file'
                              }
                            />
                          </span>
                          <span className="min-w-0 self-center">
                            <span className="flex flex-wrap items-center gap-2">
                              <strong className="truncate text-sm font-semibold">{item.title}</strong>
                              <Badge variant="outline">{copy.kind(item.kind)}</Badge>
                              <Badge variant="muted">
                                {item.kind === 'run'
                                  ? runCopy.status(item.status)
                                  : deliverableCopy.status(item.status)}
                              </Badge>
                            </span>
                            <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                              {item.summary || copy.noSummary}
                            </span>
                          </span>
                          <span className="flex items-center gap-2 self-center text-xs text-(--ui-text-tertiary)">
                            <span>{formatBusinessDayTime(new Date(item.happenedAt), locale)}</span>
                            <Codicon name="arrow-right" />
                          </span>
                        </Button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          {state.nextCursor && (
            <div className="flex justify-center py-5">
              <Button disabled={state.loadingMore} onClick={() => void loadMore()} size="sm" variant="outline">
                {state.loadingMore ? copy.loadingMore : copy.loadMore}
              </Button>
            </div>
          )}
          {state.moreFailed && (
            <p className="pb-4 text-center text-xs text-destructive">{copy.loadFailedDescription}</p>
          )}
        </div>
      )}
    </>
  )
}
