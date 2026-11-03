// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $realProfilePromptClaim,
  $realProfilePromptDismissed,
  $realProfilePromptMuted
} from '@/store/real-profile-consent'
import { setSingleThreadFlagForTest, SINGLE_THREAD_HINT_KEY } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { RealProfileConsentDialog } from './real-profile-consent-dialog'

const mocks = vi.hoisted(() => ({
  cache: vi.fn(),
  configRead: vi.fn(),
  loadedConfig: {} as Record<string, unknown> | undefined,
  notify: vi.fn(),
  notifyError: vi.fn(),
  save: vi.fn()
}))

vi.mock('@/hermes', () => ({
  saveHermesConfigRecord: (config: Record<string, unknown>, profile?: unknown) => mocks.save(config, profile)
}))

const promptCopy = {
  title: 'Stay signed in to your sites',
  body: 'Let Hermes browse with a snapshot of your default browser profile.',
  bulletSnapshot: 'Cookies and logins are copied into a managed snapshot.',
  bulletLiveProfile: 'Your live browser profile is never opened directly.',
  bulletLocal: 'Nothing leaves this computer.',
  dontShowAgain: "Don't show again",
  notNow: 'Not now',
  enable: 'Use my profile'
}

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { close: 'Close' },
      settings: {
        toolsets: {
          browserRealProfile: {
            enabledTitle: 'Real-profile browsing on',
            enabledMessage: 'New sessions use the snapshot.',
            failedSave: 'Could not save the real-profile setting',
            prompt: promptCopy
          }
        }
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => mocks.notify(...args),
  notifyError: (...args: unknown[]) => mocks.notifyError(...args)
}))

vi.mock('../../hooks/use-config-record', () => ({
  hermesConfigCacheWriter: () => (config: Record<string, unknown>) => mocks.cache(config),
  useHermesConfigRecord: () => {
    mocks.configRead()

    return { data: mocks.loadedConfig }
  }
}))

