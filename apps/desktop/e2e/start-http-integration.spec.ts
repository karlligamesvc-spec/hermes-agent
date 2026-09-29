import fs from 'node:fs'
import path from 'node:path'

import type { WorkflowDomainBridge } from '../src/app/business-workspace/api/types'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { allowErrorBanners, collectErrorBanners, expect, test } from './test'

interface StartWindow extends Window {
  hermesDesktop?: {
    managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean; hasRelayKey: boolean }> }
    workflowDomain: WorkflowDomainBridge
  }
}

const inputFile = process.env.APEX_START_INTEGRATION_INPUT

test('actual Start selects a catalog template, preserves a failed goal and explicitly retries to a queued Run', async () => {
  test.skip(!inputFile, 'Opt-in: run the APEX Start PostgreSQL/HTTP orchestrator')
  test.setTimeout(180_000)
  const input = JSON.parse(fs.readFileSync(inputFile!, 'utf8')) as { base: string; output: string }
  allowErrorBanners()
  expect(new URL(input.base).hostname).toBe('127.0.0.1')
  let fixture: PackagedMockBackendFixture | undefined
  let completed = false

  try {
    fixture = await setupPackagedMockBackend({ APEXNODES_API_BASE: input.base, APEXNODES_AUTH_BASE: input.base })
    const { page, mockUrl, sandbox } = fixture
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })

    if (await later.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {await later.click()}
    await waitForAppReady(fixture, 120_000)

    const signedIn = await page.evaluate(password => (window as StartWindow).hermesDesktop!.managed.signIn({
      email: 'owner@fixture.test', password
    }), mockUrl)

    expect(signedIn).toMatchObject({ ok: true, hasRelayKey: true })
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '开始' }).first().click()
    const goal = page.getByRole('textbox', { name: '业务目标', exact: true })
    const brief = 'Fixture goal: monitor competitors; no actual Agent execution'
    await goal.fill(brief)
    await expect(page.getByRole('button', { name: '选择工作流', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '选择工作流', exact: true }).click()
    await expect(page.locator('[data-business-workflows-page]')).toBeVisible()
    await page.getByRole('button', { name: /竞品监控/ }).click()
    const template = page.getByRole('dialog', { name: '竞品监控', exact: true })
    await expect(template).toBeVisible()
    await template.getByRole('button', { name: '使用这个工作流', exact: true }).click()
    await expect(goal).toHaveValue(brief)
    await expect(page.locator('[data-workflow-start-confirmation]')).toContainText('竞品监控')
    const submit = page.getByRole('button', { name: '开始执行', exact: true })
    await submit.click()
    const failed = page.getByRole('alert').filter({ hasText: '真实工作流启动失败' })
    await expect(failed).toHaveText('真实工作流启动失败，目标草稿已保留，请重试。')
    const expectedErrors = await collectErrorBanners(page)
    expect(expectedErrors).toEqual(['真实工作流启动失败，目标草稿已保留，请重试。'])
    await expect(goal).toHaveValue(brief)
    await expect(submit).toBeEnabled()
    expect(page.url()).not.toContain('/workflow-runs/')
    await submit.click()
    const run = page.locator('[data-run-scroll-container]')
    await expect(run).toBeVisible()
    await expect(run).toContainText('Hermes')
    await expect(run).toContainText('排队中')

    const saved = await page.evaluate(async () => {
      const bridge = (window as StartWindow).hermesDesktop!.workflowDomain
      const projects = await bridge.listProjects!()
      const workflows = await bridge.listWorkflows!()

      return { projects, workflows }
    })

    expect(saved.projects).toMatchObject({ ok: true, total: 1, items: [{ objective: brief }] })
    expect(saved.workflows.items).toHaveLength(1)
    const runId = decodeURIComponent(new URL(page.url()).hash).split('/workflow-runs/')[1]?.split(/[?#/]/)[0]
    expect(runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await collectErrorBanners(page)).toEqual(expectedErrors)
    fs.writeFileSync(path.join(path.dirname(input.output), 'queued-ui.png'), await page.screenshot())
    fs.writeFileSync(input.output, JSON.stringify({ root: sandbox.userDataDir, runId, saved }))
    completed = true
  } finally {
    if (fixture) {
      const banners = await collectErrorBanners(fixture.page)
      let cleanupError: unknown

      try { await fixture.cleanup() } catch (error) { cleanupError = error }

      if (completed) {
        expect(banners).toEqual(['真实工作流启动失败，目标草稿已保留，请重试。'])
        expect(cleanupError).toBeUndefined()
        expect(fs.existsSync(fixture.sandbox.userDataDir)).toBe(false)
      }
    }
  }
})
