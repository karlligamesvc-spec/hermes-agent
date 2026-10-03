import type { Page } from '@playwright/test'

/** Secondary business pages share the bottom-left account menu. */
export async function openAccountDestination(page: Page, label: '项目' | '定时运行') {
  await page.locator('[data-apex-account-trigger]').click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}