describe('RealProfileConsentDialog', () => {
  beforeEach(() => {
    mocks.loadedConfig = { browser: { allow_private_urls: false }, model: { provider: 'nous' } }
    mocks.save.mockResolvedValue({ ok: true })
    $realProfilePromptDismissed.set(false)
    $realProfilePromptMuted.set(false)
    $realProfilePromptClaim.set(null)
    setSingleThreadFlagForTest(false)
    setToolViewMode('product')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows when the feature is off and accepting writes browser.use_real_profile', async () => {
    render(<RealProfileConsentDialog tabId="tab-1" />)

    expect(screen.getByText(promptCopy.title)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: promptCopy.enable }))
    })

    // Saves ONLY the toggled key (PUT deep-merges) — the same shape the
    // Capabilities toggle writes — while the shared cache gets the merged
    // record so the existing toggle flips on without a refetch.
    expect(mocks.save).toHaveBeenCalledWith({ browser: { use_real_profile: true } }, undefined)
    expect(mocks.cache).toHaveBeenCalledWith({
      browser: { allow_private_urls: false, use_real_profile: true },
      model: { provider: 'nous' }
    })
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('does not show when real-profile browsing is already on', () => {
    mocks.loadedConfig = { browser: { use_real_profile: true } }
    render(<RealProfileConsentDialog tabId="tab-1" />)

    expect(screen.queryByText(promptCopy.title)).toBeNull()
  })

  it('does not show before the config record loads', () => {
    mocks.loadedConfig = undefined
    render(<RealProfileConsentDialog tabId="tab-1" />)

    expect(screen.queryByText(promptCopy.title)).toBeNull()
  })

  it('"Not now" mutes for the app run without persisting the opt-out', () => {
    render(<RealProfileConsentDialog tabId="tab-1" />)

    fireEvent.click(screen.getByRole('button', { name: promptCopy.notNow }))

    expect(screen.queryByText(promptCopy.title)).toBeNull()
    expect($realProfilePromptMuted.get()).toBe(true)
    expect($realProfilePromptDismissed.get()).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('"Don\'t show again" persists the opt-out', () => {
    render(<RealProfileConsentDialog tabId="tab-1" />)

    fireEvent.click(screen.getByRole('button', { name: promptCopy.dontShowAgain }))

    expect(screen.queryByText(promptCopy.title)).toBeNull()
    expect($realProfilePromptDismissed.get()).toBe(true)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('only the claiming pane renders the dialog when several Browser panes mount', () => {
    render(
      <>
        <RealProfileConsentDialog tabId="tab-1" />
        <RealProfileConsentDialog tabId="tab-2" />
      </>
    )

    expect(screen.getAllByText(promptCopy.title)).toHaveLength(1)
    expect($realProfilePromptClaim.get()).toBe('tab-1')
  })

  it('rolls the optimistic cache write back when the save fails', async () => {
    mocks.save.mockRejectedValue(new Error('boom'))
    render(<RealProfileConsentDialog tabId="tab-1" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: promptCopy.enable }))
    })

    expect(mocks.cache).toHaveBeenLastCalledWith(mocks.loadedConfig)
    expect(mocks.notifyError).toHaveBeenCalled()
  })

  describe('in product mode (hc-1132)', () => {
    beforeEach(() => {
      setSingleThreadFlagForTest(true)
      setToolViewMode('product')
    })

    it('offers nothing: no dialog, no config read, no claim, no write', () => {
      render(<RealProfileConsentDialog tabId="tab-1" />)

      expect(screen.queryByText(promptCopy.title)).toBeNull()
      expect(mocks.configRead).not.toHaveBeenCalled()
      expect($realProfilePromptClaim.get()).toBeNull()
      expect(mocks.save).not.toHaveBeenCalled()
    })

    it('comes back with developer mode and goes away again with product mode', () => {
      render(<RealProfileConsentDialog tabId="tab-1" />)
      expect(screen.queryByText(promptCopy.title)).toBeNull()

      act(() => setToolViewMode('technical'))

      expect(screen.getByText(promptCopy.title)).toBeTruthy()
      expect($realProfilePromptClaim.get()).toBe('tab-1')

      act(() => setToolViewMode('product'))

      expect(screen.queryByText(promptCopy.title)).toBeNull()
      expect($realProfilePromptClaim.get()).toBeNull()
    })
  })

  // `?win=browser` is its own renderer: its stores start from what the primary window left in storage, before any
  // client-config read has answered, and the dialog must already be right on that first paint.
  describe('a popped-out Browser window, a fresh renderer (hc-1132)', () => {
    const search = window.location.search

    beforeEach(() => {
      window.history.replaceState(null, '', '?win=browser&tab=tab-1')
      window.localStorage.clear()
      vi.resetModules()
      Object.defineProperty(window, 'hermesDesktop', {
        configurable: true,
        value: { clientConfig: { get: () => new Promise(() => undefined), onLate: () => () => undefined } }
      })
    })

    afterEach(() => {
      window.history.replaceState(null, '', search || '/')
      Reflect.deleteProperty(window, 'hermesDesktop')
    })

    async function freshRenderer() {
      const dialog = await import('./real-profile-consent-dialog')
      const windows = await import('@/store/windows')

      expect(windows.isBrowserWindow()).toBe(true)

      return dialog.RealProfileConsentDialog
    }

    it('offers nothing when the primary window settled product mode', async () => {
      window.localStorage.setItem(SINGLE_THREAD_HINT_KEY, 'true')
      const Dialog = await freshRenderer()

      render(<Dialog tabId="tab-1" />)

      expect(screen.queryByText(promptCopy.title)).toBeNull()
      expect(mocks.configRead).not.toHaveBeenCalled()
    })

    it('still offers in developer mode', async () => {
      window.localStorage.setItem(SINGLE_THREAD_HINT_KEY, 'true')
      window.localStorage.setItem('hermes.desktop.toolView.technical', 'true')
      const Dialog = await freshRenderer()

      render(<Dialog tabId="tab-1" />)

      expect(screen.getByText(promptCopy.title)).toBeTruthy()
    })

    it('still offers with the switch off', async () => {
      const Dialog = await freshRenderer()

      render(<Dialog tabId="tab-1" />)

      expect(screen.getByText(promptCopy.title)).toBeTruthy()
    })
  })
})
