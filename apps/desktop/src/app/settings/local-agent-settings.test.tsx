// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopDaemonStatus, DesktopRuntimeVersion } from '@/global'

// hc-591: local-agent-settings.tsx carries a SECOND hc-532 "engine outdated"
// banner (the A2A daemon block) beyond the one in about-settings.tsx -- found
// via the hc-591 full-tree grep safety net, not named explicitly in the
// original wiring list. Same real-atom mocking approach as the other
// hc-591 test files.
const loadRuntimeVersionMock = vi.fn<() => Promise<DesktopRuntimeVersion>>()

vi.mock('@/store/runtime-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $runtimeVersion: atom<DesktopRuntimeVersion | null>(null),
    loadRuntimeVersion: () => loadRuntimeVersionMock()
  }
})

import { $runtimeVersion } from '@/store/runtime-update'

import { LocalAgentSettings } from './local-agent-settings'

const DORMANT_STATUS: DesktopDaemonStatus = {
  status: 'dormant',
  enabled: false,
  deviceName: 'Test Machine',
  deviceId: 'device-1',
  registered: false,
  connected: false,
  lastError: ''
}

function stubDaemonBridge() {
  const hermesDesktop = {
    daemon: {
      status: () => Promise.resolve(DORMANT_STATUS),
      onStatus: vi.fn(() => () => undefined),
      setEnabled: vi.fn(),
      setDeviceName: vi.fn(),
      unregister: vi.fn()
    }
  }

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = hermesDesktop
}

beforeEach(() => {
  loadRuntimeVersionMock
    .mockReset()
    .mockResolvedValue({ ok: false, version: null, commit: null, branch: null, key: null })
  $runtimeVersion.set(null)
  stubDaemonBridge()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('LocalAgentSettings engine-outdated banner (hc-591 / hc-532)', () => {
  it('renders nothing extra when the engine meets the minimum', async () => {
    $runtimeVersion.set({
      ok: true,
      version: 'v2026.7.20-fork.cafefeed',
      commit: 'cafefeed',
      branch: 'main',
      key: 'cafefeed',
      meetsMinEngine: true
    })

    render(<LocalAgentSettings />)

    // The device-name <Input>'s value only reflects DORMANT_STATUS once the
    // async bridge.status() call in refresh() resolves and applyStatus() runs
    // -- a reliable "the effect has settled" signal (unlike the "Off" status
    // text, which the status-less initial render already shows via the
    // switch's default case, i.e. before the async refresh completes too).
    await waitFor(() => expect(screen.getByDisplayValue('Test Machine')).toBeTruthy())
    expect(screen.queryByTestId('daemon-engine-outdated')).toBeNull()
  })

  it('humanizes the internal engine pin in the outdated banner, never the raw -fork.<sha>', async () => {
    $runtimeVersion.set({
      ok: true,
      version: 'v2026.7.10-fork.aaaaaaaa',
      commit: 'aaaaaaaa',
      branch: 'main',
      key: 'aaaaaaaa',
      minEngineVersion: 'v2026.7.15-fork.b21a7e0d',
      meetsMinEngine: false
    })

    render(<LocalAgentSettings />)

    const banner = await screen.findByTestId('daemon-engine-outdated')

    expect(banner.textContent).toContain('Engine 2026.7.15')
    expect(banner.textContent).not.toContain('-fork.')
    expect(banner.textContent).not.toContain('b21a7e0d')
  })
})
