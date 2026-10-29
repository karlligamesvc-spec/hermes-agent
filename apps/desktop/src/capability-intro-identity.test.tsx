/**
 * hc-1108 identity guard (hard rule 11): what 首启能力介绍 must leave alone.
 *
 * `__identity__/capability-intro/thread-empty-developer.html` was recorded on
 * fork main 91b2f71eaf, before any hc-1108 code was written: the empty
 * conversation in developer mode, with single_thread on and the account intake
 * still at card 1. Developer mode never shows the first open, so nothing there
 * may move. A diff here means the change reached developer mode: fix the code,
 * do not re-record the golden.
 *
 * With the switch on, product mode must also stay exactly hc-1063's first open
 * everywhere but the screen where the third card was just answered: the intake
 * still at card 1, and an intake finished before this window (someone upgrading),
 * render the goldens under `__identity__/single-thread-first-open/` byte for
 * byte. The switch off is single-thread-first-open-identity.test.tsx itself.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SingleThreadEmptyState } from '@/app/single-thread/thread-empty'
import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import type { DesktopCreatorProfile } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $capabilityIntroFlag, resetCapabilityIntroForTest } from '@/store/capability-intro'
import { $creatorProfile } from '@/store/creator-profile'
import { resetDailyIdeasForTest } from '@/store/daily-ideas'
import { $mainThread, resetMainThreadForTest } from '@/store/main-thread'
import { $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/capability-intro'
const FIRST_OPEN_GOLDEN = './__identity__/single-thread-first-open'

function normalized(html: string): string {
  return html
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
    .replace(/data-placeholder="[^"]*"/g, 'data-placeholder="«rotating»"')
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

const AT_CARD_1: DesktopCreatorProfile = {
  answers: { contentType: null, contentTypeOther: null, painPoint: null, platforms: [] },
  intake: { completed: false, nextStep: 'content_type', skipped: [] }
}

/** The answers single-thread-first-open-identity.test.tsx recorded its finished golden with. */
const FINISHED_BEFORE: DesktopCreatorProfile = {
  answers: { contentType: 'product_review', contentTypeOther: null, painPoint: 'no_topic', platforms: ['douyin'] },
  intake: { completed: true, nextStep: null, skipped: [] }
}

/** A cloud with the intake as `profile` says; the switch is on in the platform config. */
function installCloud(profile: DesktopCreatorProfile = AT_CARD_1) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    clientConfig: {
      get: async () => ({ payload: { desktop_features: { capability_intro: true, single_thread: true } } })
    },
    imEntry: { list: async () => ({ channels: [] }) },
    managed: { creatorProfile: async () => ({ ok: true, profile }) },
    readClipboard: async () => ''
  }
}

async function renderEmptyThread() {
  const view = render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={[]}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    </MemoryRouter>
  )

  await settle()

  return view.container
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  resetMainThreadForTest()
  resetDailyIdeasForTest()
  $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
  $gatewayState.set('open')
  $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })
  $authState.set({
    account: { email: 'a@example.test', name: '小满', plan: 'free' },
    accountId: 'acc-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
  installCloud()
})

afterEach(() => {
  cleanup()
  resetCapabilityIntroForTest()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
})

describe('hc-1108: developer mode is the empty conversation it was', () => {
  it('single_thread on, developer mode, intake at card 1', async () => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('technical')
    $capabilityIntroFlag.set(true)

    const container = await renderEmptyThread()

    await expect(normalized(container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/thread-empty-developer.html`)
  })

  it('control: the same render in product mode does show the first open', async () => {
    setSingleThreadFlagForTest(true)

    const container = await renderEmptyThread()

    expect(container.querySelector('[data-single-thread-empty]')).not.toBeNull()
  })
})

describe('hc-1108 on: product mode is hc-1063’s first open everywhere else', () => {
  function renderEmptyState() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <SingleThreadEmptyState />
        </I18nProvider>
      </MemoryRouter>
    )
  }

  it('the intake at card 1', async () => {
    const { container } = renderEmptyState()

    await waitFor(() => expect(container.querySelector('[data-first-open-card="content_type"]')).not.toBeNull())
    await settle()

    expect($capabilityIntroFlag.get()).toBe(true)
    await expect(normalized(container.innerHTML)).toMatchFileSnapshot(`${FIRST_OPEN_GOLDEN}/intake-open.html`)
  })

  it('the intake finished before this window: no intro, the whole tip', async () => {
    installCloud(FINISHED_BEFORE)
    $capabilityIntroFlag.set(true)
    const { container } = renderEmptyState()

    await waitFor(() => expect(container.querySelector('[data-first-open-tip]')).not.toBeNull())
    await settle()

    await expect(normalized(container.innerHTML)).toMatchFileSnapshot(`${FIRST_OPEN_GOLDEN}/intake-finished.html`)
  })
})
