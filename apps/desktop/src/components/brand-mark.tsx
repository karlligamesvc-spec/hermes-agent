import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge — the APEX app icon on its own tile, identical in light/dark.
// This is the SAME asset the login screen and the onboarding rows use, so every
// place the product introduces itself (install overlay, updates overlay, About)
// shows one mark. It deliberately does NOT reference the upstream mascot art in
// public/ (nous-girl.jpg / hermes.png): those files stay on disk to keep the
// rebase surface small, but nothing on the live path may point at them.
// Fills the tile (softly rounded); size via className (default size-14).
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md', className)}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={assetPath('apple-touch-icon.png')} />
    </span>
  )
}
