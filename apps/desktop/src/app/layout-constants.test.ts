import { describe, expect, it } from 'vitest'

import { SIDEBAR_COLLAPSE_BREAKPOINT_PX, SIDEBAR_COLLAPSE_MEDIA_QUERY } from './layout-constants'

describe('APEX narrow-window shell contract', () => {
  it('moves the docked sidebar out of the native window throughout the 640–899px tier', () => {
    expect(SIDEBAR_COLLAPSE_BREAKPOINT_PX).toBe(899)
    expect(SIDEBAR_COLLAPSE_MEDIA_QUERY).toBe('(max-width: 899px)')
  })
})
