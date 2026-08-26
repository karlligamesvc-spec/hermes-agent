import { useStore } from '@nanostores/react'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { fmtDayTime } from '@/lib/time'
import { $sessions, $sessionsLoading } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { requestComposerFocus, requestComposerInsert } from '../chat/composer/focus'
import { openSession } from '../open-session'
import { PROJECTS_ROUTE, WORKFLOWS_ROUTE } from '../routes'

import { recentConversations } from './workspace-model'

interface StartWorkflow {
  icon: 'globe' | 'graph' | 'megaphone'
  prompt: string
  summary: string
  title: string
}

/**
 * Business-mode zero state for the real chat home.
 *
 * The workflow rows only prefill the existing composer. The recent-work rows
 * are derived from backend sessions and live client state; this surface never
 * creates a project, progress value, platform claim, or deliverable of its own.
 */
export function BusinessStartShelf() {
  const { t } = useI18n()
  const c = t.businessWorkspace
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const sessionsLoading = useStore($sessionsLoading)
  const states = useStore($sessionStates)
  const conversations = useMemo(() => recentConversations(sessions, states, 2), [sessions, states])

  const workflows: StartWorkflow[] = [
    {
      icon: 'globe',
      prompt: c.workflows.commerce.prompt,
      summary: c.workflows.commerce.summary,
      title: c.workflows.commerce.title
    },
    {
      icon: 'graph',
      prompt: c.workflows.insight.prompt,
      summary: c.workflows.insight.summary,
      title: c.workflows.insight.title
    },
    {
      icon: 'megaphone',
      prompt: c.workflows.content.prompt,
      summary: c.workflows.content.summary,
      title: c.workflows.content.title
    }
  ]

  const selectWorkflow = (workflow: StartWorkflow) => {
    requestComposerInsert(workflow.prompt, { mode: 'block', target: 'main' })
    requestComposerFocus('main')
  }

  return (
    <div
      className="pointer-events-auto mx-auto flex w-[min(48rem,100%)] flex-col gap-7 px-4 pb-6 text-left"
      data-business-start-shelf=""
    >
      <section aria-labelledby="business-start-workflows">
        <header className="mb-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.05em] text-(--ui-text-tertiary)">
              {c.workflows.eyebrow}
            </p>
            <h2 className="mt-1 text-sm font-semibold" id="business-start-workflows">
              {c.workflows.title}
            </h2>
          </div>
          <Button onClick={() => navigate(WORKFLOWS_ROUTE)} size="inline" variant="textStrong">
            {c.workflows.title}
          </Button>
        </header>

        <div className="grid grid-cols-1 border-y border-(--ui-stroke-tertiary) sm:grid-cols-3">
          {workflows.map(workflow => (
            <button
              className="group flex min-h-28 items-start gap-3 border-b border-(--ui-stroke-tertiary) px-3 py-4 text-left transition-colors last:border-b-0 hover:bg-(--chrome-action-hover) sm:border-r sm:border-b-0 sm:first:pl-0 sm:last:border-r-0 sm:last:pr-0"
              key={workflow.title}
              onClick={() => selectWorkflow(workflow)}
              type="button"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-(--ui-control-active-background) text-primary">
                <Codicon name={workflow.icon} size="1rem" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-xs leading-5">{workflow.title}</strong>
                <span className="mt-0.5 line-clamp-2 block text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
                  {workflow.summary}
                </span>
                <span className="mt-2 flex items-center gap-1 text-[0.6875rem] font-medium text-primary">
                  {c.workflows.use}
                  <Codicon name="arrow-right" size="0.75rem" />
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="business-start-recent">
        <header className="mb-2 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold" id="business-start-recent">
            {c.projects.recentConversations}
          </h2>
          <Button onClick={() => navigate(PROJECTS_ROUTE)} size="inline" variant="textStrong">
            {c.projects.title}
          </Button>
        </header>

        <div className="border-t border-(--ui-stroke-tertiary)">
          {sessionsLoading && conversations.length === 0 ? (
            <div className="flex min-h-16 items-center gap-3 text-xs text-muted-foreground">
              <Loader className="size-7" label={c.projects.loadingHistory} type="lemniscate-bloom" />
              <span>{c.projects.loadingHistory}</span>
            </div>
          ) : conversations.length > 0 ? (
            conversations.map(conversation => (
              <button
                className="flex w-full items-center gap-3 border-b border-(--ui-stroke-tertiary) py-3 text-left last:border-b-0 hover:bg-(--chrome-action-hover)"
                key={conversation.id}
                onClick={() => openSession(conversation.id, navigate)}
                type="button"
              >
                <span
                  className={
                    conversation.status === 'needs-input'
                      ? 'size-2 shrink-0 rounded-full bg-amber-500'
                      : conversation.status === 'running'
                        ? 'size-2 shrink-0 animate-pulse rounded-full bg-primary'
                        : 'size-2 shrink-0 rounded-full bg-(--ui-text-quaternary)'
                  }
                />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-xs font-medium">
                    {conversation.title || c.projects.untitled}
                  </strong>
                  <span className="mt-0.5 block truncate text-[0.6875rem] text-(--ui-text-tertiary)">
                    {conversation.preview || c.projects.noPreview}
                  </span>
                </span>
                <span className="shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)">
                  {conversation.status === 'needs-input'
                    ? c.projects.needsInput
                    : conversation.status === 'running'
                      ? c.projects.running
                      : fmtDayTime.format(new Date(conversation.lastActive * 1000))}
                </span>
                <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="arrow-right" size="0.75rem" />
              </button>
            ))
          ) : (
            <p className="py-4 text-xs leading-5 text-muted-foreground">{c.projects.noConversations}</p>
          )}
        </div>
      </section>
    </div>
  )
}
