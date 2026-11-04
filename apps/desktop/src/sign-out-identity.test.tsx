/**
 * hc-1142 identity guard (hard rule 11): the faster sign-out exists only in
 * single-thread product mode.
 *
 * Every golden under `__identity__/sign-out/` was recorded on fork main
 * f159f8abf3, before any hc-1142 code was written. With the switch off and in
 * developer mode, 「退出登录」 in AccountPanel shows, byte for byte:
 * - while the server is asked: the menu stays open, its row disabled with a spinner;
 * - after it signed out, while the engine restarts: nothing, then the login screen;
 * - when the sign-out fails: the old words and the 重新登录 action.
 * A diff here means the change reached a mode it should leave alone: fix the
 * code, do not re-record the golden.
 */
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { removeBridge } from '@/__identity__/re-sign-in/render'
import {
  bodyHtml,
  clickSignOut,
  gateway,
  installSignOutBridge,
  notificationsJson,
  setSignOutMode,
  type SignOutMode
} from '@/__identity__/sign-out/harness'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

const GOLDEN = './__identity__/sign-out'

afterEach(() => {
  cleanup()
  removeBridge()
})

afterAll(() => {
  setToolViewMode('product')
  setSingleThreadFlagForTest(false)
})

describe.each<SignOutMode>(['developer', 'switch-off'])('sign-out with %s', mode => {
  it('keeps the menu open with a spinner while the server is asked', async () => {
    setSignOutMode(mode)
    installSignOutBridge(() => new Promise(() => undefined))

    await expect(bodyHtml(await clickSignOut())).toMatchFileSnapshot(`${GOLDEN}/pending-${mode}.html`)
  })

  it('shows nothing while the engine restarts, then the login screen', async () => {
    setSignOutMode(mode)
    installSignOutBridge(async () => ({ ok: true }))
    const body = await clickSignOut()
    await gateway(false)

    await expect(bodyHtml(body)).toMatchFileSnapshot(`${GOLDEN}/restarting-${mode}.html`)
    await gateway(true)
    await expect(bodyHtml(body)).toMatchFileSnapshot(`${GOLDEN}/restarted-${mode}.html`)
  })

  it('says the old words when the server could not be asked', async () => {
    setSignOutMode(mode)
    installSignOutBridge(async () => ({ ok: false, message: 'MANAGED_PROVISION_UNAVAILABLE', statusCode: 503 }))
    const body = await clickSignOut()

    await expect(notificationsJson()).toMatchFileSnapshot(`${GOLDEN}/failed-${mode}.json`)
    await expect(bodyHtml(body)).toMatchFileSnapshot(`${GOLDEN}/failed-${mode}.html`)
  })
})
