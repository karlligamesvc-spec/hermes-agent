import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

const starterTone = {
  globe: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
  graph: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  megaphone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
} as const

export interface WorkflowStarterCardProps {
  action: string
  onSelect: () => void
  starter: BusinessWorkflowStarter
  variant: 'compact' | 'featured' | 'shelf'
}

/** Phase 1 workflow entry shared by Start and the catalog page. */
export function WorkflowStarterCard({ action, onSelect, starter, variant }: WorkflowStarterCardProps) {
  const featured = variant === 'featured'
  const shelf = variant === 'shelf'

  return (
    <Button
      aria-label={`${starter.title} · ${action}`}
      className={cn(
        'group h-auto min-w-0 justify-start whitespace-normal rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) text-left shadow-sm hover:border-primary/30 hover:bg-(--chrome-action-hover)',
        featured
          ? 'min-h-36 flex-col items-start px-4 py-4'
          : shelf
            ? 'min-h-24 items-center px-3.5 py-3.5'
            : 'min-h-20 items-center px-3.5 py-3'
      )}
      data-workflow-starter={variant}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      <span
        className={cn(
          'grid shrink-0 place-items-center rounded-lg',
          featured ? 'size-10' : 'size-9',
          starterTone[starter.icon]
        )}
      >
        <Codicon name={starter.icon} size="1rem" />
      </span>
      <span className={cn('min-w-0 flex-1', featured ? 'mt-3' : 'ml-1')}>
        <strong className="block text-sm font-semibold leading-5 text-foreground">{starter.title}</strong>
        <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{starter.summary}</span>
      </span>
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 text-xs font-medium text-primary',
          featured ? 'mt-auto pt-3' : 'ml-2'
        )}
      >
        <span className={shelf ? 'sr-only' : undefined}>{action}</span>
        <Codicon name="arrow-right" size="0.75rem" />
      </span>
    </Button>
  )
}
