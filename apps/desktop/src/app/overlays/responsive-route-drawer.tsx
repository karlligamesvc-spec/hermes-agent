import { Dialog as DialogPrimitive } from 'radix-ui'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { closeRouteDrawer } from '../routes'
import { TITLEBAR_HEIGHT } from '../shell/titlebar'

export const ROUTE_DRAWER_WIDE_QUERY = '(min-width: 1100px)'
export const ROUTE_DRAWER_COMPACT_QUERY = '(min-width: 900px)'

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

function useWideRouteDrawer(query: string): boolean {
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? false)

  useEffect(() => {
    const media = window.matchMedia?.(query)

    if (!media) {
      return
    }

    const update = () => setWide(media.matches)

    update()
    media.addEventListener('change', update)

    return () => media.removeEventListener('change', update)
  }, [query])

  return wide
}

interface ResponsiveRouteDrawerProps {
  children: ReactNode
  compact?: boolean
  onClose: () => void
  title: string
  contentClassName?: string
}

/** Modal object surface shared by route-backed drawers. Radix owns the focus
 * trap and topmost Escape behavior; this shell owns the Desktop breakpoint,
 * scroll lock, and focus restoration when route history removes the surface. */
export function ResponsiveRouteDrawer({
  children,
  compact = false,
  contentClassName,
  onClose,
  title
}: ResponsiveRouteDrawerProps) {
  const { t } = useI18n()
  const wide = useWideRouteDrawer(compact ? ROUTE_DRAWER_COMPACT_QUERY : ROUTE_DRAWER_WIDE_QUERY)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )

  useEffect(() => {
    const returnFocus = returnFocusRef.current
    const unlock = lockBodyScroll()

    return () => {
      unlock()

      if (returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true })
      }
    }
  }, [])

  useEffect(() => {
    const resetNestedScroll = () => {
      const scrollContainer = contentRef.current?.querySelector<HTMLElement>('[data-route-drawer-scroll]')

      if (scrollContainer) {
        scrollContainer.scrollTop = 0
      }
    }

    window.addEventListener('resize', resetNestedScroll)

    return () => window.removeEventListener('resize', resetNestedScroll)
  }, [])

  return (
    <DialogPrimitive.Root onOpenChange={open => !open && onClose()} open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-(--z-modal-backdrop) bg-black/22 backdrop-blur-[0.125rem] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none motion-reduce:transition-none"
          data-route-drawer-backdrop=""
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-x-0 bottom-0 top-[var(--titlebar-height)] z-(--z-modal) flex min-h-0 min-w-0 flex-col overflow-hidden border-(--stroke-nous) bg-(--ui-chat-surface-background) text-foreground shadow-nous outline-none duration-150',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
            compact
              ? 'min-[900px]:left-auto min-[900px]:right-0 min-[900px]:w-[min(540px,calc(100vw-16px))] min-[900px]:border-l min-[900px]:data-[state=closed]:slide-out-to-right-4 min-[900px]:data-[state=open]:slide-in-from-right-4'
              : 'min-[1100px]:left-auto min-[1100px]:right-0 min-[1100px]:w-[min(35rem,48vw)] min-[1100px]:border-l min-[1100px]:data-[state=closed]:slide-out-to-right-4 min-[1100px]:data-[state=open]:slide-in-from-right-4',
            'motion-reduce:animate-none motion-reduce:transition-none',
            contentClassName
          )}
          data-glass-raised=""
          data-layout={wide ? 'drawer' : 'fullscreen'}
          data-overlay-surface=""
          data-route-drawer=""
          onCloseAutoFocus={event => {
            event.preventDefault()
            const target = returnFocusRef.current

            if (target?.isConnected) {
              target.focus({ preventScroll: true })
            }
          }}
          onOpenAutoFocus={event => {
            event.preventDefault()
            const content = contentRef.current
            const scrollContainer = content?.querySelector<HTMLElement>('[data-route-drawer-scroll]')

            if (scrollContainer) {
              scrollContainer.scrollTop = 0
            }

            content?.focus({ preventScroll: true })
          }}
          ref={contentRef}
          // The body portal cannot inherit AppShell's native-chrome token.
          style={{ '--titlebar-height': `${TITLEBAR_HEIGHT}px` } as CSSProperties}
          tabIndex={-1}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <Button
              aria-label={t.common.close}
              className="absolute right-3 top-3 z-20 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
              size="icon-titlebar"
              variant="ghost"
            >
              <X />
            </Button>
          </DialogPrimitive.Close>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

interface RouteDrivenDrawerProps extends Omit<ResponsiveRouteDrawerProps, 'onClose'> {
  deepLinkFallback: string
}

/** Binds the generic drawer's close lifecycle to browser history. */
export function RouteDrivenDrawer({ deepLinkFallback, ...props }: RouteDrivenDrawerProps) {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <ResponsiveRouteDrawer {...props} onClose={() => closeRouteDrawer(navigate, location.state, deepLinkFallback)} />
  )
}
