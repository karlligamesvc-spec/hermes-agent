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

test('docked composer keeps two writing lines above a dedicated toolbar row', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]

    if (window) {
      window.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
      window.show()
    }
  })

  const layout = page.locator('[data-slot="composer-layout"][data-layout="three-row"]').first()
  const editor = layout.locator('[data-slot="composer-rich-input"]')
  const toolbarStart = layout.locator('[data-slot="composer-toolbar-start"]')
  const toolbarEnd = layout.locator('[data-slot="composer-toolbar-end"]')

  await expect(layout).toBeVisible()

  const [editorBox, startBox, endBox] = await Promise.all([
    editor.boundingBox(),
    toolbarStart.boundingBox(),
    toolbarEnd.boundingBox()
  ])

  expect(editorBox).not.toBeNull()
  expect(startBox).not.toBeNull()
  expect(endBox).not.toBeNull()
  expect(editorBox!.height).toBeGreaterThanOrEqual(64)
  expect(startBox!.y).toBeGreaterThan(editorBox!.y + editorBox!.height - 1)
  expect(Math.abs(startBox!.y - endBox!.y)).toBeLessThanOrEqual(2)
})
