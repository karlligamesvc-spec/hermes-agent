// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DirectConnectBanner } from './direct-connect-banner'

type DaemonSnapshot = { status: string; deviceName?: string }

// Stub only the daemon bridge the banner reads (status + onStatus), leaving the
// rest of window.hermesDesktop absent — the same "replace only the bridge"
// approach the update-pill tests use.
function setDaemon(snapshot: DaemonSnapshot | null | undefined) {
  const daemon =
    snapshot === undefined
      ? undefined
      : {
          onStatus: vi.fn(() => () => undefined),
          status: vi.fn(() => Promise.resolve(snapshot))
        }

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = daemon ? { daemon } : {}
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('DirectConnectBanner', () => {
  it('renders nothing when the daemon bridge is absent', () => {
    setDaemon(undefined)
    const { container } = render(<DirectConnectBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('stays invisible while the daemon is offline / dormant', async () => {
    setDaemon({ status: 'dormant' })
    const { container } = render(<DirectConnectBanner />)
    // Give the async status() a tick to resolve; it must remain hidden.
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('shows a live control banner with the device name when the daemon is online', async () => {
    setDaemon({ deviceName: "Karl's iPhone", status: 'online' })
    render(<DirectConnectBanner />)

    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain("Karl's iPhone")
    // Carries the manual-approval reassurance from the approved design.
    expect(banner.textContent).toMatch(/approval|审批|承認/)
  })
})
