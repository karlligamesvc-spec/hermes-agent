import type { ElectronApplication, Page } from '@playwright/test'

import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import { collectErrorBanners, expect, test } from './test'

interface AccountWindow extends Window {
  hermesDesktop?: {
    analysisDocuments: AnalysisDocumentsBridge
    managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean }> }
  }
}

interface AccountApi {
  setLoginUser: (id: string) => void
  seedAccountSource: () => void
}

export async function verifyAccountWorkspaceReset(app: ElectronApplication, page: Page, api: AccountApi, owner: string) {
  const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  await page.getByRole('button', { name: '开始 ⌘ N' }).click()
  api.seedAccountSource()
  await page.getByRole('button', { name: '沉浸式分析', exact: true }).click()
  await page.getByRole('button', { name: /account-private.txt/ }).click()
  const privateText = page.getByText('Owner-only fixture text', { exact: true })
  await expect(privateText).toBeVisible()

  try {
    await page.getByRole('button', { name: '打开账户菜单: 本地 UI 评审' }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(page.getByRole('button', { name: '登录 APEX 账户', exact: true })).toBeVisible()
    expect.soft(await privateText.count(), 'old account data must unmount behind the login gate').toBe(0)

    api.setLoginUser(other)
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('hermes:deep-link', { kind: 'login', name: '', params: { code: 'account-boundary-fixture' } })
      }
    })
    await expect(page.getByRole('button', { name: '打开账户菜单: 本地 UI 评审' })).toBeVisible()
    const policy = await page.evaluate(() => (window as AccountWindow).hermesDesktop!.analysisDocuments.policy())
    expect(policy.policy).toMatchObject({ user_id: other })
    // Do not reload or navigate: that would hide a stale mounted view.
    await expect.soft(privateText).toHaveCount(0)
    await expect.soft(page.getByRole('button', { name: /account-private.txt/ })).toHaveCount(0)
    await expect.soft(page.getByText('尚无资料。导入文档或 SRT/VTT 字幕开始。', { exact: true })).toBeVisible()
    // A direct native owner change must also invalidate mounted views in every
    // subscribed renderer, even when both fixture accounts share a display email.
    api.setLoginUser(owner)
    await page.evaluate(() => (window as AccountWindow).hermesDesktop!.managed.signIn({ email: 'phase1-review@local.test', password: 'local-review-only' }))
    await page.getByRole('button', { name: /account-private.txt/ }).click()
    await expect(privateText).toBeVisible()
    api.setLoginUser(other)
    await page.evaluate(() => (window as AccountWindow).hermesDesktop!.managed.signIn({ email: 'phase1-review@local.test', password: 'local-review-only' }))
    await expect(privateText).toHaveCount(0)
    await expect(page.getByText('尚无资料。导入文档或 SRT/VTT 字幕开始。', { exact: true })).toBeVisible()

    // Projects are a sibling cloud entry: logout/re-entry must refresh its list too.
    api.setLoginUser(owner)
    await page.evaluate(() => (window as AccountWindow).hermesDesktop!.managed.signIn({ email: 'phase1-review@local.test', password: 'local-review-only' }))
    await page.getByRole('button', { name: '项目', exact: true }).click()
    const oldProject = page.getByRole('button', { name: /美国宠物用品机会分析/ })
    await expect(oldProject).toBeVisible()
    await page.getByRole('button', { name: '打开账户菜单: 本地 UI 评审' }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(page.getByRole('button', { name: '登录 APEX 账户', exact: true })).toBeVisible()
    expect(await oldProject.count()).toBe(0)
    api.setLoginUser(other)
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('hermes:deep-link', { kind: 'login', name: '', params: { code: 'account-boundary-fixture' } })
      }
    })
    await expect(page.getByRole('button', { name: '打开账户菜单: 本地 UI 评审' })).toBeVisible()
    await expect(oldProject).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await test.info().attach('hc895-account-b-projects', { body: await page.screenshot(), contentType: 'image/png' })
    await test.info().attach('hc895-renderer-account-reset', {
      body: JSON.stringify({ policy, privateTextCount: await privateText.count(), url: page.url() }),
      contentType: 'application/json'
    })
  } finally {
    api.setLoginUser(owner)
    await page.evaluate(() => (window as AccountWindow).hermesDesktop!.managed.signIn({ email: 'phase1-review@local.test', password: 'local-review-only' }))
    // Keep the automatic guard's node-side history across this cleanup reload.
    await collectErrorBanners(page)
    await page.reload()
  }
}
