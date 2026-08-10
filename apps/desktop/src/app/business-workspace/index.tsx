import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'

import { requestComposerFocus, requestComposerInsert } from '../chat/composer/focus'
import { NEW_CHAT_ROUTE, TASKS_ROUTE } from '../routes'

interface WorkflowStarter {
  icon: 'globe' | 'graph' | 'megaphone'
  prompt: string
  title: string
  summary: string
}

export function ProjectsView() {
  const { t } = useI18n()
  const c = t.businessWorkspace.projects
  const navigate = useNavigate()

  return (
    <section className="flex h-full flex-col overflow-y-auto bg-(--ui-chat-surface-background) px-(--page-inset-x) py-8">
      <header className="mx-auto w-full max-w-4xl border-b border-(--ui-stroke-tertiary) pb-5">
        <p className="text-xs font-medium text-primary">{c.eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{c.description}</p>
      </header>
      <div className="mx-auto grid w-full max-w-4xl flex-1 place-items-center py-10">
        <div className="text-center">
          <Codicon className="mx-auto text-primary" name="folder" size="1.75rem" />
          <EmptyState description={c.emptyDescription} title={c.emptyTitle} />
          <div className="flex justify-center gap-2">
            <Button onClick={() => navigate(NEW_CHAT_ROUTE)} size="sm">
              <Codicon name="edit" size="0.875rem" />
              {c.action}
            </Button>
            <Button onClick={() => navigate(TASKS_ROUTE)} size="sm" variant="outline">
              <Codicon name="rocket" size="0.875rem" />
              {c.tasksAction}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

export function WorkflowsView() {
  const { t } = useI18n()
  const c = t.businessWorkspace.workflows
  const navigate = useNavigate()

  const starters: WorkflowStarter[] = [
    { icon: 'globe', title: c.commerce.title, summary: c.commerce.summary, prompt: c.commerce.prompt },
    { icon: 'graph', title: c.insight.title, summary: c.insight.summary, prompt: c.insight.prompt },
    { icon: 'megaphone', title: c.content.title, summary: c.content.summary, prompt: c.content.prompt }
  ]

  const selectStarter = (starter: WorkflowStarter) => {
    navigate(NEW_CHAT_ROUTE)
    window.requestAnimationFrame(() => {
      requestComposerInsert(starter.prompt, { mode: 'block', target: 'main' })
      requestComposerFocus('main')
    })
  }

  return (
    <section className="flex h-full flex-col overflow-y-auto bg-(--ui-chat-surface-background) px-(--page-inset-x) py-8">
      <header className="mx-auto w-full max-w-4xl border-b border-(--ui-stroke-tertiary) pb-5">
        <p className="text-xs font-medium text-primary">{c.eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{c.description}</p>
      </header>
      <div className="mx-auto grid w-full max-w-4xl gap-0 py-5 md:grid-cols-3">
        {starters.map((starter, index) => (
          <button
            className="group flex min-h-40 flex-col items-start border-b border-(--ui-stroke-tertiary) px-4 py-5 text-left hover:bg-(--chrome-action-hover) md:border-r md:border-b-0 first:pl-0 last:border-r-0"
            key={starter.title}
            onClick={() => selectStarter(starter)}
            type="button"
          >
            <span className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
              <Codicon name={starter.icon} size="1rem" />
            </span>
            <strong className="mt-4 text-sm">{starter.title}</strong>
            <span className="mt-1 text-xs leading-5 text-muted-foreground">{starter.summary}</span>
            <span className="mt-auto pt-4 text-xs font-medium text-primary">{c.use} →</span>
          </button>
        ))}
      </div>
    </section>
  )
}
