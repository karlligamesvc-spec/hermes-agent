// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $chatcutFlag, setChatcutFlagForTest } from '@/store/chatcut'
import {
  $realProfilePromptClaim,
  $realProfilePromptDismissed,
  $realProfilePromptMuted
} from '@/store/real-profile-consent'

import { RealProfileConsentDialog } from './real-profile-consent-dialog'

const mocks = vi.hoisted(() => ({
  cache: vi.fn(),
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
  useHermesConfigRecord: () => ({ data: mocks.loadedConfig })
}))

describe('RealProfileConsentDialog', () => {
  beforeEach(() => {
    mocks.loadedConfig = { browser: { allow_private_urls: false }, model: { provider: 'nous' } }
    mocks.save.mockResolvedValue({ ok: true })
    $realProfilePromptDismissed.set(false)
    $realProfilePromptMuted.set(false)
    $realProfilePromptClaim.set(null)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    setChatcutFlagForTest(false)
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  describe('hc-1122 over ChatCut’s editor', () => {
    const EDITOR = 'https://app.chatcut.io/editor/p-1'

    const shown = async (switchOn: boolean) => {
      ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
        clientConfig: { get: async () => ({ payload: { desktop_features: { chatcut: switchOn } } }) }
      }
      render(<RealProfileConsentDialog tabId="tab-1" url={EDITOR} />)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
      })

      return screen.queryByText(promptCopy.title) !== null
    }

    it('switch on: no offer on top of the editor', async () => {
      await expect(shown(true)).resolves.toBe(false)
      expect($chatcutFlag.get()).toBe(true)
    })

    it('switch off: the editor’s tab is like any other, once the switch is read', async () => {
      await expect(shown(false)).resolves.toBe(true)
    })

    it('switch on: every other tab keeps the offer, and does not even read the switch', async () => {
      setChatcutFlagForTest(true)

      const get = vi.fn()

      ;(window as { hermesDesktop?: unknown }).hermesDesktop = { clientConfig: { get } }
      render(<RealProfileConsentDialog tabId="tab-1" url="https://example.com/" />)

      expect(screen.queryByText(promptCopy.title)).not.toBeNull()
      expect(get).not.toHaveBeenCalled()
    })

    it('a look-alike host is not the editor', async () => {
      setChatcutFlagForTest(true)
      render(<RealProfileConsentDialog tabId="tab-1" url="https://app.chatcut.io.example.com/editor/p-1" />)

      expect(screen.queryByText(promptCopy.title)).not.toBeNull()
    })
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
})
