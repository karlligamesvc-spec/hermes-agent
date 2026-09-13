import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

// Text+icon actions underline the label on hover, not the glyph.
const TEXT_ACTION_ICON = '[&_.codicon]:no-underline [&_svg]:no-underline'

// APEX action hierarchy. `default` is the primary CTA; `outline` is the
// elevated secondary action; `secondary` is the selected/soft-fill control;
// `ghost` and the text variants are tertiary actions. Page-specific row/card
// buttons may still override geometry, but compact actions inherit one shared
// radius, type scale, colour source and complete interaction-state treatment.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[0.625rem] text-[0.8125rem] leading-5 font-semibold whitespace-nowrap shadow-none transition-[background-color,border-color,color,box-shadow,filter,transform] duration-100 outline-none focus-visible:border-ring focus-visible:ring-[0.1875rem] focus-visible:ring-ring/50 active:brightness-[0.96] active:translate-y-px disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 disabled:shadow-none disabled:transform-none aria-busy:cursor-progress aria-busy:opacity-75 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          'bg-(--dt-primary-solid) text-(--dt-primary-solid-foreground) shadow-[0_0.375rem_1rem_color-mix(in_srgb,var(--theme-primary)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--dt-primary-solid)_90%,black)] hover:shadow-[0_0.5rem_1.25rem_color-mix(in_srgb,var(--theme-primary)_22%,transparent)]',
        destructive:
          'bg-destructive text-white shadow-[0_0.375rem_1rem_color-mix(in_srgb,var(--ui-red)_16%,transparent)] hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/70 dark:focus-visible:ring-destructive/40',
        // Elevated secondary action — the white/hairline treatment in the
        // approved New goal and Profile action controls.
        outline:
          'bg-(--ui-bg-elevated) text-(--ui-text-primary) shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary),var(--shadow-xs)] hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
        // Soft-fill selected control — filters and segmented choices use this,
        // not as a second competing CTA treatment.
        secondary:
          'bg-[color-mix(in_srgb,var(--theme-primary)_10%,var(--ui-bg-elevated))] text-(--ui-text-primary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--theme-primary)_14%,var(--ui-bg-elevated))] hover:text-(--ui-text-primary)',
        ghost: 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
        link: `text-primary underline-offset-4 decoration-current/20 hover:underline ${TEXT_ACTION_ICON}`,
        // Boxless inline-text action (no bg/border). Quiet by default — reads as
        // muted label text, underlines on hover (e.g. "Cancel", "Clear").
        text: `text-muted-foreground underline-offset-4 hover:text-foreground hover:underline ${TEXT_ACTION_ICON}`,
        // Emphasized inline-text action: bold + always-underlined link. Use for
        // the actionable affordance in a row ("Change", "Set", "Open logs", …).
        textStrong: `font-semibold text-muted-foreground underline underline-offset-4 hover:text-foreground ${TEXT_ACTION_ICON}`
      },
      size: {
        default: 'min-h-9 px-3.5 py-1.5 has-[>svg]:px-3',
        xs: "min-h-7 gap-1 px-2.5 py-0.5 text-xs leading-4 has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3",
        sm: 'min-h-8 px-3 py-1 has-[>svg]:px-2.5',
        lg: 'min-h-10 px-5 py-2 text-sm leading-5 has-[>svg]:px-4',
        // Flush inline text action — no box padding/height. Pair with text/link
        // variants when the button must sit inline in a heading or sentence
        // (replaces ad-hoc `h-auto px-0 py-0` overrides).
        inline: 'h-auto gap-1 p-0 has-[>svg]:px-0',
        // Status-stack headers, table footers — 12px text actions beside a label.
        micro:
          "h-auto gap-0.5 px-1 py-0 text-xs leading-4 font-normal has-[>svg]:px-0.5 [&_svg:not([class*='size-'])]:size-3",
        icon: 'size-9 rounded-[0.625rem]',
        'icon-xs': "size-6 rounded-[0.5rem] [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8 rounded-[0.625rem]',
        'icon-lg': 'size-10 rounded-[0.75rem]',
        'icon-titlebar':
          'titlebar-icon-button h-(--titlebar-control-height) w-(--titlebar-control-size) rounded-[4px] [&_svg:not([class*="size-"])]:size-(--titlebar-icon-size)'
      }
    },
    compoundVariants: [
      // textStrong is a boxless link — size variants still inject px-*; strip
      // inline padding so the underline sits flush with the label.
      {
        variant: 'textStrong',
        class: 'px-0 has-[>svg]:px-0'
      }
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  )
}

export { Button, buttonVariants }
