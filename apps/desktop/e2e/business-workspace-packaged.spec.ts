import { expect, test } from './test'

import type { PackagedAppFixture } from './fixtures'
import { setupPackagedApp } from './fixtures'

const BUSINESS_NAV_LABELS = ['开始', '项目', '工作流', '定时运行', '交付物', '业务账号', '历史'] as const

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
  const businessLabels = (await page.locator('[data-sidebar="menu-button"]').evaluateAll(buttons =>
    buttons.slice(0, 7).map(button => button.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
  )).map(label => label.replace(/\s*⌘\s*N$/, ''))

  expect(businessLabels).toEqual(BUSINESS_NAV_LABELS)
  await expect(page.getByText(/\b(?:MCP|Skill|Skills)\b/)).toHaveCount(0)
  await expect(page.getByText('模型', { exact: true })).toHaveCount(0)
})
