import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ImEntryView } from './index'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: { common: { retry: 'Retry' }, imEntry: { loading: 'Loading…', liveState: { error: 'Connection unavailable' } } } }) }))
vi.mock('@/hermes', () => ({ getMessagingPlatforms: vi.fn().mockResolvedValue({ platforms: [] }) }))

afterEach(() => cleanup())

describe('assistant channel source', () => {
  it('shows an unavailable state when the binding bridge is absent rather than reporting zero connections', async () => {
    window.hermesDesktop = {} as never

    render(<ImEntryView embedded />)
    expect((await screen.findByRole('alert')).textContent).toContain('Connection unavailable')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('No channels connected yet.')).toBeNull()
  })
})
