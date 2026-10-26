/**
 * hc-1073: the 「登录已失效」 card above the account row while the cloud rejects
 * the stored login JWT but chat still works. Pinned on the real AccountPanel
 * and the real single-thread sidebar: when it shows, what a click does, how
 * main's pushes and re-reads move it, and that with the login accepted the
 * panel renders exactly as before.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { DesktopCloudLoginState } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState, type AuthStatus } from '@/store/auth'
import { $cloudLoginRejected, resetCloudLoginForTests } from '@/store/cloud-login'
import { resetMainThreadForTest } from '@/store/main-thread'
import { $desktopOnboarding, cancelOnboardingFlow } from '@/store/onboarding'
import { $planUsage } from '@/store/plan-usage'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { resetThreadPresenceForTest } from '@/store/single-thread-presence'

import { AccountPanel } from './account-panel'

const ACTION = '技能和插件没更新，点此重新登录'
const REASON = '登录已失效，技能和插件一直没有更新。重新登录后会马上更新。'

const noop = () => {}

const ACTIONS: SidebarActions = {
  onArchiveSession: noop,
  onBranchSession: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onManageCronJob: noop,
  onNavigate: noop,
  onNewSessionInWorkspace: noop,
  onNewSessionSplit: noop,
  onResumeSession: noop,
  onTriggerCronJob: noop
}

let push: ((state: DesktopCloudLoginState) => void) | null = null

function stubBridge(read: () => Promise<DesktopCloudLoginState>) {
  const cloudLogin = vi.fn(read)

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      imEntry: { list: vi.fn(async () => ({ channels: [] })) },
      managed: {
        cloudLogin,
        onCloudLogin: vi.fn((callback: (state: DesktopCloudLoginState) => void) => {
          push = callback

          return noop
        })
      }
    }
  })

  return cloudLogin
}

const rejected = (value: boolean): DesktopCloudLoginState => ({ rejected: value, since: value ? 1 : null })

function setAuth(status: AuthStatus, accountId = 'acct-1') {
  $authState.set({
    account: { email: 'xiaoman@example.com', name: '小满', plan: '' },
    accountId,
    enabled: true,
    gateReason: status === 'expired' ? 'unauthorized' : null,
    loginTruth: true,
    status
  })
}

function renderPanel() {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <AccountPanel />
      </MemoryRouter>
    </I18nProvider>
  )
}

const card = (container: HTMLElement) => container.querySelector('[data-apex-cloud-login]')
// React and Radix number their ids per render; nothing else may differ.
const withoutIds = (html: string) => html.replace(/radix-_r_\w+_/g, 'radix-id')

beforeEach(() => {
  window.localStorage.clear()
  setRuntimeI18nLocale('zh')
  resetCloudLoginForTests()
  cancelOnboardingFlow()
  push = null
  setAuth('signed-in')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('the classic account panel', () => {
  it('shows 「登录已失效」 above a working account row when the cloud rejects the login', async () => {
    stubBridge(async () => rejected(true))
    const { container } = renderPanel()

    await waitFor(() => expect(card(container)).not.toBeNull())

    expect(card(container)?.textContent).toBe(`登录已失效${ACTION}`)
    const row = container.querySelector('[data-apex-account-trigger]')
    expect(row).not.toBeNull()
    expect(card(container)!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a click opens the managed sign-in with the reason, and leaves the row alone', async () => {
    stubBridge(async () => rejected(true))
    const { container } = renderPanel()
    await waitFor(() => expect(card(container)).not.toBeNull())

    fireEvent.click(card(container)!)

    expect($desktopOnboarding.get()).toMatchObject({ managedAvailable: true, managedError: REASON, requested: true })
    expect(container.querySelector('[data-apex-account-trigger]')).not.toBeNull()
  })

  it('with the login accepted the panel renders exactly as without the bridge', async () => {
    const before = withoutIds(renderPanel().container.innerHTML)
    cleanup()

    const read = stubBridge(async () => rejected(false))
    const { container } = renderPanel()
    await waitFor(() => expect(read).toHaveBeenCalled())
    await act(async () => {})

    expect(withoutIds(container.innerHTML)).toBe(before)
    // Both renders share this code, so also pin what "before" is: the account row alone.
    expect(card(container)).toBeNull()
    expect(container.children).toHaveLength(1)
    expect(container.firstElementChild?.hasAttribute('data-apex-account-trigger')).toBe(true)
  })

  it('follows main: a push clears it, the next 401 brings it back', async () => {
    stubBridge(async () => rejected(true))
    const { container } = renderPanel()
    await waitFor(() => expect(card(container)).not.toBeNull())

    act(() => push?.(rejected(false)))
    expect(card(container)).toBeNull()

    act(() => push?.(rejected(true)))
    expect(card(container)).not.toBeNull()
  })

  it('re-reads after an account change, so a fresh sign-in clears it', async () => {
    const answers = [rejected(true), rejected(false)]
    const read = stubBridge(async () => answers.shift() ?? rejected(false))
    const { container } = renderPanel()
    await waitFor(() => expect(card(container)).not.toBeNull())

    act(() => setAuth('signed-in', 'acct-2'))

    await waitFor(() => expect(card(container)).toBeNull())
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a read that answers after a newer push does not undo it', async () => {
    let answer: (state: DesktopCloudLoginState) => void = noop
    stubBridge(() => new Promise(resolve => (answer = resolve)))
    const { container } = renderPanel()

    act(() => push?.(rejected(false)))
    await act(async () => answer(rejected(true)))

    expect($cloudLoginRejected.get()).toBe(false)
    expect(card(container)).toBeNull()
  })

  it('an expired account keeps its one 「登录已失效」 card, not two', async () => {
    setAuth('expired')
    stubBridge(async () => rejected(true))
    const { container } = renderPanel()
    await act(async () => {})

    expect(screen.getAllByText('登录已失效')).toHaveLength(1)
    expect(card(container)).toBeNull()
  })

  it('an older main process without the read shows nothing', async () => {
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: {} } })
    const { container } = renderPanel()
    await act(async () => {})

    expect(card(container)).toBeNull()
    expect(container.querySelector('[data-apex-account-trigger]')).not.toBeNull()
  })
})

describe('the single-thread sidebar', () => {
  beforeEach(() => {
    setSingleThreadFlagForTest(true)
    resetMainThreadForTest()
  })

  afterEach(() => {
    setSingleThreadFlagForTest(false)
    resetMainThreadForTest()
    resetThreadPresenceForTest()
    $planUsage.set(null)
  })

  it('shows the card above its own account row too', async () => {
    stubBridge(async () => rejected(true))

    const { container } = render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <SidebarProvider>
            <SidebarSurface actions={ACTIONS} currentView="chat" />
          </SidebarProvider>
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(card(container)).not.toBeNull())

    const row = container.querySelector('[data-single-thread-account]')
    expect(row).not.toBeNull()
    expect(card(container)!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(card(container)?.textContent).toBe(`登录已失效${ACTION}`)
  })
})
