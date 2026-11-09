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
    loadRuntimeVersion: () => loadRuntimeVersionMock(),
    switchToBundledEngine: async () => ({ ok: false, error: 'unsupported' })
  }
})

import { $runtimeUpdateCheck, $runtimeUpdateChecking, $runtimeVersion } from '@/store/runtime-update'
import { $shellUpdate } from '@/store/shell-update'
import { $desktopVersion } from '@/store/updates'

import { EngineUpdateSection } from './about-settings'

// hc-1200: no engine version reaches the screen: not its calver (it reads as a date), not its -fork.<key>.
const ENGINE_VERSION = /\d{4}\.\d{1,2}\.\d{1,2}|-fork\.|a2e1a4b5|b21a7e0d|b0a720a5|deadbeef/u

beforeEach(() => {
  applyRuntimeUpdateMock.mockReset()
  checkRuntimeUpdateMock.mockReset()
  loadRuntimeVersionMock
    .mockReset()
    .mockResolvedValue({ ok: false, version: null, commit: null, branch: null, key: null })
  $runtimeUpdateCheck.set(null)
  $runtimeUpdateChecking.set(false)
  $runtimeVersion.set(null)
  $shellUpdate.set(null)
  $desktopVersion.set(null)
})

afterEach(() => {
  cleanup()
})

describe('EngineUpdateSection (hc-591, hc-1200: no engine version on screen)', () => {
  it('hc-1033: says when the engine did not update with the app', () => {
    $runtimeVersion.set({ ok: true, version: null, commit: null, branch: null, key: null, keptBack: { reason: 'newer-or-unknown', bundledVersion: 'v2026.10.23-fork.a2e1a4b5' } })

    render(<EngineUpdateSection />)

    const banner = screen.getByTestId('engine-kept-back-banner')
    expect(banner.textContent).toContain('The AI engine was not updated')
    expect(banner.textContent).not.toMatch(ENGINE_VERSION)
  })

  it('keeps an unchecked update state honest instead of claiming latest', () => {
    render(<EngineUpdateSection />)

    expect(screen.getByText('Check whether a newer engine is available.')).toBeTruthy()
    expect(screen.queryByText("You're on the latest version.")).toBeNull()
  })

  it('announces checking even when the previous successful result said latest', () => {
    $runtimeUpdateCheck.set({
      ok: true,
      updateAvailable: false,
      current: { version: 'v2026.7.15-fork.b21a7e0d', key: 'b21a7e0d' },
      latest: { version: 'v2026.7.15-fork.b21a7e0d', key: 'b21a7e0d', compatibilityNotes: null }
    })
    $runtimeUpdateChecking.set(true)

    render(<EngineUpdateSection />)

    expect(screen.getAllByText('Checking…')).toHaveLength(2)
    expect(screen.queryByText("You're on the latest version.")).toBeNull()
  })

  it('shows a failed check as a failure instead of claiming latest', () => {
    $runtimeUpdateCheck.set({
      error: 'offline',
      ok: false,
      updateAvailable: false,
      current: { version: null, key: null },
      latest: null
    })

    render(<EngineUpdateSection />)

    expect(screen.getByText("Couldn't check for an engine update. Check your connection and try again.")).toBeTruthy()
    expect(screen.queryByText("You're on the latest version.")).toBeNull()
  })

  it('shows a failed app update check in words instead of the raw network code (hc-1030)', () => {
    $shellUpdate.set({ error: 'net::ERR_TIMED_OUT', percent: null, phase: 'error', releaseNotes: null, version: null })

    render(<EngineUpdateSection />)

    expect(screen.getByText("Couldn't reach the update server. Check your connection and try again.")).toBeTruthy()
    expect(screen.queryByText('net::ERR_TIMED_OUT')).toBeNull()
  })

  it('shows the APEX version and no engine version', () => {
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

    const { container } = render(<EngineUpdateSection />)

    expect(screen.getByText('Version 0.17.24')).toBeTruthy()
    expect(container.textContent).not.toContain('0.20.0')
  })

  it('never shows the installed engine version, not even its date', () => {
    $runtimeVersion.set({
      ok: true,
      version: 'v2026.7.15-fork.b21a7e0d',
      commit: 'b21a7e0d',
      branch: 'main',
      key: 'b21a7e0d'
    })

    const { container } = render(<EngineUpdateSection />)

    expect(container.textContent).not.toMatch(ENGINE_VERSION)
  })

  it('offers an engine update without naming its version', () => {
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

    expect(screen.getByText('Engine update')).toBeTruthy()
    expect(container.textContent).not.toMatch(ENGINE_VERSION)
  })

  it('hc-532 banner: asks for a newer engine without naming the minimum version', () => {
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

    expect(banner.textContent).toContain('This app needs a newer engine.')
    expect(banner.textContent).not.toMatch(ENGINE_VERSION)
  })

  it('still names the APEX version an engine update waits for (hc-475), and no engine version', () => {
    // desktopUpgradeRequired.minDesktopVersion is the APEX app's own semver ("0.17.0"),
    // the one kind of version update copy may name.
    $runtimeUpdateCheck.set({
      ok: true,
      updateAvailable: false,
      current: { version: 'v2026.7.15-fork.b21a7e0d', key: 'b21a7e0d' },
      latest: { version: 'v2026.8.1-fork.deadbeef', key: 'deadbeef', compatibilityNotes: null },
      desktopUpgradeRequired: { minDesktopVersion: '0.17.0', currentDesktopVersion: '0.16.17' }
    })

    const { container } = render(<EngineUpdateSection />)

    expect(screen.getByText('Update your desktop app to v0.17.0 or later to install this engine.')).toBeTruthy()
    expect(container.textContent).not.toMatch(ENGINE_VERSION)
  })
})
