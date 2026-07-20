import type { ReactNode, RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { Loader2, Search } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SearchFieldProps {
  placeholder: string
  value: string
  onChange: (value: string) => void
  containerClassName?: string
  inputClassName?: string
  loading?: boolean
  onClear?: () => void
  inputRef?: RefObject<HTMLInputElement | null>
  trailingAction?: ReactNode
  /**
   * Visual chrome. `underline` (default) is the borderless look used
   * everywhere — no box, an underline appears on focus. `boxed` draws a subtle
   * rounded frame + input background so a widened, standalone field reads as a
   * real search bar (used by the centered skills-page search); its input fills
   * the frame instead of shrinking to its content.
   */
  variant?: 'underline' | 'boxed'
  'aria-label'?: string
}

/**
 * Shared search field used everywhere (sessions sidebar, pages, overlays,
 * command center, cron). Borderless by default (underline on focus); pass
 * `variant="boxed"` for the framed look. Width/placement come from
 * `containerClassName`.
 */
export function SearchField({
  placeholder,
  value,
  onChange,
  containerClassName,
  inputClassName,
  loading = false,
  onClear,
  inputRef,
  trailingAction,
  variant = 'underline',
  'aria-label': ariaLabel
}: SearchFieldProps) {
  const { t } = useI18n()
  const clear = onClear ?? (() => onChange(''))
  const boxed = variant === 'boxed'

  return (
    <div
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 transition-colors',
        boxed
          ? 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) px-3 focus-within:border-(--ui-stroke-primary)'
          : 'border-b border-transparent px-0.5 focus-within:border-(--ui-stroke-secondary)',
        containerClassName
      )}
    >
      <Search className="pointer-events-none size-3.5 shrink-0 text-muted-foreground/70" />
      <input
        aria-label={ariaLabel}
        className={cn(
          'h-7 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none',
          // Boxed fills the frame so the whole bar is clickable; underline uses
          // `field-sizing: content` to hug the placeholder/typed text (capped by
          // the container's max-width) — no awkward empty space.
          boxed ? 'min-w-0 flex-1' : 'max-w-full [field-sizing:content]',
          inputClassName
        )}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        ref={inputRef}
        type="text"
        value={value}
      />
      {trailingAction}
      {loading ? (
        <Loader2 className="pointer-events-none size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
      ) : value ? (
        <Button
          aria-label={t.ui.search.clear}
          className="shrink-0 text-muted-foreground/85 hover:bg-accent/60 hover:text-foreground"
          onClick={clear}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="close" size="0.875rem" />
        </Button>
      ) : null}
    </div>
  )
}
