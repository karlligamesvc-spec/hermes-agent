import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A full-row / region click target rendered as a real `<button>`: bakes in
 * `type="button"` + a stable `data-slot` and the common row interaction states.
 * Callers still own layout and may override geometry; use `Button` for ordinary
 * compact actions.
 */
function RowButton({ className, type = 'button', ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'rounded-xl text-(--ui-text-primary) transition-[background-color,color,box-shadow,filter,transform] duration-100 hover:bg-(--chrome-action-hover) focus-visible:ring-[0.1875rem] focus-visible:ring-ring/45 active:translate-y-px active:bg-(--ui-control-active-background) active:brightness-[0.98] disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 disabled:transform-none',
        className
      )}
      data-slot="row-button"
      type={type}
      {...props}
    />
  )
}

export { RowButton }
