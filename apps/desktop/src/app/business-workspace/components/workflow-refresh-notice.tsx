import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

interface WorkflowRefreshNoticeProps {
  state: { refreshFailed?: boolean; retry?: () => void }
}

export function WorkflowRefreshNotice({ state }: WorkflowRefreshNoticeProps) {
  const { t } = useI18n()

  if (!state.refreshFailed || !state.retry) {return null}

  return <div className="flex flex-wrap items-center gap-3 py-3 text-xs text-destructive" data-workflow-refresh-notice="" role="alert">
    <p>{t.businessWorkspace.projects.refreshFailed}</p>
    <Button onClick={state.retry} size="sm" variant="outline">{t.businessWorkspace.projects.refreshRetry}</Button>
  </div>
}
