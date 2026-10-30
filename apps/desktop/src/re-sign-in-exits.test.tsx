/**
 * hc-1110: every way into a sign-in, and what each must do now that a re-sign-in
 * is the first-open screen (its look is pinned by re-sign-in-identity.test.tsx).
 *
 * - The census pins who may open one, so a new entry point has to be added here
 *   on purpose instead of growing a sign-in surface of its own.
 * - Each entry the user can reach opens that screen over the app, with its reason.
 * - 「返回」 and a finished sign-in both leave the user where they were.
 * - 「使用自己的密钥」, a refused sign-in, a web hand-off code, a hard 401 and a
 *   managed-off build behave as they do on the first open.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { never, Overlays, Providers, removeBridge, seed, settle } from '@/__identity__/re-sign-in/render'
import { getApiRequestProfile, setApiRequestProfile } from '@/api/client'
import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { SingleThreadAccountRow } from '@/app/single-thread/sidebar-account'
import { MANAGED_RECOVERY_COPY } from '@/i18n/managed-recovery'
import { MANAGED_SIGN_IN_COPY } from '@/i18n/managed-sign-in'
import { $authState, handleAuthGate } from '@/store/auth'
import { $cloudLoginRejected, resetCloudLoginForTests } from '@/store/cloud-login'
import { $managedReSignIn, closeManagedReSignIn } from '@/store/managed-re-sign-in'
import { runManagedRelayRecovery } from '@/store/managed-recovery'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $desktopOnboarding, $pendingDesktopLoginCode, requestManagedReSignIn } from '@/store/onboarding'

// Literal copy, not read back from the modules under test.
const EXPIRED = '登录已过期,请重新登录'
const CLOUD = '登录已失效，技能和插件一直没有更新。重新登录后会马上更新。'
const SEND_REFUSED = '登录已失效，刚才那条消息没有发出去。重新登录后再发一次。'
const DEVICE_LIMIT = '这个账户登录的电脑数已达上限。请先在其中一台电脑的 APEX 里退出登录，再回到这里登录。'
const OLD_PANEL = '登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。'

const ASSIGNMENT = { base_url: 'https://relay.example.invalid/v1', model: 'fixture-model', provider: 'custom' }

const SRC = join(__dirname)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      return name === '__identity__' ? [] : sourceFiles(path)
    }

    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

function census(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const file of sourceFiles(SRC)) {
    const hits = readFileSync(file, 'utf8').match(pattern)?.length ?? 0

    if (hits) {
      counts[relative(SRC, file)] = hits
    }
  }

  return counts
}

function Path() {
  return <output aria-label="path">{useLocation().pathname}</output>
}

interface Bridge {
  browserSignIn?: ReturnType<typeof vi.fn>
  cancelPending?: ReturnType<typeof vi.fn>
  deepLinkSignIn?: ReturnType<typeof vi.fn>
  selfHeal?: ReturnType<typeof vi.fn>
}

function installBridge(managed: Bridge = {}) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api: vi.fn(async () => ({})), managed: { status: vi.fn(never), ...managed } }
  })
}

const readyGateway = vi.fn(async (method: string) =>
  method === 'setup.runtime_check' ? { ok: true } : method === 'setup.status' ? { provider_configured: true } : {}
) as never

async function renderApp(entry: ReactNode = null) {
  const view = render(
    <Providers path="/chat-a">
      {entry}
      <Overlays requestGateway={readyGateway} />
      <Path />
    </Providers>
  )

  await settle()

  return view
}

const signInScreen = () => screen.queryByRole('heading', { name: '开始使用' })
const path = () => screen.getByRole('status', { name: 'path' }).textContent

async function openMenuAndReSignIn() {
  fireEvent.pointerDown(screen.getAllByRole('button')[0], { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: '重新登录' }))
  await screen.findByRole('heading', { name: '开始使用' })
}

/** The first-open screen with this notice (null: none) and its way back. */
function expectReSignInScreen(notice: null | string) {
  expect(signInScreen()).toBeTruthy()
  expect(screen.getByRole('button', { name: '登录 APEX 账户' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '返回' })).toBeTruthy()
  expect(screen.queryByText(OLD_PANEL)).toBeNull()

  for (const text of [EXPIRED, CLOUD, SEND_REFUSED]) {
    expect(screen.queryByText(text) !== null).toBe(text === notice)
  }
}

