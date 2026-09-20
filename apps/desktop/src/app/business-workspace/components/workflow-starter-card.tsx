import { IconChartDots3, IconDownload, IconScan } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import type { BusinessStarterCard } from '../view-model/workflow-starters'

const starterTone = {
  chart: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  download: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  globe: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
  graph: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  megaphone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  scan: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
} as const

const semanticStarterIcons = {
  chart: IconChartDots3,
  download: IconDownload,
  scan: IconScan
} as const

const recommendedStarterAssets: Partial<Record<string, string>> = {
  'market-launch': 'assets/workflow-commerce-minimal.png',
  'geo-brand-audit': 'assets/workflow-geo-minimal.png',
  'content-review': 'assets/workflow-content-minimal.png',
  'video-transcript': 'assets/workflow-video-transcript.png',
  'viral-video-remake': 'assets/workflow-video-remake.png',
  'social-intelligence': 'assets/workflow-social-intelligence.png'
}

const transparentStarterArtwork = new Set(['video-transcript', 'viral-video-remake', 'social-intelligence'])

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

export interface WorkflowStarterCardProps {
  action: string
  onSelect: () => void
  starter: BusinessStarterCard
  variant: 'compact' | 'featured' | 'shelf'
}

/** Phase 1 workflow entry shared by Start and the catalog page. */
export function WorkflowStarterCard({ action, onSelect, starter, variant }: WorkflowStarterCardProps) {
  const featured = variant === 'featured'
  const shelf = variant === 'shelf'
  const artwork = recommendedStarterAssets[starter.id]
  const imageLed = Boolean(artwork) && (featured || shelf)
  const transparentArtwork = transparentStarterArtwork.has(starter.id)
  const SemanticIcon = semanticStarterIcons[starter.icon as keyof typeof semanticStarterIcons]

  return (
    <Button
      aria-label={`${starter.title} · ${action}`}
      className={cn(
        'group h-auto min-w-0 justify-start whitespace-normal text-left',
        featured
          ? 'min-h-28 items-center gap-2 rounded-2xl border border-transparent bg-transparent px-2.5 py-3 shadow-none hover:border-primary/15 hover:bg-(--chrome-action-hover)'
          : shelf
            ? 'min-h-[5.5rem] items-center gap-3.5 rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated)/75 px-4 py-3.5 shadow-xs hover:border-primary/25 hover:bg-(--chrome-action-hover)'
            : 'min-h-20 items-center gap-2 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-3.5 py-3 shadow-sm hover:border-primary/30 hover:bg-(--chrome-action-hover)'
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
          className={cn(
            'shrink-0',
            transparentArtwork
              ? 'size-16 scale-[1.45] object-contain dark:invert'
              : 'size-[4.75rem] rounded-[1.125rem] object-cover shadow-xs'
          )}
          data-workflow-artwork={starter.id}
          height={transparentArtwork ? 64 : 76}
          src={assetPath(artwork!)}
          width={transparentArtwork ? 64 : 76}
        />
      ) : (
        <span
          className={cn(
            'grid shrink-0 place-items-center',
            shelf ? 'size-12 rounded-xl' : 'size-9 rounded-lg',
            starterTone[starter.icon]
          )}
          data-workflow-icon={starter.icon}
        >
          {SemanticIcon ? (
            <SemanticIcon
              aria-hidden="true"
              className={shelf ? 'size-[1.375rem]' : 'size-[1.0625rem]'}
              stroke={1.75}
            />
          ) : (
            <Codicon name={starter.icon} size="1rem" />
          )}
        </span>
      )}
      <span className="min-w-0 flex-1 basis-0" data-workflow-card-copy="">
        <strong
          className={cn(
            'block break-words font-semibold text-foreground',
            shelf ? 'text-[0.9375rem] leading-5' : 'text-[0.875rem] leading-5'
          )}
          data-workflow-card-title=""
        >
          {starter.title}
        </strong>
        <span
          className={cn(
            'mt-1 block break-words text-xs text-muted-foreground',
            shelf ? 'leading-5' : 'leading-[1.15rem]'
          )}
          data-workflow-card-summary=""
        >
          {starter.summary}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center text-primary transition-transform duration-150 group-hover:translate-x-0.5"
        data-workflow-card-action=""
      >
        <Codicon name="arrow-right" size="0.75rem" />
      </span>
    </Button>
  )
}
