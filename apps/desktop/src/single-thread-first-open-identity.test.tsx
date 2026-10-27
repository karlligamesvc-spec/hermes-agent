/**
 * hc-1079 identity guard (hard rule 11): APEX's own 第一次打开 stays exactly
 * what hc-1063 drew while new assistants get their three questions.
 *
 * The goldens under `__identity__/single-thread-first-open/` were recorded on
 * fork main 50a50d1bf7, before any hc-1079 code was written: the empty single
 * thread of the default profile with the account intake at card 1, with all
 * three cards answered here (the 「APEX 记下了」 line), and with the intake
 * already finished (the closing tip). A diff here means APEX's path moved:
 * fix the code, do not re-record the golden.
 *
 * The same three goldens hold with `multi_bot` on and APEX on screen, and with
 * the switch off while another profile is active (one made in developer mode):
 * only an assistant made next to APEX, with several on, asks other questions.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SingleThreadEmptyState } from '@/app/single-thread/thread-empty'
import type { DesktopCreatorProfile, DesktopCreatorProfileRequest, DesktopCreatorProfileResult } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $creatorProfile } from '@/store/creator-profile'
import { resetDailyIdeasForTest } from '@/store/daily-ideas'
import { $mainThread, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'

const GOLDEN = './__identity__/single-thread-first-open'

function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

/** The cloud's creator profile, answered as `answers` says; finished once all three are. */
function installCloud(answers: Partial<DesktopCreatorProfile['answers']> = {}) {
  const state: DesktopCreatorProfile['answers'] = {
    contentType: null,
    contentTypeOther: null,
    painPoint: null,
    platforms: [],
    ...answers
  }

  const profile = (): DesktopCreatorProfile => {
    const pending = (['content_type', 'platforms', 'pain_point'] as const).filter(step =>
      step === 'content_type' ? !state.contentType : step === 'platforms' ? !state.platforms.length : !state.painPoint
    )

    return {
      answers: { ...state, platforms: [...state.platforms] },
      intake: { completed: pending.length === 0, nextStep: pending[0] ?? null, skipped: [] }
    }
  }

  const creatorProfile = async (request: DesktopCreatorProfileRequest): Promise<DesktopCreatorProfileResult> => {
    if (request.action === 'save') {
      const { patch } = request

      if ('contentType' in patch) {
        state.contentType = patch.contentType ?? null
      }

      if ('platforms' in patch) {
        state.platforms = patch.platforms ?? []
      }

      if ('painPoint' in patch) {
        state.painPoint = patch.painPoint ?? null
      }
    }

    return { ok: true, profile: profile() }
  }

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    clientConfig: { get: async () => ({ payload: { desktop_features: { single_thread: true } } }) },
    managed: { creatorProfile }
  }
}

function renderEmptyThread() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SingleThreadEmptyState />
      </I18nProvider>
    </MemoryRouter>
  )
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

const openCard = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-first-open-card]:not([data-first-open-card="answered"])')

async function pick(root: HTMLElement, label: string) {
  const card = await waitFor(() => {
    const open = openCard(root)
    expect(open).not.toBeNull()

    return open!
  })

  fireEvent.click(within(card).getByRole('button', { name: new RegExp(label) }))
}

describe.each([
  ['as recorded: single_thread alone', false, 'default'],
  ['multi_bot on, APEX on screen', true, 'default'],
  ['multi_bot off, a profile made in developer mode active', false, 'writer']
] as const)('hc-1079: APEX’s own first open is unchanged (%s)', (_label, multiBot, profile) => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    resetMainThreadForTest()
    resetDailyIdeasForTest()
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    $gatewayState.set('open')
    $activeGatewayProfile.set(profile)
    setSingleThreadFlagForTest(multiBot)
    setMultiBotFlagForTest(multiBot)
    resetBotRosterForTest(
      botRosterFrom([{ name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }], () => true)
    )
    $mainThread.set({ ids: [], profile, rootId: null, status: 'absent', tipId: null })
    $authState.set({
      account: { email: 'a@example.test', name: '小满', plan: 'free' },
      accountId: 'acc-1',
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })
  })

  afterEach(() => {
    cleanup()
    setMultiBotFlagForTest(false)
    setSingleThreadFlagForTest(false)
    resetBotRosterForTest()
    $activeGatewayProfile.set('default')
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('the account intake at card 1', async () => {
    installCloud()
    const { container } = renderEmptyThread()

    await waitFor(() => expect(openCard(container)).not.toBeNull())
    await settle()

    await expect(normalized(container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/intake-open.html`)
  })

  it('all three cards answered here, with the noted line', async () => {
    installCloud()
    const { container } = renderEmptyThread()

    await pick(container, '好物测评')
    await pick(container, '抖音和小红书都发')
    await pick(container, '拍了没人看')
    await waitFor(() => expect(container.querySelector('[data-first-open-noted]')).not.toBeNull())
    await settle()

    await expect(normalized(container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/intake-noted.html`)
  })

  it('the intake finished before: greeting, folded answers and the tip', async () => {
    installCloud({ contentType: 'product_review', painPoint: 'no_topic', platforms: ['douyin'] })
    const { container } = renderEmptyThread()

    await waitFor(() => expect(container.querySelector('[data-first-open-tip]')).not.toBeNull())
    await settle()

    await expect(normalized(container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/intake-finished.html`)
  })
})
