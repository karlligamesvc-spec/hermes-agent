// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeUpdateApply, DesktopRuntimeUpdateCheck, DesktopRuntimeVersion } from '@/global'

// hc-591: Settings → About's engine section is one of the five named wiring
// surfaces (the hc-532 "engine outdated" banner lives here too). Same
// real-atom-behind-a-mocked-module approach as runtime-update-pill.test.tsx.
const applyRuntimeUpdateMock = vi.fn<() => Promise<DesktopRuntimeUpdateApply>>()
const checkRuntimeUpdateMock = vi.fn<() => Promise<DesktopRuntimeUpdateCheck>>()
const loadRuntimeVersionMock = vi.fn<() => Promise<DesktopRuntimeVersion>>()

vi.mock('@/store/runtime-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $runtimeUpdateApplying: atom(false),
    $runtimeUpdateCheck: atom<DesktopRuntimeUpdateCheck | null>(null),
    $runtimeUpdateChecking: atom(false),
    $runtimeVersion: atom<DesktopRuntimeVersion | null>(null),
    applyRuntimeUpdate: () => applyRuntimeUpdateMock(),
    checkRuntimeUpdate: () => checkRuntimeUpdateMock(),
    loadRuntimeVersion: () => loadRuntimeVersionMock()
  }
})

import { $runtimeUpdateCheck, $runtimeVersion } from '@/store/runtime-update'
import { $desktopVersion } from '@/store/updates'

import { EngineUpdateSection } from './about-settings'

beforeEach(() => {
  applyRuntimeUpdateMock.mockReset()
  checkRuntimeUpdateMock.mockReset()
  loadRuntimeVersionMock
    .mockReset()
    .mockResolvedValue({ ok: false, version: null, commit: null, branch: null, key: null })
  $runtimeUpdateCheck.set(null)
  $runtimeVersion.set(null)
  $desktopVersion.set(null)
})

afterEach(() => {
  cleanup()
})

describe('EngineUpdateSection (hc-591 engine version display)', () => {
  it('labels the Electron shell version as the app and the managed runtime as the engine', () => {
    $desktopVersion.set({
      appVersion: '0.17.24',
      electronVersion: '40.10.2',
      engineVersion: '0.20.0',
      hermesRoot: '/tmp/hermes-agent',
      nodeVersion: '22.22.1',
      platform: 'darwin'
    })
    $runtimeVersion.set({
      branch: 'main',
      commit: '8fe26a54',
      key: '8fe26a54',
      ok: true,
      version: '0.20.0'
    })

    render(<EngineUpdateSection />)

    expect(screen.getByText('Version 0.17.24')).toBeTruthy()
    expect(screen.getByText('Version: 0.20.0')).toBeTruthy()
  })

  it('shows the humanized installed version, not the raw internal pin', () => {
    $runtimeVersion.set({
      ok: true,
      version: 'v2026.7.15-fork.b21a7e0d',
      commit: 'b21a7e0d',
      branch: 'main',
      key: 'b21a7e0d'
    })

    const { container } = render(<EngineUpdateSection />)

    expect(screen.getByText('Version: Engine 2026.7.15')).toBeTruthy()
    expect(container.textContent).not.toContain('-fork.')
    expect(container.textContent).not.toContain('b21a7e0d')
  })

  it('shows the humanized latest version in the "found" status line', () => {
    $runtimeVersion.set({
      ok: true,
      version: 'v2026.7.15-fork.b21a7e0d',
      commit: 'b21a7e0d',
      branch: 'main',
      key: 'b21a7e0d'
    })
    $runtimeUpdateCheck.set({
      ok: true,
      updateAvailable: true,
      current: { version: 'v2026.7.15-fork.b21a7e0d', key: 'b21a7e0d' },
      latest: { version: 'v2026.7.25-fork.b0a720a5', key: 'b0a720a5', compatibilityNotes: null }
    })

    const { container } = render(<EngineUpdateSection />)

    expect(screen.getByText('Engine 2026.7.25')).toBeTruthy()
    expect(container.textContent).not.toContain('-fork.')
    expect(container.textContent).not.toContain('b0a720a5')
  })

  it('hc-532 banner: humanizes the shell-declared minimum engine version', () => {
    $runtimeVersion.set({
      ok: true,
      version: 'v2026.7.10-fork.aaaaaaaa',
      commit: 'aaaaaaaa',
      branch: 'main',
      key: 'aaaaaaaa',
      minEngineVersion: 'v2026.7.15-fork.b21a7e0d',
      meetsMinEngine: false
    })

    render(<EngineUpdateSection />)

    const banner = screen.getByTestId('engine-outdated-banner')

    expect(banner.textContent).toContain('Engine 2026.7.15')
    expect(banner.textContent).not.toContain('-fork.')
    expect(banner.textContent).not.toContain('b21a7e0d')
  })

  it('does not touch the desktop-shell-version copy (a different versioning scheme, no -fork segment)', () => {
    // hc-475 (F4): desktopUpgradeRequired.minDesktopVersion is a DESKTOP shell
    // semver ("0.17.0"), never the engine's calver+fork pin -- must render as
    // the plain "v0.17.0" it always has, untouched by formatEngineDisplayVersion.
    $runtimeUpdateCheck.set({
      ok: true,
      updateAvailable: false,
      current: { version: 'v2026.7.15-fork.b21a7e0d', key: 'b21a7e0d' },
      latest: { version: 'v2026.8.1-fork.deadbeef', key: 'deadbeef', compatibilityNotes: null },
      desktopUpgradeRequired: { minDesktopVersion: '0.17.0', currentDesktopVersion: '0.16.17' }
    })

    render(<EngineUpdateSection />)

    expect(screen.getByText('Update your desktop app to v0.17.0 or later to install this engine.')).toBeTruthy()
  })
})
