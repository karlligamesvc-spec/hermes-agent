import './apex-avatar.css'

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

import { APEX_AVATAR_COLOR, type ApexAvatarShape } from './apex-avatar-look'

export {
  APEX_AVATAR_COLOR,
  APEX_AVATAR_SHAPES,
  APEX_BOT_COLORS,
  APEX_BOT_DEFAULT_LOOK,
  type ApexAvatarShape,
  type ApexBotColor,
  apexBotColorHex
} from './apex-avatar-look'

/**
 * hc-1064 G2: APEX's face in single-thread product mode — the purple figure
 * from 「APEX 极简助手原型 v2」, which Kael chose over the app icon there (N1,
 * 2026-10-26). It is drawn here, on the prototype's 28×28 grid: a disc and two
 * eyes, no image file, nothing from upstream. Idle it blinks, working it looks
 * down, talking it breathes; reduced motion keeps only the pose.
 *
 * hc-1077 (several assistants, prototype v2 ⑥–⑨): the same figure in another
 * shape and colour is another assistant's face. Only those two change; the
 * eyes, the motions and the grid stay. Without them it is APEX, unchanged: the
 * purple disc. APEX keeps that look for good (K6), so the purple is not among
 * the colours another assistant can take.
 *
 * Only the single-thread product surfaces wear it (the header pill, the
 * sidebar's assistant rows, the activity line). Everywhere else — login,
 * install and update overlays, developer mode, the switch off — APEX is still
 * BrandMark, the app icon. `src/apex-avatar-identity.test.tsx` holds both.
 */

export type ApexAvatarMood = 'idle' | 'talking' | 'working'

/** The circle is a `<circle>`, so APEX's drawing stays exactly what it was. */
const SHAPE_PATHS: Record<Exclude<ApexAvatarShape, 'circle'>, string> = {
  cloud:
    'M2 17A7 7 0 1 1 16 17A7 7 0 1 1 2 17Z M12 17A7 7 0 1 1 26 17A7 7 0 1 1 12 17Z M5 12A9 9 0 1 1 23 12A9 9 0 1 1 5 12Z M9 17H19V24H9Z',
  drop: 'M14 0C14 0 25 11.5 25 17A11 11 0 0 1 3 17C3 11.5 14 0 14 0Z',
  hexagon: 'M14 0L26.12 7V21L14 28L1.88 21V7Z',
  pill: 'M10 4H18A10 10 0 0 1 18 24H10A10 10 0 0 1 10 4Z',
  squircle: 'M9 0H19A9 9 0 0 1 28 9V19A9 9 0 0 1 19 28H9A9 9 0 0 1 0 19V9A9 9 0 0 1 9 0Z'
}

/** Where the eyes sit in each shape (the prototype's grid). */
const EYE_TOP: Record<ApexAvatarShape, number> = { circle: 8, cloud: 10, drop: 13, hexagon: 8, pill: 9, squircle: 8 }

/** Working, the eyes drop and shorten: it is looking down at the task. */
function eyesFor(shape: ApexAvatarShape, mood: ApexAvatarMood): { height: number; y: number } {
  return mood === 'working' ? { height: 5, y: EYE_TOP[shape] + 4 } : { height: 7.4, y: EYE_TOP[shape] }
}

export function ApexAvatar({
  className,
  color = APEX_AVATAR_COLOR,
  mood = 'idle',
  shape = 'circle',
  ...props
}: Omit<ComponentProps<'svg'>, 'children' | 'color' | 'viewBox'> & {
  /** A hex from APEX_BOT_COLORS (or APEX's own purple, the default). */
  color?: string
  mood?: ApexAvatarMood
  shape?: ApexAvatarShape
}) {
  const eyes = eyesFor(shape, mood)

  return (
    <svg
      aria-hidden="true"
      className={cn('apex-avatar shrink-0', className)}
      data-apex-avatar={mood}
      viewBox="0 0 28 28"
      {...props}
    >
      {shape === 'circle' ? (
        <circle cx="14" cy="14" fill={color} r="14" />
      ) : (
        <path d={SHAPE_PATHS[shape]} fill={color} />
      )}
      <rect fill="#FFFFFF" height={eyes.height} rx="1.8" width="3.6" x="8.3" y={eyes.y} />
      <rect fill="#FFFFFF" height={eyes.height} rx="1.8" width="3.6" x="16.1" y={eyes.y} />
    </svg>
  )
}