beforeEach(() => {
  clearNotifications()
  resetCloudLoginForTests()
  closeManagedReSignIn()
  setApiRequestProfile(null)
})

afterEach(() => {
  cleanup()
  closeManagedReSignIn()
  clearNotifications()
  setApiRequestProfile(null)
  $pendingDesktopLoginCode.set(null)
  removeBridge()
})

describe('who opens a sign-in', () => {
  it('re-sign-ins come from these call sites only', () => {
    expect(census(/requestManagedReSignIn\(/g)).toEqual({
      'app/chat/sidebar/account-panel.tsx': 3,
      'app/chat/sidebar/cloud-login-notice.tsx': 1,
      'app/im-entry/binding-dialog.tsx': 1,
      'app/single-thread/sidebar-account.tsx': 2,
      'store/managed-recovery.ts': 1,
      'store/onboarding.ts': 1
    })
  })

  it('the sign-in screen is mounted by the auth gate alone, and the gate by the two shells', () => {
    expect(census(/<DesktopLoginScreen\b/g)).toEqual({ 'app/desktop-auth-gate.tsx': 2 })
    expect(census(/<DesktopAuthGate\b/g)).toEqual({ 'app/contrib/wiring.tsx': 1, 'app/desktop-controller.tsx': 1 })
  })

  it('a request only clears a stale sign-in line in the onboarding store', () => {
    seed({}, { managedError: 'fixture stale line', managedRuntimeRecovery: true })
    const before = $desktopOnboarding.get()

    requestManagedReSignIn('fixture reason')

    expect($desktopOnboarding.get()).toEqual({ ...before, managedError: null, managedRuntimeRecovery: null })
    expect($managedReSignIn.get()).toEqual({ notice: 'fixture reason' })
  })
})

describe('each entry opens the first-open screen over the app', () => {
  it('the account menu (single-thread off, or developer mode)', async () => {
    installBridge()
    seed()
    await renderApp(<AccountPanel />)
    await openMenuAndReSignIn()

    expectReSignInScreen(null)
  })

  it('the single-thread account menu', async () => {
    installBridge()
    seed()
    await renderApp(<SingleThreadAccountRow onNavigateBusiness={() => undefined} />)
    await openMenuAndReSignIn()

    expectReSignInScreen(null)
  })

  it('the 「登录已失效」 card of an expired account', async () => {
    installBridge()
    seed({ gateReason: 'unauthorized', status: 'expired' })
    await renderApp(<AccountPanel />)
    fireEvent.click(screen.getByRole('button', { name: /登录已失效/ }))
    await screen.findByRole('heading', { name: '开始使用' })

    expectReSignInScreen(EXPIRED)
  })

  it('the cloud-login card (the login JWT the cloud rejects)', async () => {
    installBridge()
    seed()
    $cloudLoginRejected.set(true)
    await renderApp(<AccountPanel />)
    fireEvent.click(screen.getByRole('button', { name: /技能和插件没更新/ }))
    await screen.findByRole('heading', { name: '开始使用' })

    expectReSignInScreen(CLOUD)
  })

  it('a send the relay refused and could not heal, with real words in its toast', async () => {
    installBridge({
      selfHeal: vi.fn(async () => ({ healed: false, needsSignIn: true, ok: true, relayUnauthorized: true }))
    })
    seed()
    await renderApp()

    await act(async () => {
      await runManagedRelayRecovery({ isActive: true, sessionId: 'fixture-session' })
    })

    expectReSignInScreen(SEND_REFUSED)
    expect($authState.get().status).toBe('expired')
    expect($notifications.get()).toMatchObject([
      { message: '这条消息没有发出去。重新登录后再发一次。', title: '需要重新登录' }
    ])
  })
})

describe('leaving it puts the user back where they were', () => {
  it.each(['signed-in', 'expired'] as const)('「返回」 from a %s account', async status => {
    installBridge()
    seed({ gateReason: status === 'expired' ? 'unauthorized' : null, status })
    await renderApp()
    await act(async () => requestManagedReSignIn(''))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(signInScreen()).toBeNull()
    expect($managedReSignIn.get()).toBeNull()
    expect($authState.get().status).toBe(status)
    expect(path()).toBe('/chat-a')
  })

  it.each(['signed-in', 'expired'] as const)('a finished sign-in from a %s account', async status => {
    const browserSignIn = vi.fn(async () => ({ assignment: ASSIGNMENT, hasRelayKey: true, ok: true }))
    installBridge({ browserSignIn })
    seed({ gateReason: status === 'expired' ? 'unauthorized' : null, status })
    const { container } = await renderApp()
    await act(async () => requestManagedReSignIn(status === 'expired' ? EXPIRED : ''))
    fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))

    await waitFor(() => expect(signInScreen()).toBeNull())
    expect(browserSignIn).toHaveBeenCalledWith({ provider: 'apex', target: { connectionId: null, profile: null } })
    expect($managedReSignIn.get()).toBeNull()
    expect($authState.get()).toMatchObject({ gateReason: null, status: 'signed-in' })
    expect(path()).toBe('/chat-a')
    // Nothing of the first open follows: no onboarding surface, no cover.
    expect(container.querySelector('[data-glass-opaque]')).toBeNull()
  })

  it('after a refused send, comes back without the 「需要重新登录」 toast the screen covered', async () => {
    const browserSignIn = vi.fn(async () => ({ assignment: ASSIGNMENT, hasRelayKey: true, ok: true }))
    const selfHeal = vi.fn(async () => ({ healed: false, needsSignIn: true, ok: true, relayUnauthorized: true }))
    installBridge({ browserSignIn, selfHeal })
    seed()
    await renderApp()

    await act(async () => {
      await runManagedRelayRecovery({ isActive: true, sessionId: 'fixture-session' })
    })
    expect($notifications.get()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))

    await waitFor(() => expect(signInScreen()).toBeNull())
    expect($notifications.get().map(item => item.title)).not.toContain('需要重新登录')
    expect($authState.get().status).toBe('signed-in')
    expect(path()).toBe('/chat-a')
  })

  it('with another assistant open, signs in for that assistant and stays on it', async () => {
    const browserSignIn = vi.fn(async () => ({ assignment: ASSIGNMENT, hasRelayKey: true, ok: true }))
    installBridge({ browserSignIn })
    seed()
    setApiRequestProfile('apex-bot-2')
    await renderApp()
    await act(async () => requestManagedReSignIn(''))
    fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))

    await waitFor(() => expect(signInScreen()).toBeNull())
    expect(browserSignIn).toHaveBeenCalledWith({
      provider: 'apex',
      target: { connectionId: null, profile: 'apex-bot-2' }
    })
    expect(getApiRequestProfile()).toBe('apex-bot-2')
    expect(path()).toBe('/chat-a')
  })
})

