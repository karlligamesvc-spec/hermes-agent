import fs from 'node:fs'
import path from 'node:path'

import type { Page } from '@playwright/test'

import type { WorkflowDomainBridge } from '../src/app/business-workspace/api/types'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { allowErrorBanners, expect, installErrorBannerGuard, test } from './test'

interface StartWindow extends Window {
  hermesDesktop?: {
    openWindow: () => Promise<{ ok: boolean }>
    managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean; hasRelayKey: boolean }> }
    workflowDomain: WorkflowDomainBridge
  }
}

const inputFile = process.env.APEX_START_INTEGRATION_INPUT

async function pageAlerts(page: Page): Promise<string[]> {
  const history = await page.evaluate(() => (window as unknown as { __ERROR_BANNER_GUARD__?: string[] }).__ERROR_BANNER_GUARD__ ?? [])
  const current = await page.locator('[role="alert"]').allTextContents()

  return [...new Set([...history, ...current.map(text => text.trim()).filter(Boolean)])]
}

async function prepareStart(page: Page, brief: string) {
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '开始' }).first().click()
  const goal = page.getByRole('textbox', { name: '业务目标', exact: true })

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

  return { goal, submit: page.getByRole('button', { name: '开始执行', exact: true }) }
}

async function expectQueuedRun(page: Page) {
  const run = page.locator('[data-run-scroll-container]')

  await expect(run).toBeVisible()
  await expect(run).toContainText('Hermes')
  await expect(run).toContainText('排队中')
  const runId = decodeURIComponent(new URL(page.url()).hash).split('/workflow-runs/')[1]?.split(/[?#/]/)[0]

  expect(runId).toMatch(/^[0-9a-f-]{36}$/)

  return runId
}

test('actual Start selects a template and retries an unconfirmed intent through the original Run', async () => {
  test.skip(!inputFile, 'Opt-in: run the APEX Start PostgreSQL/HTTP orchestrator')
  test.setTimeout(180_000)
  const input = JSON.parse(fs.readFileSync(inputFile!, 'utf8')) as { base: string; output: string; peerLost?: boolean }
  allowErrorBanners()
  expect(new URL(input.base).hostname).toBe('127.0.0.1')
  let fixture: PackagedMockBackendFixture | undefined
  let peer: Page | undefined
  let peerRunId: string | undefined
  const windowIds: Array<null | string> = []
  const expectedErrors = ['真实工作流启动失败，目标草稿已保留，请重试。']
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
    const brief = 'Fixture goal: monitor competitors; no actual Agent execution'
    const { goal, submit } = await prepareStart(page, brief)
    await submit.click()
    const failed = page.getByRole('alert').filter({ hasText: '真实工作流启动失败' })
    await expect(failed).toHaveText('真实工作流启动失败，目标草稿已保留，请重试。')
    expect(await pageAlerts(page)).toEqual(expectedErrors)
    await expect(goal).toHaveValue(brief)
    await expect(submit).toBeEnabled()
    expect(page.url()).not.toContain('/workflow-runs/')

    if (input.peerLost) {
      windowIds.push(await page.evaluate(() => sessionStorage.getItem('apex.workflow.start-window')))
      const nextWindow = fixture.app.waitForEvent('window')

      expect(await page.evaluate(() => (window as StartWindow).hermesDesktop!.openWindow())).toEqual({ ok: true })
      peer = await nextWindow
      installErrorBannerGuard(peer)
      await waitForAppReady({ ...fixture, page: peer }, 120_000)
      const peerWindow = await fixture.app.browserWindow(peer)

      await peerWindow.evaluate(win => { win.show(); win.focus() })
      await expect.poll(() => peer!.evaluate(() => document.hasFocus() && document.visibilityState === 'visible')).toBe(true)
      const peerControls = await prepareStart(peer, brief)

      await peerControls.submit.click()
      peerRunId = await expectQueuedRun(peer)
      expect(await pageAlerts(peer)).toEqual([])
      windowIds.push(await peer.evaluate(() => sessionStorage.getItem('apex.workflow.start-window')))
      expect(windowIds[0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(windowIds[1]).toMatch(/^[0-9a-f-]{36}$/)
      expect(windowIds[1]).not.toBe(windowIds[0])
      // The peer acknowledged the shared intent, but this window still owns its lost reply.
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key =>
        key.startsWith('apex.workflow.pending-start.') && !key.includes('.window.')).length)).toBe(0)
      fs.writeFileSync(path.join(path.dirname(input.output), 'peer-queued-ui.png'), await peer.screenshot())
      const originalWindow = await fixture.app.browserWindow(page)

      await originalWindow.evaluate(win => { win.show(); win.focus() })
      await expect.poll(() => page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible')).toBe(true)
      await expect(failed).toHaveText(expectedErrors[0])
      await expect(goal).toHaveValue(brief)
      await expect(submit).toBeEnabled()
    }

    await submit.click()
    const runId = await expectQueuedRun(page)

    if (input.peerLost) {expect(runId).toBe(peerRunId)}

    const saved = await page.evaluate(async () => {
      const bridge = (window as StartWindow).hermesDesktop!.workflowDomain
      const projects = await bridge.listProjects!()
      const workflows = await bridge.listWorkflows!()

      return { projects, workflows }
    })

    expect(saved.projects).toMatchObject({ ok: true, total: 1, items: [{ objective: brief }] })
    expect(saved.workflows.items).toHaveLength(1)
    expect(await pageAlerts(page)).toEqual(expectedErrors)

    if (peer) {expect(await pageAlerts(peer)).toEqual([])}
    fs.writeFileSync(path.join(path.dirname(input.output), 'queued-ui.png'), await page.screenshot())
    fs.writeFileSync(input.output, JSON.stringify({ root: sandbox.userDataDir, runId, peerRunId, windowIds, saved }))
    completed = true
  } finally {
    if (fixture) {
      const banners = fixture.page.isClosed() ? undefined : await pageAlerts(fixture.page)
      const peerBanners = peer && !peer.isClosed() ? await pageAlerts(peer) : []
      let cleanupError: unknown

      try { await fixture.cleanup() } catch (error) { cleanupError = error }

      if (completed) {
        expect(banners).toEqual(expectedErrors)
        expect(peerBanners).toEqual([])
        expect(cleanupError).toBeUndefined()
        expect(fs.existsSync(fixture.sandbox.userDataDir)).toBe(false)
      }
    }
  }
})
