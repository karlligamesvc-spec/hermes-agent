import fs from 'node:fs'
import path from 'node:path'

import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { allowErrorBanners, collectErrorBanners, expect, test } from './test'

interface IntegrationInput {
  base: string
  phase: 'save' | 'review' | 'retained'
  sourceId: string
  ownerId: string
  otherId: string
  output: string
  reportId?: string
  sha256?: string
  revision: string
  collection?: { workspace_id: string; submitted_at: string }
  renderer?: boolean
}
interface IntegrationWindow extends Window {
  hermesDesktop?: {
    analysisDocuments: AnalysisDocumentsBridge
    managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean; hasRelayKey: boolean }> }
  }
}

const inputFile = process.env.APEX_ANALYSIS_INTEGRATION_INPUT

test('packaged cloud reports survive an independent client and enforce account policy', async () => {
  test.skip(!inputFile, 'Opt-in: run the APEX PostgreSQL/HTTP orchestrator')
  test.setTimeout(180_000)
  const input = JSON.parse(fs.readFileSync(inputFile!, 'utf8')) as IntegrationInput

  if (input.renderer) {allowErrorBanners()} // Exact expected failures are asserted and captured below.
  expect(new URL(input.base).hostname).toBe('127.0.0.1')
  let fixture: PackagedMockBackendFixture | undefined
  const expectedErrors: string[] = []
  let completed = false

  try {
    fixture = await setupPackagedMockBackend({ APEXNODES_API_BASE: input.base, APEXNODES_AUTH_BASE: input.base })
    const { page, mockUrl, sandbox } = fixture
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })

    if (await later.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {await later.click()}
    await waitForAppReady(fixture, 120_000)

    // The fixture login issues a real server JWT. The analysis routes have no overrides.
    const signIn = async (email: string) => {
      const result = await page.evaluate(({ email, password }) =>
        (window as IntegrationWindow).hermesDesktop!.managed.signIn({ email, password }), { email, password: mockUrl })

      expect(result).toMatchObject({ ok: true, hasRelayKey: true })
    }

    await signIn('owner@fixture.test')
    const source = await page.evaluate(id => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.get(id), input.sourceId)
    expect(source.ok).toBe(true)
    expect(source.item).toMatchObject({ id: input.sourceId, analysis_scope: input.ownerId, analysis_revision: input.revision, storageMode: 'cloud' })
    const listing = await page.evaluate(() => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.list())
    expect(listing.cloudUnavailable).toBe(false)
    expect(listing.items?.map(item => item.id)).toContain(input.sourceId)
    let result: unknown

    const openReport = async () => {
      await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
      await page.getByRole('button', { name: /fixture\.srt/ }).click()
      const reports = page.getByRole('region', { name: '深度分析报告' })
      await reports.locator('summary').click()
      await expect(reports.locator('pre')).toHaveText('# Fixture cloud report\nSelected bytes, not model evidence.')
      await expect(reports).toContainText('发送信息由收取设备记录，不证明报告作者或 Hypit 执行。')
      await expect(reports).toContainText(input.collection!.workspace_id.slice(0, 8))
      await expect(reports.locator('time').first()).toHaveAttribute('datetime', input.collection!.submitted_at)

      return reports
    }

    if (input.phase === 'save') {
      const workspace = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .prepareDeepWorkspace(input.sourceId, input.ownerId, input.revision), input)

      expect(workspace.ok).toBe(true)
      expect(workspace.directory!.startsWith(fs.realpathSync(sandbox.userDataDir) + path.sep)).toBe(true)

      // This receipt and report are explicit fixtures, not evidence of an Agent run.
      const receipt = await page.evaluate(({ input, workspaceId }) => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .recordDeepChat!(input.sourceId, input.ownerId, input.revision,
          { sessionId: 'fixture-session-not-executed', connectionId: null, profile: 'default', workspaceId }),
      { input, workspaceId: workspace.workspaceId })

      expect(receipt.ok).toBe(true)
      fs.writeFileSync(path.join(workspace.directory!, 'ANALYSIS.md'), '# Fixture cloud report\nSelected bytes, not model evidence.')

      const saved = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .collectDeepReport!(input.sourceId, input.ownerId, input.revision, 'ANALYSIS.md'), input)

      expect(saved.ok).toBe(true)
      expect(saved.item).toMatchObject({ provenance: 'selected_file', revision: input.revision,
        body: '# Fixture cloud report\nSelected bytes, not model evidence.',
        collection: { workspace_id: workspace.workspaceId, submitted_at: receipt.item!.submittedAt } })
      expect(Object.keys(saved.item!.collection!).sort()).toEqual(['submitted_at', 'workspace_id'])
      result = { report: saved.item, root: sandbox.userDataDir }
    } else {
      expect(source.item!.deep_reports).toHaveLength(1)
      const report = source.item!.deep_reports![0]
      expect(report).toMatchObject({ id: input.reportId, sha256: input.sha256, collection: input.collection })

      const localReceipt = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .readDeepChat!(input.sourceId, input.ownerId, input.revision), input)

      expect(localReceipt).toEqual({ ok: true, item: null })

      const reports = input.renderer ? await openReport() : undefined
      let reviewed

      if (reports) {
        if (input.phase === 'review') {
          await expect(reports).toContainText('待你验收')
          await reports.getByLabel('验收备注').fill('Reviewed on another client')
        } else {
          await expect(reports).toContainText('你已标记可用')
          await expect(reports.getByLabel('验收备注')).toHaveValue('Reviewed on another client')
        }

        const failure = '操作失败，请检查登录和资料保存设置后重试。'
        expectedErrors.push(failure)
        await reports.getByRole('button', { name: '标记可用', exact: true }).click()
        await expect(reports.getByRole('alert')).toHaveText(failure)
        expect(await collectErrorBanners(page)).toEqual(expectedErrors)
        fs.writeFileSync(path.join(path.dirname(input.output), `${input.phase}-failed-write-ui.png`), await page.screenshot())
        await expect(reports.locator('pre')).toHaveText(report.body)
        await expect(reports.getByLabel('验收备注')).toHaveValue('Reviewed on another client')
        await expect(reports.getByRole('button', { name: '标记可用', exact: true })).toBeEnabled()
        const unchanged = await page.evaluate(id => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.get(id), input.sourceId)
        expect(unchanged.item!.deep_reports![0]).toEqual(report)

        if (input.phase === 'review') {
          await expect(reports).toContainText('待你验收')
          await reports.getByRole('button', { name: '标记可用', exact: true }).click()
          await expect(reports.getByRole('alert')).toHaveCount(0)
          await expect(reports).toContainText('你已标记可用')
          await expect(reports.getByLabel('验收备注')).toHaveValue('Reviewed on another client')
          const saved = await page.evaluate(id => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.get(id), input.sourceId)
          reviewed = { ok: saved.ok, item: saved.item!.deep_reports![0] }
        } else {
          await expect(reports).toContainText('你已标记可用')
          reviewed = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
            .reviewDeepReport!(input.sourceId, input.ownerId, input.reportId!,
              { revision: input.revision, sha256: input.sha256!, decision: 'accepted', note: 'Reviewed on another client' }), input)
        }

        fs.writeFileSync(path.join(path.dirname(input.output), `${input.phase}-ui.png`), await page.screenshot())
      } else {
        reviewed = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
          .reviewDeepReport!(input.sourceId, input.ownerId, input.reportId!,
            { revision: input.revision, sha256: input.sha256!, decision: 'accepted', note: 'Reviewed on another client' }), input)
      }

      if (input.phase === 'review') {
        expect(reviewed.ok).toBe(true)
        expect(reviewed.item!.review).toMatchObject({ decision: 'accepted', note: 'Reviewed on another client' })
        expect(reviewed.item!.collection).toEqual(input.collection)
        await signIn('other@fixture.test')

        if (input.renderer) {
          await expect(page.getByRole('region', { name: '深度分析报告' })).toHaveCount(0)
          await expect(page.getByRole('button', { name: /fixture\.srt/ })).toHaveCount(0)
          await expect(page.getByText('尚无资料。导入文档或 SRT/VTT 字幕开始。', { exact: true })).toBeVisible()
        }

        const denied = await page.evaluate(async input => {
          const api = (window as IntegrationWindow).hermesDesktop!.analysisDocuments

          return { list: await api.list(), get: await api.get(input.sourceId),
            review: await api.reviewDeepReport!(input.sourceId, input.otherId, input.reportId!,
              { revision: input.revision, sha256: input.sha256!, decision: 'changes_requested', note: 'Foreign user' }),
            remove: await api.deleteDeepReport(input.sourceId, input.otherId, input.reportId!) }
        }, input)

        expect(denied.list).toMatchObject({ ok: true, cloudUnavailable: false, items: [] })

        for (const outcome of [denied.get, denied.review, denied.remove]) {expect(outcome).toEqual({ ok: false, code: 'source_not_found' })}
        result = { report: reviewed.item, denied, root: sandbox.userDataDir }
      } else {
        expect(report.review).toMatchObject({ decision: 'accepted', note: 'Reviewed on another client' })
        expect(reviewed).toEqual({ ok: false, code: 'analysis_cloud_storage_disabled' })

        if (reports) {
          await reports.getByRole('button', { name: '删除副本 · ANALYSIS.md', exact: true }).click()
          await expect(reports.locator('summary')).toHaveCount(0)
          await expect(reports).toContainText('尚未保存报告。')
          await expect(page.getByRole('button', { name: /fixture\.srt/ })).toBeVisible()
        } else {
          const removed = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
            .deleteDeepReport(input.sourceId, input.ownerId, input.reportId!), input)

          expect(removed).toEqual({ ok: true })
        }

        const kept = await page.evaluate(id => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.get(id), input.sourceId)
        expect(kept.ok).toBe(true)
        expect(kept.item!.deep_reports).toEqual([])
        expect(kept.item!.anchors).toHaveLength(1)
        result = { retained: kept.item, deniedWrite: reviewed, root: sandbox.userDataDir }
      }
    }

    expect(await collectErrorBanners(page)).toEqual(expectedErrors)
    fs.writeFileSync(input.output, JSON.stringify(result))
    await test.info().attach(`${input.renderer ? 'hc897-renderer' : 'hc896-native'}-${input.phase}`, { body: JSON.stringify(result), contentType: 'application/json' })
    completed = true
  } finally {
    if (fixture) {
      const errors = await collectErrorBanners(fixture.page)
      await fixture.cleanup()

      if (completed) {expect(errors).toEqual(expectedErrors)}
    }
  }
})