describe('the rest of the screen behaves as on the first open', () => {
  it.each(['signed-in', 'expired'] as const)(
    '「使用自己的密钥」 from a %s account opens the provider picker and keeps the account',
    async status => {
      const cancelPending = vi.fn(async () => undefined)
      installBridge({ cancelPending })
      seed({ gateReason: status === 'expired' ? 'unauthorized' : null, status })
      await renderApp()
      await act(async () => requestManagedReSignIn(''))
      fireEvent.click(screen.getByRole('button', { name: '使用自己的密钥' }))
      await screen.findByRole('heading', { name: '开始设置 APEX' })

      expect(signInScreen()).toBeNull()
      expect($managedReSignIn.get()).toBeNull()
      expect(cancelPending).toHaveBeenCalledOnce()
      expect($authState.get()).toMatchObject({ enabled: true, status })

      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      await waitFor(() => expect(screen.queryByRole('heading', { name: '开始设置 APEX' })).toBeNull())
      expect(path()).toBe('/chat-a')
    }
  )

  it.each([
    ['a re-sign-in that opened with a notice', 'signed-in', null],
    ['the hard gate after a 401', 'signed-out', 'unauthorized']
  ] as const)('a refused sign-in shows its own error over %s', async (_case, status, gateReason) => {
    const browserSignIn = vi.fn(async () => ({ message: 'MANAGED_DEVICE_LIMIT_REACHED', ok: false }))
    installBridge({ browserSignIn })
    seed({ gateReason, status })
    await renderApp()

    if (status === 'signed-in') {
      await act(async () => requestManagedReSignIn(EXPIRED))
    }

    expect(screen.getByText(EXPIRED)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '登录 APEX 账户' }))

    await screen.findByText(DEVICE_LIMIT)
    expect(screen.queryByText(EXPIRED)).toBeNull()
    expect(screen.getByRole('button', { name: '登录 APEX 账户' }).hasAttribute('disabled')).toBe(false)
  })

  it('takes a web hand-off code like the first open', async () => {
    const deepLinkSignIn = vi.fn(async () => ({ assignment: ASSIGNMENT, hasRelayKey: true, ok: true }))
    installBridge({ deepLinkSignIn })
    seed()
    await renderApp()
    await act(async () => requestManagedReSignIn(''))
    await act(async () => $pendingDesktopLoginCode.set('fixture-code'))

    await waitFor(() => expect(signInScreen()).toBeNull())
    expect(deepLinkSignIn).toHaveBeenCalledWith({ code: 'fixture-code', target: { connectionId: null, profile: null } })
    expect($managedReSignIn.get()).toBeNull()
  })

  it('gives way to the hard gate when a 401 signs the account out', async () => {
    installBridge()
    seed()
    await renderApp()
    await act(async () => requestManagedReSignIn(''))
    await act(async () => handleAuthGate({ reason: 'unauthorized', statusCode: 401 }))

    expect(signInScreen()).toBeTruthy()
    expect(screen.getByText(EXPIRED)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '返回' })).toBeNull()
  })

  it('draws nothing on a build with managed sign-in off', async () => {
    installBridge()
    seed({ enabled: false })
    const { container } = await renderApp()
    await act(async () => requestManagedReSignIn(''))

    expect(signInScreen()).toBeNull()
    expect(container.querySelector('[data-glass-opaque]')).toBeNull()
  })
})

describe('copy', () => {
  it('every recovery line is real words in every catalog, never a dotted key', () => {
    for (const copy of Object.values(MANAGED_RECOVERY_COPY)) {
      for (const line of Object.values(copy)) {
        expect(line.trim()).not.toBe('')
        expect(line).not.toMatch(/managedRecovery|\.\w+\./)
      }
    }

    expect(MANAGED_RECOVERY_COPY.zh.signInRequiredReason).toBe(SEND_REFUSED)
    expect(MANAGED_RECOVERY_COPY.en.signInRequiredReason).not.toBe(SEND_REFUSED)
  })

  it('「返回」 is in every catalog', () => {
    expect(
      Object.fromEntries(Object.entries(MANAGED_SIGN_IN_COPY).map(([locale, copy]) => [locale, copy.back]))
    ).toEqual({
      ar: 'Back',
      en: 'Back',
      ja: '戻る',
      zh: '返回',
      'zh-hant': '返回'
    })
  })
})
