import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface AccountSurfaceHeaderProps {
  description: string
  title: string
  titleId: string
  action?: ReactNode
  className?: string
}

/** Shared hierarchy for the customer account surfaces. The title remains in
 * document flow (rather than floating in the macOS drag strip), so it never
 * collides with traffic lights, the compact Settings selector, or Close. */
export function AccountSurfaceHeader({ action, className, description, title, titleId }: AccountSurfaceHeaderProps) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-start justify-between gap-5 border-b border-(--ui-stroke-secondary) px-6 pb-4 pt-[calc(var(--titlebar-height)+0.875rem)] max-[53rem]:px-4 max-[53rem]:pb-3',
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-(--ui-text-primary)" id={titleId}>
          {title}
        </h1>
        <p className="mt-1 max-w-[42rem] text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {description}
        </p>
      </div>
      {action ? <div className="mr-9 mt-0.5 shrink-0 max-[53rem]:mr-8">{action}</div> : null}
    </header>
  )
}
