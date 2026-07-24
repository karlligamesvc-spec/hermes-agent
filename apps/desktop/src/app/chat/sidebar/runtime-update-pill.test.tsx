// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeUpdateApply, DesktopRuntimeUpdateCheck } from '@/global'

const applyRuntimeUpdateMock = vi.fn<() => Promise<DesktopRuntimeUpdateApply>>()
const checkRuntimeUpdateMock = vi.fn<() => Promise<DesktopRuntimeUpdateCheck>>()

// Real nanostores atoms behind the mocked store module, so useStore-driven
// re-renders behave exactly like production; only the IPC-backed actions are
// stubbed. The arrow wrappers dereference the vi.fn consts at call time (the
// hoisted factory itself runs before those consts initialize).
vi.mock('@/store/runtime-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $runtimeUpdateApplying: atom(false),
    $runtimeUpdateCheck: atom<DesktopRuntimeUpdateCheck | null>(null),
    $runtimeUpdateChecking: atom(false),
    $runtimeVersion: atom(null),
    applyRuntimeUpdate: () => applyRuntimeUpdateMock(),
    checkRuntimeUpdate: () => checkRuntimeUpdateMock(),
    loadRuntimeVersion: vi.fn()
  }
})

import { $runtimeUpdateApplying, $runtimeUpdateCheck } from '@/store/runtime-update'
// 壳更新 store 用真模块:没有 hermesDesktop 桥时它是惰性的,atom 直接可写。
import { $shellUpdate } from '@/store/shell-update'

import { RuntimeUpdatePill } from './runtime-update-pill'

const UPDATE_AVAILABLE: DesktopRuntimeUpdateCheck = {
  current: { key: 'aaaa1111', version: 'v2026.6.25' },
  latest: { compatibilityNotes: null, key: 'bbbb2222', version: 'v2026.7.1' },
  ok: true,
  updateAvailable: true
}

beforeEach(() => {
  applyRuntimeUpdateMock.mockReset()
  checkRuntimeUpdateMock.mockReset()
  checkRuntimeUpdateMock.mockResolvedValue(UPDATE_AVAILABLE)
  $runtimeUpdateCheck.set(null)
  $runtimeUpdateApplying.set(false)
  $shellUpdate.set(null)
})

afterEach(() => {
  cleanup()
})

describe('RuntimeUpdatePill', () => {
  it('renders nothing before any check and when already up to date', () => {
    const { container } = render(<RuntimeUpdatePill />)

    expect(container.firstChild).toBeNull()

    // A completed check that found nothing keeps the sidebar clean too.
    $runtimeUpdateCheck.set({
      current: { key: 'aaaa1111', version: 'v2026.6.25' },
      latest: null,
      ok: true,
      updateAvailable: false
    })

    expect(container.firstChild).toBeNull()
  })

  it('yields to the shell-update pill while a shell update is downloaded', () => {
    // 壳胶囊优先:壳包就绪时引擎 offer 让位(壳更新通常带引擎 pin bump)。
    $runtimeUpdateCheck.set(UPDATE_AVAILABLE)
    $shellUpdate.set({ error: null, percent: 100, phase: 'downloaded', releaseNotes: null, version: '0.16.1' })

    const { container } = render(<RuntimeUpdatePill />)

    expect(container.firstChild).toBeNull()

    // 壳侧解除(装完/回落)后 offer 立刻回来,不需要新一轮检查。
    act(() => {
      $shellUpdate.set(null)
    })

    expect(screen.getByText('New engine available')).toBeTruthy()
  })

  it('shows the offer copy and the new version when an update is available', () => {
    $runtimeUpdateCheck.set(UPDATE_AVAILABLE)
    render(<RuntimeUpdatePill />)

    const button = screen.getByRole('button')

    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('New engine available')).toBeTruthy()
    expect(screen.getByText('v2026.7.1')).toBeTruthy()
  })

  it('applies the update on click and refreshes the check when no reload is required', async () => {
    applyRuntimeUpdateMock.mockResolvedValue({ alreadyCurrent: true, applied: false, ok: true, reloadRequired: false })
    $runtimeUpdateCheck.set(UPDATE_AVAILABLE)
    render(<RuntimeUpdatePill />)

    fireEvent.click(screen.getByRole('button'))

    expect(applyRuntimeUpdateMock).toHaveBeenCalledTimes(1)
    // Stale offer (already current) → the pill silently re-checks so it can
    // drop the capsule instead of re-offering a no-op update.
    await waitFor(() => expect(checkRuntimeUpdateMock).toHaveBeenCalledTimes(1))
  })

  it('disables the pill and shows progress copy while applying', () => {
    $runtimeUpdateCheck.set(UPDATE_AVAILABLE)
    $runtimeUpdateApplying.set(true)
    render(<RuntimeUpdatePill />)

    const button = screen.getByRole('button') as HTMLButtonElement

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('data-state')).toBe('applying')
    expect(screen.getByText('Updating engine…')).toBeTruthy()
    expect(button.querySelector('.animate-spin')).toBeTruthy()

    fireEvent.click(button)

    expect(applyRuntimeUpdateMock).not.toHaveBeenCalled()
  })

  it('shows the rolled-back notice on a failed apply and ignores clicks meanwhile', async () => {
    applyRuntimeUpdateMock.mockRejectedValue(new Error('update_artifact_unreachable'))
    $runtimeUpdateCheck.set(UPDATE_AVAILABLE)
    render(<RuntimeUpdatePill />)

    fireEvent.click(screen.getByRole('button'))

    expect(await screen.findByText('Update failed, rolled back')).toBeTruthy()
    expect(screen.getByRole('button').getAttribute('data-state')).toBe('error')

    // While the failure notice is up the pill ignores further clicks (the
    // notice auto-expires back to the regular offer on its own timer).
    fireEvent.click(screen.getByRole('button'))

    expect(applyRuntimeUpdateMock).toHaveBeenCalledTimes(1)
  })
})
