import fs from 'node:fs'
import path from 'node:path'

import type { Page } from '@playwright/test'

import type { PackagedMockBackendFixture } from './fixtures'
import { waitForAppReady } from './fixtures'
import { expect, test } from './test'

type CronRequest = { path: string; method?: string; body?: Record<string, unknown> }
type Job = { id: string; enabled: boolean; hermes_home: string; next_run_at: string }
type History = { runs: unknown[]; executions: Array<{ id: string; status: string; finished_at: null | string }> }

async function api<T>(page: Page, request: CronRequest): Promise<T> {
  return page.evaluate(async input => {
    const bridge = (window as unknown as { hermesDesktop: { api: (request: CronRequest) => Promise<unknown> } }).hermesDesktop

    return bridge.api(input)
  }, request) as Promise<T>
}

export async function verifyCronExecutionHistory(fixture: PackagedMockBackendFixture) {
  const { page, app, sandbox, mock } = fixture
  const scripts = path.join(sandbox.hermesHome, 'scripts')
  const script = path.join(scripts, 'hc889-cron-proof.py')
  const marker = path.join(sandbox.hermesHome, 'hc889-executed.txt')
  const modelCalls = mock.receivedPrompts.length

  fs.mkdirSync(scripts, { recursive: true })
  fs.writeFileSync(script, "from pathlib import Path\n(Path(__file__).parent.parent / 'hc889-executed.txt').write_text('executed')\nprint('local script proof')\n")

  // An absolute sandbox script must pass the real backend's profile-root check
  // before job creation, so a wrongly routed runtime cannot write a real job.
  const job = await api<Job>(page, {
    path: '/api/cron/jobs?profile=default', method: 'POST',
    body: { name: 'hc-889 脚本验收', schedule: 'every 1h', script, no_agent: true, deliver: 'local', paused: true }
  })

  expect(fs.realpathSync(job.hermes_home)).toBe(fs.realpathSync(sandbox.hermesHome))
  const jobPath = `/api/cron/jobs/${encodeURIComponent(job.id)}`

  try {
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '定时运行' }).first().click()
    await page.getByRole('button', { name: /hc-889 脚本验收/ }).first().click()
    await page.getByRole('button', { name: '恢复', exact: true }).click()
    await expect.poll(async () => (await api<Job>(page, { path: jobPath })).enabled).toBe(true)
    const ready = await api<Job>(page, { path: jobPath })

    expect(Date.parse(ready.next_run_at)).toBeGreaterThan(Date.now())
    await page.getByRole('button', { name: '立即触发', exact: true }).click()
    await expect.poll(() => fs.existsSync(marker)).toBe(true)
    expect(fs.readFileSync(marker, 'utf8')).toBe('executed')
    await expect(page.locator('[data-cron-executions]').getByText('已完成', { exact: true })).toBeVisible()

    fs.writeFileSync(script, "raise SystemExit('hc889 intentional script failure')\n")
    await page.getByRole('button', { name: '立即触发', exact: true }).click()
    await expect(page.locator('[data-cron-executions]').getByText('执行失败', { exact: true })).toBeVisible()
    const history = await api<History>(page, { path: `${jobPath}/runs` })

    expect(history.runs).toEqual([])
    expect(history.executions.map(row => row.status)).toEqual(['failed', 'completed'])
    expect(history.executions.every(row => row.finished_at)).toBe(true)
    expect(mock.receivedPrompts.length).toBe(modelCalls)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await expect.poll(async () => (await api<Job>(page, { path: jobPath })).enabled).toBe(false)
    await page.reload()
    await waitForAppReady(fixture)
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '定时运行' }).first().click()
    await page.getByRole('button', { name: /hc-889 脚本验收/ }).first().click()
    await expect(page.locator('[data-cron-execution-id]')).toHaveCount(2)
    await expect(page.locator('[data-cron-executions] button')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(820, 780))
    await expect(page.locator('[data-cron-executions]').getByText('执行失败', { exact: true })).toBeInViewport()
    await page.screenshot({ path: test.info().outputPath('cron-script-history.png') })
    await test.info().attach('actual-cron-execution-history', { body: JSON.stringify(history), contentType: 'application/json' })
  } finally {
    await api(page, { path: jobPath, method: 'DELETE' })
  }
}
