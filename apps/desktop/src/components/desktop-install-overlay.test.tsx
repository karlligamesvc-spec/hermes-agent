import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { DesktopBootstrapEvent, DesktopBootstrapStageDescriptor, DesktopBootstrapState } from '@/global'
import { $desktopUpdateProgress } from '@/store/desktop-update'

import { DesktopInstallOverlay } from './desktop-install-overlay'

// Regression coverage for the three pieces of install-overlay copy that the
// v0.19.0 upstream rewrite dropped while restyling this component (hc-589 leg
// 8b): the update-vs-first-install title/desc split (hc-452), the localized
// skip reason (hc-569), and the pending-stage duration hint (hc-452). The
// electron side (bootstrap-runner.ts / main.ts) never stopped sending
// updateInfo -- only the renderer's consumption of it went missing, so these
// tests drive the overlay purely through the same window.hermesDesktop events
// main.ts already emits in production.

const EMPTY_STATE: DesktopBootstrapState = {
  active: false,
  manifest: null,
  stages: {},
  error: null,
  log: [],
  startedAt: null,
  completedAt: null,
  setupChoice: null,
  unsupportedPlatform: null
}

const STAGES: DesktopBootstrapStageDescriptor[] = [{ name: 'prerequisites' }, { name: 'venv' }, { name: 'node-deps' }]

// Mirrors boot-failure-overlay.test.tsx's stubDesktop -- Object.defineProperty
// (not a direct `window.hermesDesktop =` assignment) so the stub only needs to
// implement the two IPC methods this overlay actually calls, not the full
// hermesDesktop surface.
function stubDesktop() {
  let emit: ((ev: DesktopBootstrapEvent) => void) | null = null
  const original = window.hermesDesktop

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      getBootstrapState: async () => EMPTY_STATE,
      onBootstrapEvent: (callback: (ev: DesktopBootstrapEvent) => void) => {
        emit = callback

        return () => {
          emit = null
        }
      }
    }
  })

  return {
    emit: (ev: DesktopBootstrapEvent) => {
      if (!emit) {
        throw new Error('onBootstrapEvent callback was never registered')
      }

      act(() => emit?.(ev))
    },
    restore: () => Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
  }
}

afterEach(() => {
  cleanup()
  $desktopUpdateProgress.set({
    active: false,
    completedStages: [],
    currentStage: null,
    error: null,
    runtimeProgress: null,
    stages: [],
    targetVersion: null
  })
})

