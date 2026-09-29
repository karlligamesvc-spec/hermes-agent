import fs from 'node:fs'
import path from 'node:path'

import type { Page } from '@playwright/test'

import type { WorkflowDomainBridge } from '../src/app/business-workspace/api/types'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { pageErrorHistory } from './page-error-history'
import { allowErrorBanners, expect, installErrorBannerGuard, test } from './test'

interface RefreshInput {
  base: string
  projectId: string
  runId: string
  output: string
}
interface RefreshWindow extends Window {
  hermesDesktop?: {
    openWindow: () => Promise<{ ok: boolean }>
    workflowDomain: WorkflowDomainBridge
    managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean; hasRelayKey: boolean }> }
  }
}
interface RefreshClient {
  fixture: PackagedMockBackendFixture
  expectedErrors: string[]
  closed: boolean
  alerts: () => Promise<string[]>
}
const inputFile = process.env.APEX_WORKFLOW_REFRESH_INTEGRATION_INPUT

async function ready(fixture: PackagedMockBackendFixture) {
  const { page, mockUrl } = fixture
  await page.getByRole('button', { name: '使用自己的密钥' }).click()
  const later = page.getByRole('button', { name: '稍后再选择提供方' })

  if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {await later.click()}
  await waitForAppReady(fixture, 120_000)
  const signedIn = await page.evaluate(password => (window as RefreshWindow).hermesDesktop!.managed.signIn({ email: 'owner@fixture.test', password }), mockUrl)
  expect(signedIn).toMatchObject({ ok: true, hasRelayKey: true })
}

async function projects(page: Page) {
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
  await expect(page.locator('[data-workflow-project-list]')).toBeVisible()
}

async function editProject(page: Page, name: string, next: string) {
  await projects(page)
  await page.locator('[data-workflow-project-list]').getByRole('button').filter({ hasText: name }).click()
  await expect(page.locator('[data-project-detail]').getByRole('heading', { name, exact: true })).toBeVisible()
  await page.locator('[data-project-detail]').getByRole('button', { name: '编辑项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑项目' })
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill(next)
  await dialog.getByRole('textbox', { name: '项目描述与目标', exact: true }).fill(`${next} objective`)

  return dialog.getByRole('button', { name: '保存修改', exact: true })
}

