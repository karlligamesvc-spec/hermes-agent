import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopFeishuStatus, DesktopFeishuSyncResult } from '@/global'

// hc-444 "Connect Feishu" card. The card talks only to window.hermesDesktop.feishu
// (the main-process bridge) — no @/hermes HTTP. We stub the bridge per test to
// drive the three states (connected / not-signed-in / no-entry) and assert the
// user-visible affordances + which bridge action each button fires.

const status = vi.fn<() => Promise<DesktopFeishuStatus>>()
const sync = vi.fn<() => Promise<DesktopFeishuSyncResult>>()
const disconnect = vi.fn<() => Promise<{ ok: boolean }>>()
const openBind = vi.fn<() => Promise<{ ok: boolean; url: string }>>()

function stubBridge() {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    feishu: { status, sync, disconnect, openBind }
  }
}

function makeStatus(patch: Partial<DesktopFeishuStatus> = {}): DesktopFeishuStatus {
  return {
    connected: false,
    signedIn: false,
    agentName: '',
    domain: '',
    credentialStatus: '',
    syncedAt: null,
    ...patch
  }
}

beforeEach(() => {
  stubBridge()
  sync.mockResolvedValue({ ok: true, hasEntry: true })
  disconnect.mockResolvedValue({ ok: true })
  openBind.mockResolvedValue({ ok: true, url: 'https://apex-nodes.com/zh/createbot' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

async function renderCard() {
  const { FeishuSettings } = await import('./feishu-settings')

  return render(<FeishuSettings />)
}

describe('FeishuSettings', () => {
  it('renders nothing when the desktop bridge is absent (web build)', async () => {
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
    const { container } = await renderCard()
    expect(container.firstChild).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })

  it('prompts sign-in first when signed out with no credential', async () => {
    status.mockResolvedValue(makeStatus({ connected: false, signedIn: false }))
    await renderCard()

    expect(await screen.findByText('Sign in first')).toBeTruthy()
    // No sync/openBind affordance is offered until the user is signed in.
    expect(screen.queryByRole('button', { name: /Sync from cloud/ })).toBeNull()
  })

  it('guides a signed-in user with no cloud entry to the web binding flow', async () => {
    status.mockResolvedValue(makeStatus({ connected: false, signedIn: true }))
    await renderCard()

    const openBtn = await screen.findByRole('button', { name: /Set up in browser/ })
    fireEvent.click(openBtn)
    await waitFor(() => expect(openBind).toHaveBeenCalledTimes(1))
  })

  it('shows the connected agent and re-syncs on demand', async () => {
    status.mockResolvedValue(
      makeStatus({ connected: true, signedIn: true, agentName: '我的飞书助手', domain: 'feishu', credentialStatus: 'ok' })
    )
    await renderCard()

    expect(await screen.findByText(/我的飞书助手/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Re-sync/ }))
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
  })

  it('surfaces a stale-credential warning when the cloud probe flagged it expired', async () => {
    status.mockResolvedValue(
      makeStatus({ connected: true, signedIn: true, agentName: 'A', credentialStatus: 'expired' })
    )
    await renderCard()

    expect(await screen.findByText('Login expired')).toBeTruthy()
    expect(screen.getByText(/flagged as expired in the cloud/)).toBeTruthy()
  })

  it('disconnects on confirm', async () => {
    status.mockResolvedValue(makeStatus({ connected: true, signedIn: true, agentName: 'A' }))
    await renderCard()

    fireEvent.click(await screen.findByRole('button', { name: /Disconnect/ }))
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1))
  })
})
