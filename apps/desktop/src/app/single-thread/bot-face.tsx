/**
 * STAND-IN until hc-1077 (M1) lands its shape and color parameters on ApexAvatar: the six shapes and
 * six colors of prototype v2 artboard ⑦, on the same 28×28 grid as APEX's face. Replaced by ApexAvatar
 * when this branch is stacked on M1's; nothing outside the M2 sheet uses it.
 */
import type { ComponentProps } from 'react'

import type { BotColorId, BotShapeId } from '@/i18n/single-thread-bots'
import { cn } from '@/lib/utils'

export const BOT_SHAPES: readonly BotShapeId[] = ['circle', 'squircle', 'pill', 'hexagon', 'cloud', 'drop']

export const BOT_COLORS: Readonly<Record<BotColorId, string>> = {
  blue: '#2563D9',
  teal: '#0B8A7B',
  green: '#2E8A40',
  orange: '#C9631A',
  rose: '#C93A6E',
  gold: '#9A6B00'
}

const PATHS: Readonly<Record<BotShapeId, string>> = {
  circle: 'M14 0A14 14 0 1 1 14 28A14 14 0 1 1 14 0Z',
  squircle: 'M9 0H19A9 9 0 0 1 28 9V19A9 9 0 0 1 19 28H9A9 9 0 0 1 0 19V9A9 9 0 0 1 9 0Z',
  pill: 'M10 4H18A10 10 0 0 1 18 24H10A10 10 0 0 1 10 4Z',
  hexagon: 'M14 0L26.12 7V21L14 28L1.88 21V7Z',
  cloud:
    'M2 17A7 7 0 1 1 16 17A7 7 0 1 1 2 17Z M12 17A7 7 0 1 1 26 17A7 7 0 1 1 12 17Z M5 12A9 9 0 1 1 23 12A9 9 0 1 1 5 12Z M9 17H19V24H9Z',
  drop: 'M14 0C14 0 25 11.5 25 17A11 11 0 0 1 3 17C3 11.5 14 0 14 0Z'
}

const EYE_Y: Readonly<Record<BotShapeId, number>> = { circle: 8, squircle: 8, pill: 9, hexagon: 8, cloud: 10, drop: 13 }

export function isBotShape(value: unknown): value is BotShapeId {
  return typeof value === 'string' && value in PATHS
}

/** `ui_meta.apex.color` holds the id; the hex is only what is drawn. */
export function isBotColor(value: unknown): value is BotColorId {
  return typeof value === 'string' && value in BOT_COLORS
}

export function BotFace({
  className,
  color,
  shape,
  ...props
}: Omit<ComponentProps<'svg'>, 'children' | 'viewBox'> & { color: string; shape: BotShapeId }) {
  const y = EYE_Y[shape]

  return (
    <svg aria-hidden="true" className={cn('shrink-0', className)} data-bot-face={shape} viewBox="0 0 28 28" {...props}>
      <path d={PATHS[shape]} fill={color} />
      <rect fill="#FFFFFF" height="7.4" rx="1.8" width="3.6" x="8.3" y={y} />
      <rect fill="#FFFFFF" height="7.4" rx="1.8" width="3.6" x="16.1" y={y} />
    </svg>
  )
}