async function focus(fixture: PackagedMockBackendFixture, page: Page) {
  const handle = await fixture.app.browserWindow(page)
  await handle.evaluate(win => {win.show(); win.focus()})
  await expect.poll(() => page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible')).toBe(true)
}

test('mounted HTTP projections reconcile peer windows, independent clients and background writes', async ({ request }) => {
  test.skip(!inputFile, 'Opt-in: run the Workflow refresh PostgreSQL/HTTP orchestrator')
  test.setTimeout(200_000)
  allowErrorBanners()
  const input = JSON.parse(fs.readFileSync(inputFile!, 'utf8')) as RefreshInput
  expect(new URL(input.base).hostname).toBe('127.0.0.1')
  const clients: RefreshClient[] = []
  let completed = false
  let peer: Page | undefined
  let peerAlerts: (() => Promise<string[]>) | undefined

  try {
    const receiver = await setupPackagedMockBackend({ APEXNODES_API_BASE: input.base, APEXNODES_AUTH_BASE: input.base })

    const receiverClient: RefreshClient = { fixture: receiver, expectedErrors: [], closed: false,
      alerts: await pageErrorHistory(receiver.page) }

    clients.push(receiverClient)
    await ready(receiver)
    await projects(receiver.page)
    const row = receiver.page.locator('[data-workflow-project-list]').getByRole('button').filter({ hasText: 'Refresh fixture project' })
    await expect(row).toBeVisible()
    const nextWindow = receiver.app.waitForEvent('window')
    expect(await receiver.page.evaluate(() => (window as RefreshWindow).hermesDesktop!.openWindow())).toEqual({ ok: true })
    peer = await nextWindow
    installErrorBannerGuard(peer)
    peerAlerts = await pageErrorHistory(peer)
    await waitForAppReady({ ...receiver, page: peer }, 120_000)
    await focus(receiver, peer)
    const savePeer = await editProject(peer, 'Refresh fixture project', 'Peer window edit')
    await receiver.page.evaluate(() => {
      const observed: unknown[] = []
      const channel = new BroadcastChannel('apex:workflow-domain')
      channel.onmessage = event => observed.push(event.data)
      Object.assign(window, { __workflowSignal: { observed, channel } })
    })
    await focus(receiver, receiver.page)
    const peerStart = Date.now()
    // Dispatch the real React control while the peer is in the background; no fake bridge or clock.
    await savePeer.dispatchEvent('click')
    await expect(receiver.page.locator('[data-workflow-project-list]')).toContainText('Peer window edit', { timeout: 5000 })
    const peerElapsed = Date.now() - peerStart
    expect(peerElapsed).toBeLessThan(15_000)
    const signals = await receiver.page.evaluate(() => (window as unknown as { __workflowSignal: { observed: unknown[] } }).__workflowSignal.observed)
    expect(signals).toEqual([1])
    expect(await peerAlerts()).toEqual([])
    await peer.close()
    peer = undefined

    const writer = await setupPackagedMockBackend({ APEXNODES_API_BASE: input.base, APEXNODES_AUTH_BASE: input.base })

    const writerClient: RefreshClient = { fixture: writer, expectedErrors: [], closed: false,
      alerts: await pageErrorHistory(writer.page) }

    clients.push(writerClient)
    await ready(writer)
    await focus(writer, writer.page)
    const saveIndependent = await editProject(writer.page, 'Peer window edit', 'Independent client edit')
    const progress = async () => (await request.get(`${input.base}/fixture/read-progress`)).json() as Promise<{ finished: number; pending: number }>
    await expect.poll(async () => (await progress()).pending).toBe(0)
    const beforeFocus = (await progress()).finished
    await focus(receiver, receiver.page)
    const independentStart = Date.now()
    await expect.poll(async () => {
      const current = await progress()

      return current.finished > beforeFocus && current.pending === 0
    }).toBe(true)
    await saveIndependent.dispatchEvent('click')
    await expect(writer.page.locator('[data-project-detail]').getByRole('heading', { name: 'Independent client edit', exact: true })).toBeVisible()
    // The focused receiver must obtain this independent profile's write from a real periodic HTTP read.
    await expect(receiver.page.locator('[data-workflow-project-list]')).toContainText('Independent client edit', { timeout: 22_000 })
    const independentElapsed = Date.now() - independentStart
    expect(independentElapsed).toBeGreaterThan(10_000)
    expect(await receiver.page.evaluate(() => (window as unknown as { __workflowSignal: { observed: unknown[] } }).__workflowSignal.observed)).toEqual([1])

    await receiver.page.locator('[data-workflow-project-list]').getByRole('button').filter({ hasText: 'Independent client edit' }).click()
    const detail = receiver.page.locator('[data-project-detail]')
    await expect(detail.locator('[data-project-completion]')).not.toContainText('待验收')
    const background = await request.post(`${input.base}/fixture/background-run`)
    expect(background.status()).toBe(200)
    await expect(detail.locator('[data-project-completion]')).toContainText('待验收', { timeout: 22_000 })
    await expect(detail.locator('[data-project-workflows]')).toContainText('运行成功')
    await expect(detail.getByRole('button', { name: '完成项目', exact: true })).toBeEnabled()
    await expect(detail.getByRole('heading', { name: 'Independent client edit', exact: true })).toBeVisible()
    expect(receiver.page.url()).toContain(input.projectId)
    await receiver.page.keyboard.press('Escape')
    expect(await writerClient.alerts()).toEqual(writerClient.expectedErrors)
    await writer.app.close()
    writerClient.closed = true

    // A real read503 retains confirmed rows, surfaces the error and retries through native HTTP.
    const receiverWindow = await receiver.app.browserWindow(receiver.page)
    await receiverWindow.evaluate(win => win.blur())
    await expect.poll(() => receiver.page.evaluate(() => document.hasFocus())).toBe(false)
    expect((await request.post(`${input.base}/fixture/fail-project-read`)).status()).toBe(200)
    await focus(receiver, receiver.page)
    const notice = receiver.page.locator('[data-workflow-refresh-notice]')
    await expect(notice).toContainText('暂时无法刷新最新状态')
    await expect(receiver.page.locator('[data-workflow-project-list]')).toContainText('Independent client edit')
    receiverClient.expectedErrors.push((await notice.textContent())!.trim())
    expect(await receiverClient.alerts()).toEqual(receiverClient.expectedErrors)
    await notice.getByRole('button', { name: '重试刷新', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect(receiver.page.locator('[data-workflow-project-list]')).toContainText('Independent client edit')

    const actual = await receiver.page.evaluate(input => (window as RefreshWindow).hermesDesktop!.workflowDomain.getProject!(input.projectId), input)
    expect(actual.item).toMatchObject({ id: input.projectId, name: 'Independent client edit', status: 'active', summary: { currentRunId: input.runId, currentRunStatus: 'succeeded' } })
    fs.writeFileSync(path.join(path.dirname(input.output), 'workflow-refresh-ui.png'), await receiver.page.screenshot())
    fs.writeFileSync(input.output, JSON.stringify({ roots: clients.map(client => client.fixture.sandbox.userDataDir), signals, peerElapsed,
      independentElapsed, actual, expectedErrors: clients.map(client => client.expectedErrors) }))
    completed = true
  } finally {
    const peerErrors = await peerAlerts?.() ?? []

    if (peer && !peer.isClosed()) {await peer.close()}
    const errors: Array<{ actual: string[]; expected: string[] }> = []

    for (const client of clients) {
      if (!client.closed && !client.fixture.page.isClosed()) {
        errors.push({ actual: await client.alerts(), expected: client.expectedErrors })
      }
    }

    for (const client of clients.reverse()) {
      if (client.closed) {
        await client.fixture.mock.close()
        client.fixture.sandbox.cleanup()
      } else {
        await client.fixture.cleanup()
        client.closed = true
      }
    }

    if (completed) {
      expect(peerErrors).toEqual([])

      for (const result of errors) {expect(result.actual).toEqual(result.expected)}
    }
  }
})
