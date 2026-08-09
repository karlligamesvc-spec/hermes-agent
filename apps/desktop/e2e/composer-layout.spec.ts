/**
 * Layout-only regression coverage for the primary conversation surface.
 *
 * This deliberately does not wait for a chat backend: composer geometry is a
 * renderer contract and should remain testable even while onboarding or a
 * local Python runtime is still starting.
 */

import { type NoProviderFixture, setupNoProvider } from './fixtures'
import { expect, test } from './test'

let fixture: NoProviderFixture | null = null

test.beforeAll(async () => {
  fixture = await setupNoProvider()
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test('main composer uses the wide desktop workspace on a large window', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]

    if (window) {
      window.setBounds({ x: 0, y: 0, width: 1600, height: 900 })
      window.show()
    }
  })

  await page.waitForSelector('[data-slot="composer-root"]:not([data-popped-out])', {
    state: 'attached',
  })
  await page.waitForFunction(() => window.innerWidth >= 1_500)

  const composer = page.locator('[data-slot="composer-root"]:not([data-popped-out])').first()
  const box = await composer.boundingBox()
  const viewportWidth = await page.evaluate(() => window.innerWidth)

  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(1_000)
  expect(box!.x).toBeGreaterThan(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth)
})
