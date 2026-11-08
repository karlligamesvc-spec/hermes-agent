import { MessagePrimitive } from '@assistant-ui/react'
import type { FC } from 'react'

import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { MessageTimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useCronResultCopy } from '@/i18n/cron-results'
import type { CronResult } from '@/lib/chat-messages/cron-result'

/** Opens the job's own run conversation the way a session reference does: front it if open, else a tab.
 *  Lazy, so the transcript does not pull the profile/REST stack in. */
function openRun(sessionId: string) {
  void import('@/app/open-session').then(({ openSession }) => openSession(sessionId, () => undefined, 'tab'))
}

/** hc-1186: a scheduled job's result that came back into the chat it was made in. The result reads in full;
 *  the button opens the run that produced it. */
export const CronResultCard: FC<{ label: string; result: CronResult }> = ({ label, result }) => {
  const copy = useCronResultCopy()
  const runSessionId = result.runSessionId

  return (
    <MessagePrimitive.Root
      className="flex w-full min-w-0 flex-col self-start py-1"
      data-cron-result={result.failed ? 'failed' : 'ok'}
      data-role="system"
      data-slot="aui_system-message-root"
    >
      <div className="min-w-0 max-w-full rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Codicon name={result.failed ? 'warning' : 'calendar'} size="0.875rem" />
          <span className="min-w-0 truncate font-medium text-foreground/85">{label}</span>
          <MessageTimelineTimestamp />
        </div>
        {result.text ? (
          <div className="mt-1.5 min-w-0 max-w-full wrap-anywhere" data-cron-result-text="">
            <MarkdownTextContent isRunning={false} text={result.text} />
          </div>
        ) : null}
        {runSessionId ? (
          <Button className="mt-2" onClick={() => openRun(runSessionId)} size="sm" type="button" variant="outline">
            {copy.openRun}
          </Button>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  )
}
