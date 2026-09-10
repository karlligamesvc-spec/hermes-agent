import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

const starterTone = {
  globe: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
  graph: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  megaphone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
} as const

const recommendedStarterAssets: Partial<Record<BusinessWorkflowStarter['id'], string>> = {
  'market-launch': 'assets/workflow-commerce-minimal.png',
  'geo-brand-audit': 'assets/workflow-geo-minimal.png',
  'content-review': 'assets/workflow-content-minimal.png'
}

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

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
  const artwork = recommendedStarterAssets[starter.id]
  const imageLed = Boolean(artwork) && (featured || shelf)

  return (
    <Button
      aria-label={`${starter.title} · ${action}`}
      className={cn(
        'group h-auto min-w-0 justify-start gap-2 whitespace-normal text-left',
        featured
          ? 'min-h-28 items-center rounded-2xl border border-transparent bg-transparent px-2.5 py-3 shadow-none hover:border-primary/15 hover:bg-(--chrome-action-hover)'
          : shelf
            ? 'min-h-24 items-center rounded-2xl border border-transparent bg-transparent px-2.5 py-3 shadow-none hover:border-primary/15 hover:bg-(--chrome-action-hover)'
            : 'min-h-20 items-center rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-3.5 py-3 shadow-sm hover:border-primary/30 hover:bg-(--chrome-action-hover)'
      )}
      data-workflow-starter={variant}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      {imageLed ? (
        <img
          alt=""
          aria-hidden="true"
          className="size-[4.75rem] shrink-0 rounded-[1.125rem] object-cover shadow-xs"
          data-workflow-artwork={starter.id}
          height={76}
          src={assetPath(artwork!)}
          width={76}
        />
      ) : (
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', starterTone[starter.icon])}>
          <Codicon name={starter.icon} size="1rem" />
        </span>
      )}
      <span className="min-w-0 flex-1 basis-0" data-workflow-card-copy="">
        <strong
          className="block break-words text-[0.875rem] font-semibold leading-5 text-foreground"
          data-workflow-card-title=""
        >
          {starter.title}
        </strong>
        <span
          className="mt-1 block break-words text-xs leading-[1.15rem] text-muted-foreground"
          data-workflow-card-summary=""
        >
          {starter.summary}
        </span>
      </span>
      <span aria-hidden="true" className="flex shrink-0 items-center text-primary" data-workflow-card-action="">
        <Codicon name="arrow-right" size="0.75rem" />
      </span>
    </Button>
  )
}
