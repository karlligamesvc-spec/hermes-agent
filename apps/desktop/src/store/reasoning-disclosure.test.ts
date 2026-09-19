import { describe, expect, it, vi } from 'vitest'

import { REASONING_COLLAPSED_BY_DEFAULT_STORAGE_KEY, reasoningCollapsedByDefault } from './reasoning-disclosure'

describe('reasoning disclosure default', () => {
  it('starts collapsed when the versioned preference has not been chosen', () => {
    const read = vi.fn(() => null)

    expect(reasoningCollapsedByDefault(read)).toBe(true)
    expect(read).toHaveBeenCalledWith(REASONING_COLLAPSED_BY_DEFAULT_STORAGE_KEY)
  })

  it('keeps the user choice after the new default has been applied', () => {
    expect(reasoningCollapsedByDefault(() => 'false')).toBe(false)
    expect(reasoningCollapsedByDefault(() => 'true')).toBe(true)
  })
})
