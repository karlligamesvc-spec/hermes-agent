import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ErrorBanner } from '@/components/ui/error-state'
import { type CronJobHistory, getCronJobHistory } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { $changeEventsAvailable, $cronChangeTick } from '@/store/live-sync'

import { PanelSectionLabel } from '../overlays/panel'

function formatRunTime(seconds?: null | number): string {
  if (!seconds) {
    return '—'
  }

  const date = new Date(seconds * 1000)

  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString()
}

// Runs are produced by the background scheduler tick. cron.changed /
// sessions.changed broadcasts re-load immediately on event-capable backends
// (the tick dep below), so the poll drops to a slow backstop there; older
// backends keep the legacy cadence.
const RUNS_POLL_INTERVAL_MS = 8000
const RUNS_BACKSTOP_INTERVAL_MS = 60_000

export function CronJobRuns({
  c,
  jobId,
  onOpenSession
}: {
  c: Translations['cron']
  jobId: string
  onOpenSession?: (sessionId: string) => void
}) {
  const [history, setHistory] = useState<null | CronJobHistory>(null)
  const runs = history?.runs ?? null
  const executions = history?.executions
  const [loadError, setLoadError] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const { t } = useI18n()
  const changeEventsAvailable = useStore($changeEventsAvailable)
  const cronChangeTick = useStore($cronChangeTick)

  useEffect(() => {
    let cancelled = false
    let requestSequence = 0

    const load = () => {
      const request = ++requestSequence

      return getCronJobHistory(jobId)
        .then(result => {
          if (!cancelled && request === requestSequence) {
            setHistory(result)
            setLoadError(false)
          }
        })
        .catch(() => {
          if (!cancelled && request === requestSequence) {
            setLoadError(true)
          }
        })
    }

    void load()

    const intervalId = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') {
          void load()
        }
      },
      changeEventsAvailable ? RUNS_BACKSTOP_INTERVAL_MS : RUNS_POLL_INTERVAL_MS
    )

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void load()
      }
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // cronChangeTick: a fired run moves jobs.json bookkeeping → reload now.
  }, [changeEventsAvailable, cronChangeTick, jobId, retryTick])

  return (
    <div>
      <PanelSectionLabel className="mb-1.5">
        {c.runHistory}
        {executions?.length ? ` · ${executions.length}` : ''}
      </PanelSectionLabel>
      {executions ? (
        <div className="flex flex-col gap-px" data-cron-executions>
          {executions.map(execution => (
            <div className="flex items-center justify-between gap-3 px-2 py-1 text-xs" data-cron-execution-id={execution.id} key={execution.id}>
              <span>{c.executionStatuses[execution.status]}</span>
              <span className="text-muted-foreground tabular-nums">
                {formatRunTime(Date.parse(execution.started_at ?? execution.claimed_at) / 1000)}
              </span>
            </div>
          ))}
        </div>
      ) : history ? (
        <p className="py-1 text-xs text-muted-foreground">{c.legacyRunHistory}</p>
      ) : null}
      {loadError ? (
        <ErrorBanner className="my-2">
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span>{c.failedLoadRuns}</span>
            <Button onClick={() => setRetryTick(current => current + 1)} size="sm" variant="outline">
              {t.common.retry}
            </Button>
          </span>
        </ErrorBanner>
      ) : null}
      {runs === null && !loadError ? (
        <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
          <Codicon name="loading" size="0.75rem" spinning />
        </div>
      ) : runs?.length === 0 && executions?.length === 0 && !loadError ? (
        <div className="py-1 text-xs text-muted-foreground">{c.noRuns}</div>
      ) : runs && runs.length > 0 ? (
        <div className="flex flex-col gap-px">
          <PanelSectionLabel className="mt-2">{c.runConversations}</PanelSectionLabel>
          {runs.map(run => (
            <button
              className="row-hover flex items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              key={run.id}
              onClick={() => onOpenSession?.(run.id)}
              type="button"
            >
              <span className="truncate text-foreground/85">{run.title?.trim() || run.preview?.trim() || run.id}</span>
              <span className="shrink-0 text-[0.62rem] text-muted-foreground/55 tabular-nums">
                {formatRunTime(run.last_active || run.started_at)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

