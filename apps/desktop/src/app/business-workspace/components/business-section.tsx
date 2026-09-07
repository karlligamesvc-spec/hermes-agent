import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

export interface BusinessSectionProps {
  action: string
  children: ReactNode
  onAction: () => void
  title: string
}

export function BusinessSection({ action, children, onAction, title }: BusinessSectionProps) {
  return (
    <section>
      <header className="flex items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) pb-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button onClick={onAction} size="inline" variant="textStrong">
          {action}
        </Button>
      </header>
      <div>{children}</div>
    </section>
  )
}

export function BusinessLimitation({ text }: { text: string }) {
  return <p className="py-4 text-xs leading-5 text-muted-foreground">{text}</p>
}
