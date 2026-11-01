/**
 * hc-1132 identity guard (hard rule 11): what the real-profile change must leave alone.
 *
 * Every golden under `__identity__/real-profile-consent/` was recorded on fork
 * main 12fa0a86e9, before any hc-1132 code was written: the consent dialog and
 * the Capabilities toggle, in every language. A diff here means the change
 * reached a screen it should not: fix the code, do not re-record the golden.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  installBridge,
  LOCALES,
  OUTSIDE_PRODUCT_MODE,
  removeBridge,
  renderDialog,
  renderPanel,
  seedMode
} from '@/__identity__/real-profile-consent/render'

const GOLDEN = './__identity__/real-profile-consent'

afterEach(() => {
  cleanup()
  removeBridge()
})

describe.each(OUTSIDE_PRODUCT_MODE)('with %s', (_name, flag, toolView) => {
  it.each(LOCALES)('the dialog in %s', async locale => {
    seedMode(flag, toolView)
    installBridge()

    await expect(await renderDialog(locale)).toMatchFileSnapshot(`${GOLDEN}/dialog-${locale}.html`)
  })

  it.each(LOCALES)('the Capabilities toggle in %s', async locale => {
    seedMode(flag, toolView)
    installBridge()

    await expect(await renderPanel(locale)).toMatchFileSnapshot(`${GOLDEN}/toggle-${locale}.html`)
  })

  it('accepting writes the same one key', async () => {
    seedMode(flag, toolView)
    const calls = installBridge({ browser: { allow_private_urls: false, use_real_profile: false } })

    await renderDialog('zh')
    fireEvent.click(screen.getByRole('button', { name: '使用我的配置文件' }))

    await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true))
    expect(calls.filter(call => call.method === 'PUT')).toEqual([
      { body: { config: { browser: { use_real_profile: true } } }, method: 'PUT', path: '/api/config' }
    ])
  })
})