describe('DesktopInstallOverlay update-vs-install copy (hc-452 / hc-569 restoration)', () => {
  it('shows the update copy -- not the first-install copy -- when the manifest carries updateInfo', async () => {
    const desktop = stubDesktop()

    try {
      render(<DesktopInstallOverlay />)
      // Let the initial getBootstrapState() snapshot resolve before driving a
      // live event, so the event (not the empty initial snapshot) decides the
      // final render.
      await act(async () => {})

      desktop.emit({
        type: 'manifest',
        stages: STAGES,
        protocolVersion: 1,
        updateInfo: { isUpdate: true, toVersion: '0.17.0', fromVersion: '0.16.17' }
      })

      expect(await screen.findByText('Updating to 0.17.0')).toBeTruthy()
      expect(screen.getByText(/Unchanged dependencies are skipped automatically/)).toBeTruthy()
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
      expect(screen.queryByText('Setting up APEX')).toBeNull()
      expect(screen.queryByText(/This is a one-time setup/)).toBeNull()
    } finally {
      desktop.restore()
    }
  })

  it('reuses the install progress surface for one app + engine update', async () => {
    const desktop = stubDesktop()

    try {
      $desktopUpdateProgress.set({
        active: true,
        completedStages: ['check', 'shell'],
        currentStage: 'runtime',
        error: null,
        runtimeProgress: { attempt: 1, phase: 'downloading', received: 512 * 1024 * 1024, total: 1024 * 1024 * 1024 },
        stages: ['check', 'shell', 'runtime', 'restart'],
        targetVersion: 'v2026.8.8-fork.abc123'
      })

      render(<DesktopInstallOverlay />)
      await act(async () => {})

      expect(screen.getByText('Updating to Engine 2026.8.8')).toBeTruthy()
      expect(screen.getByText('Check updates')).toBeTruthy()
      expect(screen.getByText('App package')).toBeTruthy()
      expect(screen.getByText('AI engine')).toBeTruthy()
      expect(screen.getByText('Restart APEX')).toBeTruthy()
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('63')
      expect(screen.getByText('512 MB / 1.0 GB')).toBeTruthy()
    } finally {
      desktop.restore()
    }
  })

  it('uses indeterminate progress when verify/activate has no trustworthy percentage', async () => {
    const desktop = stubDesktop()

    try {
      $desktopUpdateProgress.set({
        active: true,
        completedStages: ['check', 'shell'],
        currentStage: 'runtime',
        error: null,
        runtimeProgress: { phase: 'verifying' },
        stages: ['check', 'shell', 'runtime', 'restart'],
        targetVersion: 'v2026.8.8-fork.abc123'
      })

      render(<DesktopInstallOverlay />)
      await act(async () => {})

      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
      expect(screen.queryByText(/%$/)).toBeNull()
    } finally {
      desktop.restore()
    }
  })

  // hc-591: Kael flagged the update overlay reading "正在更新到
  // v2026.7.25-fork.b0a720a5" -- the internal engine pin's `-fork.<sha>`
  // segment must never reach this title/desc. Distinct from the test above
  // (which uses a desktop-semver-shaped '0.17.0' placeholder that never had a
  // `-fork.` segment to begin with): this drives the overlay with the actual
  // calver+fork shape the bootstrap stamp really produces.
  it('humanizes the internal engine pin in the update title and description (hc-591)', async () => {
    const desktop = stubDesktop()

    try {
      const { container } = render(<DesktopInstallOverlay />)
      await act(async () => {})

      desktop.emit({
        type: 'manifest',
        stages: STAGES,
        protocolVersion: 1,
        updateInfo: { isUpdate: true, toVersion: 'v2026.7.25-fork.b0a720a5', fromVersion: 'v2026.7.15-fork.b21a7e0d' }
      })

      expect(await screen.findByText('Updating to Engine 2026.7.25')).toBeTruthy()
      expect(screen.getByText(/^Updating to Engine 2026\.7\.25\. Unchanged dependencies/)).toBeTruthy()
      expect(container.textContent).not.toContain('-fork.')
      expect(container.textContent).not.toContain('b0a720a5')
    } finally {
      desktop.restore()
    }
  })

  it('falls back to the first-install copy when a manifest event omits updateInfo', async () => {
    const desktop = stubDesktop()

    try {
      render(<DesktopInstallOverlay />)
      await act(async () => {})

      // No `updateInfo` field at all -- the real-world shape of an older main
      // build that predates this field. DEFAULT_UPDATE_INFO must fail open to
      // "not an update" rather than crash or mislabel the row.
      desktop.emit({ type: 'manifest', stages: STAGES, protocolVersion: 1 })

      expect(await screen.findByText('Setting up APEX')).toBeTruthy()
      expect(screen.getByText(/This is a one-time setup/)).toBeTruthy()
      expect(screen.queryByText(/^Updating/)).toBeNull()
    } finally {
      desktop.restore()
    }
  })

  it('labels a skipped stage with the localized skip reason and an explicit "Skipped" duration', async () => {
    const desktop = stubDesktop()

    try {
      render(<DesktopInstallOverlay />)
      await act(async () => {})

      desktop.emit({ type: 'manifest', stages: STAGES, protocolVersion: 1 })
      desktop.emit({
        type: 'stage',
        name: 'venv',
        state: 'skipped',
        durationMs: 12,
        json: { ok: true, skipped: true, skip_code: 'deps_unchanged', stage: 'venv' }
      })

      // The localized reason ("dependencies unchanged"), not the raw skip_code.
      expect(await screen.findByText('dependencies unchanged')).toBeTruthy()
      // Explicitly labeled "Skipped · 12 ms" -- never bare "12 ms", which would
      // read as a stage that actually ran.
      expect(screen.getByText('Skipped · 12 ms')).toBeTruthy()
    } finally {
      desktop.restore()
    }
  })

  it('shows a duration hint next to a still-pending stage', async () => {
    const desktop = stubDesktop()

    try {
      render(<DesktopInstallOverlay />)
      await act(async () => {})

      desktop.emit({ type: 'manifest', stages: STAGES, protocolVersion: 1 })

      // node-deps hasn't started (still 'pending') -- the hint fills the slot
      // that would otherwise be blank until the stage starts.
      expect(await screen.findByText('~45s')).toBeTruthy()
    } finally {
      desktop.restore()
    }
  })
})
