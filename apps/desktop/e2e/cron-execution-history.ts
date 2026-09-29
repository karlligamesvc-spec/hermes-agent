import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { Page } from '@playwright/test'

import type { PackagedMockBackendFixture } from './fixtures'
import { resolvePackagedE2ePython } from './python-prerequisite'
import { expect, test } from './test'

type CronRequest = { path: string; method?: string; body?: Record<string, unknown> }
type Job = { id: string; enabled: boolean; hermes_home: string; next_run_at: null | string }
type History = { runs: unknown[]; executions: Array<{ id: string; status: string; finished_at: null | string }> }

async function api<T>(page: Page, request: CronRequest): Promise<T> {
  return page.evaluate(async input => {
    const bridge = (window as unknown as { hermesDesktop: { api: (request: CronRequest) => Promise<unknown> } }).hermesDesktop

    return bridge.api(input)
  }, request) as Promise<T>
}

export async function verifyCronTimerExecution(fixture: PackagedMockBackendFixture) {
  const { page, sandbox, mock } = fixture
  const scripts = path.join(sandbox.hermesHome, 'scripts')
  const modelCalls = mock.receivedPrompts.length
  const runAt = new Date(Date.now() + 10_000).toISOString()
  const jobs: Job[] = []

  fs.mkdirSync(scripts, { recursive: true })

  try {
    for (const paused of [false, true]) {
      const name = paused ? 'paused' : 'scheduled'
      const script = path.join(scripts, `hc889-${name}.py`)

      fs.writeFileSync(script, `from pathlib import Path\nfrom datetime import datetime, timezone\nwith (Path(__file__).parent.parent / 'hc889-${name}.txt').open('a') as out:\n    out.write(datetime.now(timezone.utc).isoformat() + '\\n')\n`)

      const job = await api<Job>(page, {
        path: '/api/cron/jobs?profile=default', method: 'POST',
        body: { name: `hc-889 ${name}`, schedule: runAt, script, no_agent: true, deliver: 'local', paused }
      })

      jobs.push(job)
      expect(fs.realpathSync(job.hermes_home)).toBe(fs.realpathSync(sandbox.hermesHome))

      if (paused) {
        expect(job.next_run_at).toBeNull()
      } else {
        expect(Date.parse(job.next_run_at ?? '')).toBe(Date.parse(runAt))
      }
    }

    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '定时运行' }).first().click()
    await page.getByRole('button', { name: /hc-889 scheduled/ }).first().click()

    // No trigger API, clock override or direct tick call: the app's ordinary
    // 60-second backend ticker must discover and execute this future occurrence.
    const marker = path.join(sandbox.hermesHome, 'hc889-scheduled.txt')

    await expect.poll(() => fs.existsSync(marker), { timeout: 90_000, intervals: [500, 1000] }).toBe(true)
    const fired = fs.readFileSync(marker, 'utf8').trim().split('\n')

    expect(fired).toHaveLength(1)
    expect(Date.parse(fired[0])).toBeGreaterThanOrEqual(Date.parse(runAt))
    const historyPath = `/api/cron/jobs/${jobs[0].id}/runs?profile=default`

    await expect.poll(async () => (await api<History>(page, { path: historyPath })).executions.map(row => row.status), { timeout: 10_000 }).toEqual(['completed'])
    const history = await api<History>(page, { path: `/api/cron/jobs/${jobs[0].id}/runs?profile=default` })

    expect(history.runs).toEqual([])
    expect(history.executions.map(row => row.status)).toEqual(['completed'])
    expect(fs.existsSync(path.join(sandbox.hermesHome, 'hc889-paused.txt'))).toBe(false)
    expect(mock.receivedPrompts.length).toBe(modelCalls)

    // Read SQLite directly, without the history API's projection/parser, to
    // prove that the persisted attempt belongs to the scheduled occurrence.
    const python = resolvePackagedE2ePython({ repoRoot: path.resolve(import.meta.dirname, '../../..'), explicit: process.env.HERMES_DESKTOP_PYTHON })

    const result = spawnSync(python, ['-I', '-c',
      "import json,sqlite3,sys; from pathlib import Path; db=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); db.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in db.execute('SELECT id,job_id,status,source,scheduled_instant FROM executions WHERE job_id IN (?,?)',sys.argv[2:])])); db.close()",
      path.join(sandbox.hermesHome, 'cron', 'executions.db'), ...jobs.map(job => job.id)
    ], { encoding: 'utf8', timeout: 10_000 })

    expect(result.status, result.stderr).toBe(0)
    const rows = JSON.parse(result.stdout) as Array<{ id: string; job_id: string; status: string; source: string; scheduled_instant: string }>

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: history.executions[0].id, job_id: jobs[0].id, status: 'completed', source: 'builtin' })
    expect(Date.parse(rows[0].scheduled_instant)).toBe(Date.parse(runAt))
    await test.info().attach('actual-timer-occurrence', { body: JSON.stringify({ runAt, fired, rows, history }), contentType: 'application/json' })
    await expect(page.locator('[data-cron-executions]').getByText('已完成', { exact: true })).toBeVisible({ timeout: 15_000 })
  } finally {
    for (const job of jobs) {
      await api(page, { path: `/api/cron/jobs/${job.id}?profile=default`, method: 'DELETE' })
    }
  }
}

export async function verifyCronExecutionHistory(fixture: PackagedMockBackendFixture) {
  const { page, app, sandbox, mock } = fixture
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
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

    expect(Date.parse(ready.next_run_at ?? '')).toBeGreaterThan(Date.now())
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
    // Reload can restore the business Start surface, which has no chat textarea.
    // Let the actual navigation action wait for boot overlays to release it.
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
    await app.evaluate(({ BrowserWindow }, original) => BrowserWindow.getAllWindows()[0]?.setBounds(original), bounds)
  }
}
