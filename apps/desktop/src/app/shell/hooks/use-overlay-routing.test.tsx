// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { PROFILE_STATS_ROUTE, SETTINGS_ROUTE } from '@/app/routes'

import { useOverlayRouting } from './use-overlay-routing'

function RoutingHarness() {
  const location = useLocation()
  const navigate = useNavigate()
  const overlay = useOverlayRouting()

  return (
    <>
      <output aria-label="route">{`${location.pathname}${location.search}${location.hash}`}</output>
      <button onClick={() => navigate(PROFILE_STATS_ROUTE)} type="button">
        Profile
      </button>
      <button onClick={() => navigate(SETTINGS_ROUTE)} type="button">
        Settings
      </button>
      <button onClick={overlay.closeOverlayToPreviousRoute} type="button">
        Close overlay
      </button>
    </>
  )
}

afterEach(cleanup)

describe('useOverlayRouting account handoff', () => {
  it('keeps the exact underlying route through Profile → Settings', () => {
    render(
      <MemoryRouter initialEntries={['/projects?cursor=next#project-row']}>
        <RoutingHarness />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))
    expect(screen.getByRole('status', { name: 'route' }).textContent).toBe('/profile')

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('status', { name: 'route' }).textContent).toBe('/settings')

    fireEvent.click(screen.getByRole('button', { name: 'Close overlay' }))
    expect(screen.getByRole('status', { name: 'route' }).textContent).toBe('/projects?cursor=next#project-row')
  })
})
