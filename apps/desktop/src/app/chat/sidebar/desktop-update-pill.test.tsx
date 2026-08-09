// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeUpdateCheck, DesktopShellUpdateState } from '@/global'

vi.mock('@/store/desktop-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $desktopUpdateProgress: atom({
      active: false,
      completedStages: [],
      currentStage: null,
      error: null,
      stages: [],
      targetVersion: null
    }),
    applyDesktopUpdates: vi.fn()
  }
})

import { $runtimeUpdateCheck } from '@/store/runtime-update'
import { $shellUpdate } from '@/store/shell-update'

import { DesktopUpdatePill } from './desktop-update-pill'

const RUNTIME_UPDATE: DesktopRuntimeUpdateCheck = {
  current: { key: 'old', version: 'v2026.7.1' },
  latest: { compatibilityNotes: null, key: 'new', version: 'v2026.8.8-fork.abc' },
  ok: true,
  updateAvailable: true
}

const SHELL_UPDATE: DesktopShellUpdateState = {
  error: null,
  percent: 100,
  phase: 'downloaded',
  releaseNotes: null,
  version: '0.18.0'
}

beforeEach(() => {
  $runtimeUpdateCheck.set(null)
  $shellUpdate.set(null)
})

afterEach(() => cleanup())

describe('DesktopUpdatePill', () => {
  it('shows app and runtime in one ready entry with one action', () => {
    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    $shellUpdate.set(SHELL_UPDATE)
    render(<DesktopUpdatePill />)

    expect(screen.getByTestId('desktop-update-pill')).toBeTruthy()
    expect(screen.getByText('APEX update is ready')).toBeTruthy()
    expect(screen.getByText('App v0.18.0 + Engine 2026.8.8')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button').textContent).toContain('Install and restart')
  })

  it('reuses the same entry for shell download progress and offers no premature action', () => {
    $shellUpdate.set({ ...SHELL_UPDATE, percent: 42.6, phase: 'downloading' })
    render(<DesktopUpdatePill />)

    expect(screen.getByText('Preparing APEX v0.18.0')).toBeTruthy()
    expect(screen.getByText('43% downloaded')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
