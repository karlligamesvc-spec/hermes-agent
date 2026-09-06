import { Dialog as DialogPrimitive } from 'radix-ui'
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react'

import { TITLEBAR_HEIGHT } from '@/app/shell/titlebar'
import { TitlebarIcon } from '@/app/shell/titlebar-icon'
import { Button } from '@/components/ui/button'
import { translateNow } from '@/i18n'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

// Shared top clearance for overlay content that sits *beside* the floating
// close button (which is absolute at `0.1875rem + titlebar/2`, -translate-y-1/2,
// so it costs no layout space): a Panel's header and the split layout's left
// sidebar links. They ride up next to the X on the same line across every
// overlay (settings, system, agents, profiles, …) — change it here, not per-surface.
// Main content sits *under* the X (top-right) and keeps its own taller pad.
export const OVERLAY_TOP_CLEARANCE = 'pt-[calc(var(--titlebar-height)/2-0.4375rem)]'

let bodyScrollLockDepth = 0
let bodyOverflowBeforeLock = ''

function lockBodyScroll(): () => void {
  if (bodyScrollLockDepth === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }

  bodyScrollLockDepth += 1

  return () => {
    bodyScrollLockDepth = Math.max(0, bodyScrollLockDepth - 1)

    if (bodyScrollLockDepth === 0) {
      document.body.style.overflow = bodyOverflowBeforeLock
    }
  }
}

interface OverlayViewProps {
  children: ReactNode
  onClose: () => void
  ariaDescribedBy?: string
  ariaLabelledBy?: string
  closeLabel?: string
  compactFullscreen?: boolean
  containerClassName?: string
  contentClassName?: string
  /** Chrome pinned to the card's top edge, horizontally centered and riding
   *  the border half-in half-out (e.g. the Settings search pill). Rendered
   *  beside the card, not inside it — the card clips its own overflow. */
  edgeBadge?: ReactNode
  headerContent?: ReactNode
  rootClassName?: string
  title?: string
  /** Controls rendered on the close button's row, to its left. They ride the
   *  titlebar strip, so keep them titlebar-sized and quiet. */
  titlebarActions?: ReactNode
}

export function OverlayView({
  children,
  onClose,
  ariaDescribedBy,
  ariaLabelledBy,
  closeLabel = translateNow('common.close'),
  compactFullscreen = false,
  containerClassName,
  contentClassName,
  edgeBadge,
  headerContent,
  rootClassName,
  title,
  titlebarActions
}: OverlayViewProps) {
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )

  const closeOverlay = () => {
    triggerHaptic('close')
    onClose()
  }

  // Esc dismisses every OverlayView-based overlay. Nested Radix dialogs
  // stop propagation themselves, so opening (e.g.) the model picker inside
  // Settings still closes the picker first instead of the underlying overlay.
  useEffect(() => {
    const returnFocus = returnFocusRef.current
    const releaseLayer = pushEscapeLayer(ESCAPE_PRIORITY.overlay)
    const unlockBodyScroll = lockBodyScroll()

    return () => {
      unlockBodyScroll()
      releaseLayer()

      // Route-backed overlays are not mounted by a Radix Trigger, so restore
      // the invoking control ourselves. Delay until the route commit finishes;
      // a Profile → Settings handoff mounts another overlay and must keep focus
      // inside the replacement instead of bouncing to the account button.
      window.setTimeout(() => {
        if (!document.querySelector('[data-overlay-surface]') && returnFocus?.isConnected) {
          returnFocus.focus({ preventScroll: true })
        }
      }, 0)
    }
  }, [])

  return (
    <DialogPrimitive.Root onOpenChange={open => !open && closeOverlay()} open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/22 backdrop-blur-[0.125rem]',
            compactFullscreen &&
              'max-[53rem]:bg-(--ui-chat-surface-background) max-[53rem]:backdrop-blur-none'
          )}
          data-overlay-backdrop=""
        />
        <div
          className={cn(
            'pointer-events-none fixed inset-0 z-50 p-[calc(var(--titlebar-height)+0.625rem)]',
            'sm:p-[calc(var(--titlebar-height)+0.875rem)]',
            compactFullscreen && 'max-[53rem]:!p-0'
          )}
          data-responsive-mode={compactFullscreen ? 'compact-fullscreen' : 'inset'}
          style={{ '--titlebar-height': `${TITLEBAR_HEIGHT}px` } as CSSProperties}
        >
          <div className={cn('relative mx-auto h-full min-h-0', containerClassName)}>
            <DialogPrimitive.Content
              aria-describedby={ariaDescribedBy}
              aria-label={ariaLabelledBy ? undefined : title ?? closeLabel}
              aria-labelledby={ariaLabelledBy}
              aria-modal="true"
              className={cn(
                'pointer-events-auto relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) shadow-md outline-none',
                compactFullscreen &&
                  'max-[53rem]:rounded-none max-[53rem]:border-0 max-[53rem]:shadow-none',
                rootClassName
              )}
              data-glass-raised=""
              data-overlay-surface=""
              onCloseAutoFocus={event => {
                event.preventDefault()
              }}
              onEscapeKeyDown={event => {
                if (!isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
                  event.preventDefault()
                }
              }}
            >
              {!ariaLabelledBy && <DialogPrimitive.Title className="sr-only">{title ?? closeLabel}</DialogPrimitive.Title>}
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[calc(var(--titlebar-height)+0.1875rem)] [-webkit-app-region:drag]">
                {headerContent && (
                  <div className="pointer-events-auto absolute left-1/2 top-[calc(0.5rem+var(--titlebar-height)/2)] -translate-x-1/2 -translate-y-1/2 [-webkit-app-region:no-drag]">
                    {headerContent}
                  </div>
                )}

                <div className="pointer-events-auto absolute right-3 top-[calc(0.1875rem+var(--titlebar-height)/2)] flex -translate-y-1/2 items-center gap-1.5 [-webkit-app-region:no-drag]">
                  {titlebarActions}

                  <DialogPrimitive.Close asChild>
                    <Button
                      aria-label={closeLabel}
                      className="text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
                      data-overlay-close=""
                      size="icon-titlebar"
                      variant="ghost"
                    >
                      <TitlebarIcon name="close" />
                    </Button>
                  </DialogPrimitive.Close>
                </div>
              </div>

              {/* No top padding here: the split-layout columns own their own
                  titlebar clearance so their backgrounds run flush to the card top
                  (otherwise the card surface shows as a gap above the sidebar). */}
              <div className={cn('min-h-0 flex flex-1 flex-col', contentClassName)}>{children}</div>
            </DialogPrimitive.Content>

            {/* Sibling of the card, not a child: the card clips its own overflow
                (rounded corners), and the badge deliberately straddles the top
                border — half above, half below. */}
            {edgeBadge && (
              <div className="pointer-events-auto absolute left-1/2 top-0 z-20 -translate-x-1/2 -translate-y-1/2">
                {edgeBadge}
              </div>
            )}
          </div>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
