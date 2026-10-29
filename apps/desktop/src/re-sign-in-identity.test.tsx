/**
 * hc-1110 identity guard (hard rule 11): what unifying 「重新登录」 must leave alone.
 *
 * Every golden under `__identity__/re-sign-in/` was recorded on fork main
 * e495735111, before any hc-1110 code was written: the first-open sign-in
 * screen in each state the gate can put it in, the gate's empty and covering
 * states, the provider pickers 「使用自己的密钥」 leads to, and the account
 * surfaces that open a re-sign-in. A diff here means the change reached a
 * screen it should not: fix the code, do not re-record the golden.
 *
 * The last block holds hc-1110 itself: a re-sign-in, whatever opened it, renders
 * one of those first-open goldens byte for byte plus one 「返回」 button.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  installQuietBridge,
  normalized,
  removeBridge,
  renderAccountPanel,
  renderOverlays,
  renderSingleThreadAccountRow,
  seed
} from '@/__identity__/re-sign-in/render'
import { CLOUD_LOGIN_COPY } from '@/i18n/cloud-login'
import { MANAGED_RECOVERY_COPY } from '@/i18n/managed-recovery'
import { closeManagedReSignIn } from '@/store/managed-re-sign-in'
import { $desktopOnboarding, requestManagedReSignIn, startManualOnboarding } from '@/store/onboarding'

const GOLDEN = './__identity__/re-sign-in'

const SIGNED_OUT = { account: { email: '', name: '', plan: '' }, accountId: null, status: 'signed-out' } as const

// Literal copy, not read back from the module under test.
const DEVICE_LIMIT = '这个账户登录的电脑数已达上限。请先在其中一台电脑的 APEX 里退出登录，再回到这里登录。'

afterEach(() => {
  cleanup()
  closeManagedReSignIn()
  removeBridge()
})

const html = (node: HTMLElement) => normalized(node.innerHTML) + '\n'

describe('the first-open sign-in screen, as the gate shows it', () => {
  it.each([
    ['first-open', 'zh', {}, {}],
    ['first-open-en', 'en', {}, {}],
    ['session-expired', 'zh', { gateReason: 'unauthorized' }, {}],
    ['account-disabled', 'zh', { gateReason: 'account_disabled', status: 'disabled' }, {}],
    ['signing-in', 'zh', {}, { managedSubmitting: true }],
    ['sign-in-error', 'zh', {}, { managedError: DEVICE_LIMIT }]
  ] as const)('%s', async (name, locale, auth, onboarding) => {
    installQuietBridge()
    seed({ ...SIGNED_OUT, ...auth }, { configured: false, ...onboarding })

    await expect(html(await renderOverlays(locale))).toMatchFileSnapshot(`${GOLDEN}/${name}.html`)
  })

  it('covers the window while the first check is out', async () => {
    installQuietBridge()
    seed({ ...SIGNED_OUT, status: 'checking' }, { configured: false })

    await expect(html(await renderOverlays())).toMatchFileSnapshot(`${GOLDEN}/checking.html`)
  })

  it.each(['signed-in', 'expired'] as const)('draws nothing for a %s account', async status => {
    installQuietBridge()
    seed({ status })

    expect(html(await renderOverlays())).toBe('\n')
  })
})

describe('the provider pickers 「使用自己的密钥」 can lead to', () => {
  it('first open: the BYOK detour with its way back to sign-in', async () => {
    installQuietBridge()
    seed(SIGNED_OUT, { configured: false })
    const container = await renderOverlays()
    fireEvent.click(screen.getByRole('button', { name: '使用自己的密钥' }))
    await screen.findByRole('button', { name: '返回登录' })

    await expect(html(container)).toMatchFileSnapshot(`${GOLDEN}/first-open-own-key.html`)
  })

  it('a signed-in account: the picker Settings › 提供方 opens', async () => {
    installQuietBridge()
    seed()
    startManualOnboarding(null)

    await expect(html(await renderOverlays())).toMatchFileSnapshot(`${GOLDEN}/manual-picker.html`)
  })
})

describe('the account surfaces that open a re-sign-in', () => {
  it('AccountPanel, menu open', async () => {
    installQuietBridge()
    seed()

    await expect(html(await renderAccountPanel())).toMatchFileSnapshot(`${GOLDEN}/account-panel-menu.html`)
  })

  it('AccountPanel, 「登录已失效」 card', async () => {
    installQuietBridge()
    seed({ gateReason: 'unauthorized', status: 'expired' })

    await expect(html(await renderAccountPanel())).toMatchFileSnapshot(`${GOLDEN}/account-panel-expired.html`)
  })

  it('the single-thread account row, menu open', async () => {
    installQuietBridge()
    seed()

    await expect(html(await renderSingleThreadAccountRow())).toMatchFileSnapshot(
      `${GOLDEN}/single-thread-account-menu.html`
    )
  })
})

describe('hc-1110: a re-sign-in is the first-open screen plus 「返回」', () => {
  const golden = (name: string) => readFileSync(join(__dirname, '__identity__', 're-sign-in', `${name}.html`), 'utf8')
  const EXPIRED = '登录已过期,请重新登录'

  // Strips the one 「返回」 the re-sign-in adds, after proving there is exactly one.
  // Its class holds `has-[>svg]`, so the match stops at `<`, not at `>`.
  function withoutBack(rendered: string, label: string): string {
    const back = new RegExp(`<button [^<]*data-variant="text"[^<]*>${label}</button>`, 'g')

    expect(rendered.match(back)).toHaveLength(1)

    return rendered.replace(back, '')
  }

  async function reSignIn(notice: string, locale: 'en' | 'zh' = 'zh'): Promise<HTMLElement> {
    const container = await renderOverlays(locale)

    await act(async () => {
      requestManagedReSignIn(notice)
    })

    return container
  }

  it.each([
    ['the account menus, zh', 'signed-in', '', 'zh', '返回', 'first-open'],
    ['the account menus, en', 'signed-in', '', 'en', 'Back', 'first-open-en'],
    ['the 「登录已失效」 card', 'expired', EXPIRED, 'zh', '返回', 'session-expired'],
    ['the IM binding', 'signed-in', EXPIRED, 'zh', '返回', 'session-expired']
  ] as const)('%s', async (_entry, status, notice, locale, back, name) => {
    installQuietBridge()
    seed({ status, gateReason: status === 'expired' ? 'unauthorized' : null })

    expect(withoutBack(html(await reSignIn(notice, locale)), back)).toBe(golden(name))
  })

  it.each([
    ['the cloud-login card', CLOUD_LOGIN_COPY.zh.reason],
    ['a send the relay refused', MANAGED_RECOVERY_COPY.zh.signInRequiredReason]
  ])('%s: the session-expired layout with its own reason', async (_entry, reason) => {
    installQuietBridge()
    seed()

    expect(withoutBack(html(await reSignIn(reason)), '返回').replace(reason, EXPIRED)).toBe(golden('session-expired'))
  })

  it('while a sign-in is out, like the first open (「返回」 waits too)', async () => {
    // Seeded before the screen mounts, as the golden was: an attribute React adds
    // later serializes after `type`, a difference no one can see.
    installQuietBridge()
    seed({}, { managedSubmitting: true })
    const container = await reSignIn('')

    expect(withoutBack(html(container), '返回')).toBe(golden('signing-in'))
    expect(screen.getByRole('button', { name: '返回' }).hasAttribute('disabled')).toBe(true)
  })

  it('a refused sign-in, like the first open', async () => {
    installQuietBridge()
    seed()
    const container = await reSignIn('')

    await act(async () => {
      $desktopOnboarding.set({ ...$desktopOnboarding.get(), managedError: DEVICE_LIMIT })
    })

    expect(withoutBack(html(container), '返回')).toBe(golden('sign-in-error'))
  })

  it('「使用自己的密钥」 opens the picker Settings › 提供方 opens, byte for byte', async () => {
    installQuietBridge()
    seed()
    const container = await renderOverlays()

    await act(async () => {
      requestManagedReSignIn('')
    })
    fireEvent.click(screen.getByRole('button', { name: '使用自己的密钥' }))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(html(container)).toBe(golden('manual-picker'))
  })
})
