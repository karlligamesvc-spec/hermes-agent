import { allowErrorBanners, collectErrorBanners, expect, installErrorBannerGuard, type Page, test } from './test'

// A real shared browser page reproduces the packaged suite's lifetime. Separate
// tests matter: the bug was in afterEach, not in the DOM observer itself.
test.describe.serial('error banners on a shared page', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    installErrorBannerGuard(page)
    await page.goto('about:blank')
  })

  test.afterAll(async () => {await page.close()})

  test('records an expected transient error before it is removed', async () => {
    allowErrorBanners()
    await page.evaluate(() => {
      const alert = document.createElement('div')
      alert.setAttribute('role', 'alert')
      alert.textContent = 'expected capture failure'
      document.body.append(alert)
    })
    await expect.poll(() => collectErrorBanners(page)).toEqual(['expected capture failure'])
    await page.locator('[role="alert"]').evaluate(node => node.remove())
    expect(await collectErrorBanners(page)).toEqual(['expected capture failure'])
  })

  test('drops only completed history and still catches a new error', async () => {
    expect(await collectErrorBanners(page)).toEqual([])
    allowErrorBanners()
    await page.evaluate(() => {
      const alert = document.createElement('div')
      alert.setAttribute('role', 'alert')
      alert.textContent = 'still visible failure'
      document.body.append(alert)
    })
    await expect.poll(() => collectErrorBanners(page)).toEqual(['still visible failure'])
  })

  test('continues reporting an error that is still visible across the boundary', async () => {
    allowErrorBanners()
    expect(await collectErrorBanners(page)).toEqual(['still visible failure'])
    await page.locator('[role="alert"]').evaluate(node => node.remove())
  })
})
