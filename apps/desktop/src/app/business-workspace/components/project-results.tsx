import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RowButton } from '@/components/ui/row-button'
import { useI18n } from '@/i18n'

import { deliverableDetailRoute, PROJECTS_ROUTE, routeDrawerBackgroundLocation, routeDrawerNavigationState } from '../../routes'
import { listWorkflowDeliverables } from '../api/adapters'
import { workflowDomainBridge } from '../api/bridge'
import { useWorkflowDomainPages } from '../hooks/use-workflow-domain-pages'
import { PROJECT_PROTOTYPE_COPY } from '../project-prototype-copy'

import { WorkflowRefreshNotice } from './workflow-refresh-notice'

export function ProjectResults({ projectId }: { projectId: string }) {
  const { locale, t } = useI18n()
  const copy = PROJECT_PROTOTYPE_COPY[locale]
  const read = useCallback((cursor?: string) => listWorkflowDeliverables({ projectId, limit: 50, ...(cursor ? { cursor } : {}) }), [projectId])
  const { loadMore, state: results } = useWorkflowDomainPages(`project-results:${projectId}`, read, Boolean(workflowDomainBridge()?.listDeliverables))
  const navigate = useNavigate()
  const location = useLocation()

  return <section data-project-results="">
    <WorkflowRefreshNotice state={results} />
    {results.mode === 'ready' ? <>
      {results.items.length ? results.items.map(item => <RowButton
        className="flex w-full items-center justify-between gap-3 py-3 text-start"
        key={item.id}
        onClick={() => navigate(deliverableDetailRoute(item.id), {
          replace: true,
          state: routeDrawerBackgroundLocation(location.state) ? location.state : routeDrawerNavigationState({ hash: '', pathname: PROJECTS_ROUTE, search: '', state: null })
        })}
      >
        <span className="min-w-0">
          <strong className="block truncate text-sm">{item.title}</strong>
          <span className="mt-1 block text-xs text-muted-foreground">{t.businessWorkspace.workflowDomain.deliverables.evidenceCount(item.evidence.length)}</span>
        </span>
        <Badge variant="muted">{t.businessWorkspace.workflowDomain.deliverables.status(item.status)}</Badge>
      </RowButton>) : <p className="py-5 text-sm text-muted-foreground">{copy.noResults}</p>}
      {results.nextCursor && <Button disabled={results.loadingMore || results.refreshing} onClick={() => void loadMore()} size="sm" variant="outline">{copy.moreResults}</Button>}
      {results.moreFailed && <p className="mt-3 text-sm text-destructive" role="alert">{copy.resultsUnavailable}</p>}
    </> : <p className="py-5 text-sm text-muted-foreground">{results.mode === 'loading' ? t.businessWorkspace.workflowDomain.deliverables.loading : copy.resultsUnavailable}</p>}
  </section>
}
