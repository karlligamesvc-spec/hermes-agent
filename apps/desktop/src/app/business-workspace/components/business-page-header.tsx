import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'

export interface BusinessPageHeaderProps {
  action?: {
    icon: 'add' | 'play'
    label: string
    onClick: () => void
  }
  description: string
  eyebrow: string
  icon: 'folder' | 'list-unordered'
  title: string
  trailing?: ReactNode
}

/** Shared Phase 1 page heading; it keeps page identity and the primary action aligned. */
export function BusinessPageHeader({ action, description, eyebrow, icon, title, trailing }: BusinessPageHeaderProps) {
  return (
    <header className="flex flex-col gap-5 border-b border-(--ui-stroke-tertiary) pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary shadow-xs">
          <Codicon name={icon} size="1.25rem" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-primary">{eyebrow}</p>
          <h1 className="mt-1 text-[1.75rem] font-semibold leading-tight tracking-[-0.025em]">{title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
          {trailing}
        </div>
      </div>
      {action && (
        <Button className="self-start rounded-lg shadow-sm" onClick={action.onClick} size="lg">
          <Codicon name={action.icon} size="0.875rem" />
          {action.label}
        </Button>
      )}
    </header>
  )
}
