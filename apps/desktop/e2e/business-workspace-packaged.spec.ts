import { type PackagedAppFixture, setupPackagedApp } from './fixtures'
import { expect, test } from './test'

const BUSINESS_NAV_LABELS = ['开始', '项目', '工作流', '定时运行', '交付物', '业务账号', '历史'] as const

const BUSINESS_START_VIEWPORTS = [
  { height: 900, name: 'wide-1440', width: 1440 },
  { height: 800, name: 'desktop-1280', width: 1280 },
  { height: 720, name: 'narrow-900', width: 900 }
] as const

let fixture: PackagedAppFixture | null = null

test.beforeAll(async () => {
  fixture = await setupPackagedApp()
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test('fresh packaged app exposes the business workspace without implementation vocabulary', async () => {
  const page = fixture!.page

  await expect(page.getByRole('button', { name: '开始 ⌘ N' })).toBeAttached({ timeout: 60_000 })
  const sidebarButtons = page.locator('[data-sidebar="menu-button"]')

  await expect(sidebarButtons).toHaveCount(7)

  const businessLabels = (await sidebarButtons.allTextContents())
    .map(label => label.replace(/\s+/g, ' ').trim())
    .map(label => label.replace(/\s*⌘\s*N$/, ''))

  expect(businessLabels).toEqual(BUSINESS_NAV_LABELS)
  await expect(page.getByText(/\b(?:MCP|Skill|Skills)\b/)).toHaveCount(0)
  await expect(page.getByText('模型', { exact: true })).toHaveCount(0)
})

test('packaged Start keeps its real-data sections usable at wide, desktop, and narrow window sizes', async (_args, testInfo) => {
  const { app, page } = fixture!

  await expect(page.locator('[data-business-start-shelf]')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('[data-business-start-evidence]')).toBeVisible()

  for (const viewport of BUSINESS_START_VIEWPORTS) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]

      if (win) {
        win.unmaximize()
        win.setMinimumSize(760, 600)
        win.setSize(size.width, size.height, false)
      }
    }, viewport)
    await page.waitForTimeout(200)

    const layout = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    }))

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth)
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: testInfo.outputPath(`business-start-${viewport.name}.png`)
    })
  }
})
