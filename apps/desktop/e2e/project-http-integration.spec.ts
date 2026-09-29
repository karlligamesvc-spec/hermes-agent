import fs from 'node:fs'
import path from 'node:path'

import type { WorkflowDomainBridge } from '../src/app/business-workspace/api/types'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { allowErrorBanners, collectErrorBanners, expect, test } from './test'

interface ProjectInput {
  base: string
  phase: 'create' | 'complete' | 'reopen'
  projectId: string
  runId: string
  deliverableId: string
  createdId?: string
  output: string
}
interface ProjectWindow extends Window {
  hermesDesktop?: {
    workflowDomain: WorkflowDomainBridge
    managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean; hasRelayKey: boolean }> }
  }
}

const inputFile = process.env.APEX_PROJECT_INTEGRATION_INPUT

test('packaged Project UI preserves failed input and shares canonical lifecycle and deliverables', async () => {
  test.skip(!inputFile, 'Opt-in: run the APEX Project PostgreSQL/HTTP orchestrator')
  test.setTimeout(180_000)
  const input = JSON.parse(fs.readFileSync(inputFile!, 'utf8')) as ProjectInput

  allowErrorBanners() // The exact one-shot503 alert is asserted while visible and before cleanup.
  expect(new URL(input.base).hostname).toBe('127.0.0.1')
  let fixture: PackagedMockBackendFixture | undefined
  let completed = false
  const expectedErrors: string[] = []

  try {
    fixture = await setupPackagedMockBackend({ APEXNODES_API_BASE: input.base, APEXNODES_AUTH_BASE: input.base })
    const { page, mockUrl, sandbox } = fixture
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })

    if (await later.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {await later.click()}
    await waitForAppReady(fixture, 120_000)

    const signIn = async (email: string) => {
      const result = await page.evaluate(({ email, password }) =>
        (window as ProjectWindow).hermesDesktop!.managed.signIn({ email, password }), { email, password: mockUrl })

      expect(result).toMatchObject({ ok: true, hasRelayKey: true })
    }

    const projects = async () => {
      await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
      await expect(page.locator('[data-workflow-project-list]')).toBeVisible()
    }

    const openProject = async (name: string, id: string) => {
      await projects()
      await page.locator('[data-workflow-project-list]').getByRole('button').filter({ hasText: name }).click()
      await expect(page.locator('[data-project-detail]').getByRole('heading', { name, exact: true })).toBeVisible()
      expect(page.url()).toContain(id)
    }

    const openDeliverables = async () => {
      await page.getByRole('button', { name: /打开账户菜单/ }).click()
      await page.getByRole('menuitem', { name: '交付物', exact: true }).click()
      await expect(page.locator('[data-deliverables-page]')).toBeVisible()
    }

    const assertDeliverable = async () => {
      const detail = page.locator('[data-deliverable-detail]')

      await expect(detail.getByRole('heading', { name: 'Fixture deliverable', exact: true })).toBeVisible()
      await expect(detail).toContainText('Fixture lifecycle project')
      await expect(detail).toContainText(input.runId)
      await expect(detail).toContainText('Fixture result, not Hermes execution')
      await expect(detail).toContainText('Selected fixture bytes.')
      expect(page.url()).toContain(input.deliverableId)
    }

    await signIn('owner@fixture.test')
    const access = await page.evaluate(() => (window as ProjectWindow).hermesDesktop!.workflowDomain.access())
    expect(access).toEqual({ available: true })
    let result: object

    if (input.phase === 'create') {
      await projects()
      await page.getByRole('button', { name: '新建项目', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '新建项目' })
      await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('Created UI project')
      await dialog.getByRole('textbox', { name: '项目描述与目标', exact: true }).fill('Preserved UI objective')
      await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
      const failure = '项目创建失败。输入内容已保留，请检查连接后重试。'
      expectedErrors.push(failure)
      await expect(dialog.getByRole('alert')).toHaveText(failure)
      expect(await collectErrorBanners(page)).toEqual(expectedErrors)
      await expect(dialog.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue('Created UI project')
      await expect(dialog.getByRole('textbox', { name: '项目描述与目标', exact: true })).toHaveValue('Preserved UI objective')
      await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeEnabled()
      fs.writeFileSync(path.join(path.dirname(input.output), 'create-failed-ui.png'), await page.screenshot())
      const before = await page.evaluate(() => (window as ProjectWindow).hermesDesktop!.workflowDomain.listProjects!())
      expect(before.items?.map(item => item.id)).toEqual([input.projectId])

      await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const detail = page.locator('[data-project-detail]')
      await expect(detail.getByRole('heading', { name: 'Created UI project', exact: true })).toBeVisible()
      const after = await page.evaluate(() => (window as ProjectWindow).hermesDesktop!.workflowDomain.listProjects!())
      expect(after.items).toHaveLength(2)
      const created = after.items!.find(item => item.name === 'Created UI project')!
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(page.url()).toContain(created.id)
      await expect(detail.getByRole('button', { name: '完成项目', exact: true })).toBeDisabled()
      await detail.getByRole('button', { name: '编辑项目', exact: true }).click()
      const edit = page.getByRole('dialog', { name: '编辑项目' })
      await edit.getByRole('textbox', { name: '项目名称', exact: true }).fill('Edited UI project')
      await edit.getByRole('textbox', { name: '项目描述与目标', exact: true }).fill('Edited UI objective')
      await edit.getByRole('button', { name: '保存修改', exact: true }).click()
      await expect(edit).toHaveCount(0)
      await expect(detail.getByRole('heading', { name: 'Edited UI project', exact: true })).toBeVisible()
      await expect(detail).toContainText('Edited UI objective')
      result = { root: sandbox.userDataDir, createdId: created.id }
    } else {
      // A clean client must see the prior client's edited Project.
      await openProject('Edited UI project', input.createdId!)
      await expect(page.locator('[data-project-detail]')).toContainText('Edited UI objective')
      await page.keyboard.press('Escape')
      await openProject('Fixture lifecycle project', input.projectId)
      const detail = page.locator('[data-project-detail]')
      const lifecycle = detail.locator('[data-project-completion]')

      if (input.phase === 'complete') {
        await expect(lifecycle).toContainText('待验收')
        await expect(lifecycle.getByRole('button', { name: '完成项目', exact: true })).toBeEnabled()
        await detail.locator('[data-project-workflows]').getByRole('button', { name: '打开当前运行', exact: true }).click()
        const run = page.locator('[data-run-scroll-container]')
        await expect(run).toContainText('Hermes')
        expect(page.url()).toContain(input.runId)
        await run.locator('article').filter({ hasText: 'Fixture deliverable' })
          .getByRole('button', { name: '打开交付物', exact: true }).click()
        await assertDeliverable()
        await page.keyboard.press('Escape')
        await openDeliverables()
        await page.locator('[data-deliverables-page]').getByRole('button').filter({ hasText: 'Fixture deliverable' }).click()
        await assertDeliverable()
        await page.keyboard.press('Escape')
        await openProject('Fixture lifecycle project', input.projectId)
        await lifecycle.getByRole('button', { name: '完成项目', exact: true }).click()
        await expect(lifecycle.getByRole('button', { name: '重新打开项目', exact: true })).toBeEnabled()
        await expect(detail.getByRole('button', { name: '增加工作流', exact: true })).toBeDisabled()
      } else {
        await expect(lifecycle.getByRole('button', { name: '重新打开项目', exact: true })).toBeEnabled()
        await lifecycle.getByRole('button', { name: '重新打开项目', exact: true }).click()
        await expect(lifecycle).toContainText('待验收')
        await expect(lifecycle.getByRole('button', { name: '完成项目', exact: true })).toBeEnabled()
        await expect(detail.getByRole('button', { name: '增加工作流', exact: true })).toBeEnabled()
        await page.keyboard.press('Escape')
        await openDeliverables()
        await page.locator('[data-deliverables-page]').getByRole('button').filter({ hasText: 'Fixture deliverable' }).click()
        await assertDeliverable()
      }

      const canonical = await page.evaluate(async input => {
        const bridge = (window as ProjectWindow).hermesDesktop!.workflowDomain

        return { project: await bridge.getProject!(input.projectId), run: await bridge.getRun(input.runId),
          deliverable: await bridge.getDeliverable!(input.deliverableId) }
      }, input)

      expect(canonical.project.item).toMatchObject({ id: input.projectId, status: input.phase === 'complete' ? 'completed' : 'active' })
      expect(canonical.deliverable).toMatchObject({ ok: true, detail: {
        item: { id: input.deliverableId, projectId: input.projectId, runId: input.runId },
        project: { id: input.projectId }, run: { id: input.runId }
      } })
      expect(canonical.run).toMatchObject({ ok: true, overview: { run: { id: input.runId, status: 'succeeded' },
        deliverables: [{ id: input.deliverableId, title: 'Fixture deliverable' }] } })

      if (input.phase === 'reopen') {
        await signIn('other@fixture.test')
        await expect(page.locator('[data-deliverable-detail]')).toHaveCount(0)
        await expect(page.getByText('Fixture result, not Hermes execution', { exact: true })).toHaveCount(0)

        const denied = await page.evaluate(async input => {
          const bridge = (window as ProjectWindow).hermesDesktop!.workflowDomain

          return { list: await bridge.listProjects!(), deliverables: await bridge.listDeliverables!(),
            project: await bridge.getProject!(input.projectId), completion: await bridge.getProjectCompletion!(input.projectId),
            update: await bridge.updateProject!({ projectId: input.projectId, name: 'Foreign', objective: 'Foreign' }),
            complete: await bridge.completeProject!(input.projectId), reopen: await bridge.reopenProject!(input.projectId),
            run: await bridge.getRun(input.runId), deliverable: await bridge.getDeliverable!(input.deliverableId),
            review: await bridge.reviewDeliverable({ deliverableId: input.deliverableId, status: 'approved' }) }
        }, input)

        expect(denied.list).toMatchObject({ ok: true, items: [] })
        expect(denied.deliverables).toMatchObject({ ok: true, items: [] })

        for (const key of ['project', 'completion', 'update', 'complete', 'reopen', 'run', 'deliverable', 'review'] as const) {
          expect(denied[key].ok).toBe(false)
        }

        result = { root: sandbox.userDataDir, canonical, denied }
      } else {
        result = { root: sandbox.userDataDir, canonical }
      }
    }

    expect(await collectErrorBanners(page)).toEqual(expectedErrors)
    fs.writeFileSync(path.join(path.dirname(input.output), `${input.phase}-ui.png`), await page.screenshot())
    fs.writeFileSync(input.output, JSON.stringify(result))
    await test.info().attach(`hc898-project-${input.phase}`, { body: JSON.stringify(result), contentType: 'application/json' })
    completed = true
  } finally {
    if (fixture) {
      const errors = await collectErrorBanners(fixture.page)
      await fixture.cleanup()

      if (completed) {expect(errors).toEqual(expectedErrors)}
    }
  }
})
