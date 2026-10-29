/**
 * hc-1110 identity guard (hard rule 11): what unifying 「重新登录」 must leave alone.
 *
 * Every golden under `__identity__/re-sign-in/` was recorded on fork main
 * e495735111, before any hc-1110 code was written: the first-open sign-in
 * screen in each state the gate can put it in, the gate's empty and covering
 * states, the provider pickers 「使用自己的密钥」 leads to, and the account
 * surfaces that open a re-sign-in. A diff here means the change reached a
 * screen it should not: fix the code, do not re-record the golden.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react'
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
import { startManualOnboarding } from '@/store/onboarding'

const GOLDEN = './__identity__/re-sign-in'

const SIGNED_OUT = { account: { email: '', name: '', plan: '' }, accountId: null, status: 'signed-out' } as const

// Literal copy, not read back from the module under test.
const DEVICE_LIMIT = '这个账户登录的电脑数已达上限。请先在其中一台电脑的 APEX 里退出登录，再回到这里登录。'

afterEach(() => {
  cleanup()
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
