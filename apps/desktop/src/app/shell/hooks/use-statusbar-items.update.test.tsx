import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'
import { setConnection } from '@/store/session'
import { $desktopVersion, $updateOverlayOpen, $updateStatus } from '@/store/updates'

import { useStatusbarItems } from './use-statusbar-items'

vi.mock('@/hermes', async importOriginal => ({
  ...await importOriginal<typeof Hermes>(),
  checkHermesUpdate: vi.fn(async () => ({ can_apply: true, current_version: 'remote-engine', update_available: false }))
}))

afterEach(() => {
  cleanup()
  $desktopVersion.set(null)
  $updateStatus.set(null)
  $updateOverlayOpen.set(false)
})

describe('installed APEX version entry', () => {
  it.each(['local', 'remote'] as const)('opens this app’s update center in %s mode without the Git updater', mode => {
    setConnection({
      baseUrl: 'http://localhost:9119', isFullscreen: false, logs: [], mode,
      nativeOverlayWidth: 0, token: 'test', windowButtonPosition: null, wsUrl: 'ws://localhost:9119'
    })
    $desktopVersion.set({ appVersion: '0.17.43', electronVersion: '', engineVersion: '', hermesRoot: '/bundle/without-git', nodeVersion: '', platform: 'darwin' })
    $updateStatus.set({ supported: false, reason: 'not-a-git-checkout' })
    $updateOverlayOpen.set(false)
    const openCommandCenterSection = vi.fn()

    const { result, rerender } = renderHook(({ open }) => useStatusbarItems({
      agentsOpen: false, chatOpen: false, commandCenterOpen: false, extraLeftItems: [], extraRightItems: [],
      freshDraftReady: true, gatewayState: 'closed', inferenceStatus: null, openAgents: vi.fn(),
      openCommandCenterSection: open, requestGateway: vi.fn(), statusSnapshot: null, toggleCommandCenter: vi.fn()
    }), { initialProps: { open: openCommandCenterSection } })

    act(() => result.current.statusbarItems.find(item => item.id === 'version-client')!.onSelect!({ shiftKey: false }))
    expect(openCommandCenterSection).toHaveBeenCalledWith('system')
    expect($updateOverlayOpen.get()).toBe(false)

    const nextOpen = vi.fn()
    rerender({ open: nextOpen })
    act(() => result.current.statusbarItems.find(item => item.id === 'version-client')!.onSelect!({ shiftKey: false }))
    expect(nextOpen).toHaveBeenCalledWith('system')
    expect(openCommandCenterSection).toHaveBeenCalledTimes(1)
  })

  it('keeps the separately named remote backend entry on its own updater', () => {
    setConnection({
      baseUrl: 'http://localhost:9119', isFullscreen: false, logs: [], mode: 'remote',
      nativeOverlayWidth: 0, token: 'test', windowButtonPosition: null, wsUrl: 'ws://localhost:9119'
    })
    const open = vi.fn()

    const { result } = renderHook(() => useStatusbarItems({
      agentsOpen: false, chatOpen: false, commandCenterOpen: false, extraLeftItems: [], extraRightItems: [],
      freshDraftReady: true, gatewayState: 'closed', inferenceStatus: null, openAgents: vi.fn(),
      openCommandCenterSection: open, requestGateway: vi.fn(), statusSnapshot: null, toggleCommandCenter: vi.fn()
    }))

    act(() => result.current.statusbarItems.find(item => item.id === 'version-backend')!.onSelect!({ shiftKey: false }))
    expect(open).not.toHaveBeenCalled()
    expect($updateOverlayOpen.get()).toBe(true)
  })
})
