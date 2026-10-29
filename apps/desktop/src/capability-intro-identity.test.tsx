/**
 * hc-1108 identity guard (hard rule 11): what 首启能力介绍 must leave alone.
 *
 * `__identity__/capability-intro/thread-empty-developer.html` was recorded on
 * fork main 91b2f71eaf, before any hc-1108 code was written: the empty
 * conversation in developer mode, with single_thread on and the account intake
 * still at card 1. Developer mode never shows the first open, so nothing there
 * may move. A diff here means the change reached developer mode: fix the code,
 * do not re-record the golden.
 */
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import type { DesktopCreatorProfile } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $creatorProfile } from '@/store/creator-profile'
import { resetDailyIdeasForTest } from '@/store/daily-ideas'
import { $mainThread, resetMainThreadForTest } from '@/store/main-thread'
import { $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/capability-intro'

function normalized(html: string): string {
  return html
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
    .replace(/data-placeholder="[^"]*"/g, 'data-placeholder="«rotating»"')
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

/** A cloud whose intake is still at card 1; the switch is on in the platform config. */
function installCloud() {
  const profile: DesktopCreatorProfile = {
    answers: { contentType: null, contentTypeOther: null, painPoint: null, platforms: [] },
    intake: { completed: false, nextStep: 'content_type', skipped: [] }
  }

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
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
})

describe('hc-1108: developer mode is the empty conversation it was', () => {
  it('single_thread on, developer mode, intake at card 1', async () => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('technical')

    const container = await renderEmptyThread()

    await expect(normalized(container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/thread-empty-developer.html`)
  })

  it('control: the same render in product mode does show the first open', async () => {
    setSingleThreadFlagForTest(true)

    const container = await renderEmptyThread()

    expect(container.querySelector('[data-single-thread-empty]')).not.toBeNull()
  })
})
