import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  SIDEBAR_COLLAPSE_BREAKPOINT_PX,
  SIDEBAR_COLLAPSE_MEDIA_QUERY,
  SIDEBAR_DEFAULT_WIDTH_PX
} from './layout-constants'

describe('APEX narrow-window shell contract', () => {
  it('moves the docked sidebar out of the native window throughout the 640–899px tier', () => {
    expect(SIDEBAR_COLLAPSE_BREAKPOINT_PX).toBe(899)
    expect(SIDEBAR_COLLAPSE_MEDIA_QUERY).toBe('(max-width: 899px)')
    expect(SIDEBAR_DEFAULT_WIDTH_PX).toBe(190)
  })

  it('keeps the boot-paint sidebar fallback aligned with the live pane track', () => {
    const styles = readFileSync(resolve(__dirname, '../styles.css'), 'utf8')

    expect(styles).toContain('--sidebar-width: 11.875rem;')
    expect(styles).not.toContain('--sidebar-width: 11.25rem;')
  })
})
