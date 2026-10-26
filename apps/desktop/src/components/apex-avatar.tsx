import './apex-avatar.css'

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/**
 * hc-1064 G2: APEX's face in single-thread product mode — the purple figure
 * from 「APEX 极简助手原型 v2」, which Kael chose over the app icon there (N1,
 * 2026-10-26). It is drawn here, on the prototype's 28×28 grid: a disc and two
 * eyes, no image file, nothing from upstream. Idle it blinks, working it looks
 * down, talking it breathes; reduced motion keeps only the pose.
 *
 * Only the single-thread product surfaces wear it (the header pill, the
 * sidebar's assistant row, the activity line). Everywhere else — login,
 * install and update overlays, developer mode, the switch off — APEX is still
 * BrandMark, the app icon. `src/apex-avatar-identity.test.tsx` holds both.
 */

export type ApexAvatarMood = 'idle' | 'talking' | 'working'

export const APEX_AVATAR_COLOR = '#6A4CEB'

/** Working, the eyes drop and shorten: it is looking down at the task. */
const EYES: Record<ApexAvatarMood, { height: number; y: number }> = {
  idle: { height: 7.4, y: 8 },
  talking: { height: 7.4, y: 8 },
  working: { height: 5, y: 12 }
}

export function ApexAvatar({
  className,
  mood = 'idle',
  ...props
}: Omit<ComponentProps<'svg'>, 'children' | 'viewBox'> & { mood?: ApexAvatarMood }) {
  const eyes = EYES[mood]

  return (
    <svg
      aria-hidden="true"
      className={cn('apex-avatar shrink-0', className)}
      data-apex-avatar={mood}
      viewBox="0 0 28 28"
      {...props}
    >
      <circle cx="14" cy="14" fill={APEX_AVATAR_COLOR} r="14" />
      <rect fill="#FFFFFF" height={eyes.height} rx="1.8" width="3.6" x="8.3" y={eyes.y} />
      <rect fill="#FFFFFF" height={eyes.height} rx="1.8" width="3.6" x="16.1" y={eyes.y} />
    </svg>
  )
}
