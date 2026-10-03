import fs from 'node:fs'
import path from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import { collectErrorBanners, expect, test } from './test'

/** Output bytes are a fixture, not a claim that a model/Hypit authored or verified them. */
export async function verifyWorkspaceReport(app: ElectronApplication, page: Page) {
  const draft = await page.getByRole('textbox', { name: '业务目标' }).inputValue()
  const directory = JSON.parse(draft.trim().split('\n').at(-1)!) as string
  expect(draft.length).toBeLessThan(4000)
  expect(path.basename(path.dirname(directory))).toBe('attempts')
  const binding = JSON.parse(fs.readFileSync(path.join(directory, 'apex-source.json'), 'utf8'))
  expect(binding.workspace_id).toBe(path.basename(directory))

  const read = () => page.evaluate(async input => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments

    return api.readDeepChat!(input.source_id, input.scope, input.revision)
  }, binding)

  expect((await read()).item).toBeNull()
  await page.getByRole('button', { name: '开始执行', exact: true }).click()
  await expect.poll(async () => (await read()).item?.workspaceId, { timeout: 30_000 }).toBe(binding.workspace_id)
  const body = '# [本地测试] 工作目录报告\n<script>window.workspaceExecuted = true</script>'
  fs.writeFileSync(path.join(directory, 'ANALYSIS.md'), body)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  if (await page.locator('details.analysis-conversation-advanced').getAttribute('open') === null) {await page.locator('details.analysis-conversation-advanced > summary').click()}
  const tools = page.locator('details.analysis-conversation-advanced')
  if (await tools.getAttribute('open') === null) {await tools.locator(':scope > summary').click()}
  const reports = page.getByRole('region', { name: '深度分析报告' })
  await reports.getByRole('button', { name: '收取 ANALYSIS.md' }).click()
  await expect(reports.locator('summary')).toContainText('ANALYSIS.md')
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '开始' }).first().click()
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  if (await page.locator('details.analysis-conversation-advanced').getAttribute('open') === null) {await page.locator('details.analysis-conversation-advanced > summary').click()}
  if (await tools.getAttribute('open') === null) {await tools.locator(':scope > summary').click()}
  await reports.locator('summary').click()
  await expect(reports.locator('pre')).toHaveText(body)
  await expect(reports.locator('script')).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 780, height: 800 }, false))
  await reports.getByRole('button', { name: '收取 TIMELINE.md' }).scrollIntoViewIfNeeded()
  await expect(reports.getByRole('button', { name: '收取 TIMELINE.md' })).toBeInViewport()
  await expect(reports.getByRole('button', { name: '收取 ANALYSIS.md' })).toBeInViewport()
  await test.info().attach('hc887-narrow-report-ui', { body: await page.screenshot(), contentType: 'image/png' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1220, height: 800 }, false))

  await reports.getByLabel('验收备注').fill('[本地测试] 我已核对原文引用')
  await reports.getByRole('button', { name: '标记可用', exact: true }).click()
  await expect(reports).toContainText('你已标记可用')

  const saved = await page.evaluate(async id => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments

    return (await api.get(id)).item!
  }, binding.source_id)

  expect(saved.analysis_scope).toBe(binding.scope)
  expect(saved.analysis_revision).toBe(binding.revision)
  expect(saved.deep_reports).toHaveLength(1)
  expect(saved.deep_reports![0].body).toBe(body)
  expect(saved.deep_reports![0].collection?.workspace_id).toBe(binding.workspace_id)
  expect(saved.deep_reports![0].review).toMatchObject({ decision: 'accepted', note: '[本地测试] 我已核对原文引用' })
  expect(Object.keys(saved.deep_reports![0].collection!).every(key => ['workspace_id', 'submitted_at', 'turn_id', 'observed_status'].includes(key))).toBe(true)
  await reports.getByRole('button', { name: '收取 ANALYSIS.md' }).click()
  await expect(reports.locator('summary')).toHaveCount(1)
  // Preparing alone leaves the accepted output selected. A second accepted draft must never consume it.
  await tools.getByRole('button', { name: '准备深度拆解' }).click()
  const secondDraft = await page.getByRole('textbox', { name: '业务目标' }).inputValue()
  const secondDirectory = JSON.parse(secondDraft.trim().split('\n').at(-1)!) as string
  const secondBinding = JSON.parse(fs.readFileSync(path.join(secondDirectory, 'apex-source.json'), 'utf8'))
  expect(secondDirectory).not.toBe(directory)
  expect(fs.existsSync(path.join(secondDirectory, 'ANALYSIS.md'))).toBe(false)
  expect((await read()).item?.workspaceId).toBe(binding.workspace_id)

  const pendingCollection = await page.evaluate(async input => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments

    return api.collectDeepReport!(input.source_id, input.scope, input.revision, 'ANALYSIS.md')
  }, binding)

  expect(pendingCollection.item?.body).toBe(body)
  expect(pendingCollection.item?.review).toEqual(saved.deep_reports![0].review)
  await page.getByRole('button', { name: '开始执行', exact: true }).click()
  await expect.poll(async () => (await read()).item?.workspaceId, { timeout: 30_000 }).toBe(secondBinding.workspace_id)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  if (await page.locator('details.analysis-conversation-advanced').getAttribute('open') === null) {await page.locator('details.analysis-conversation-advanced > summary').click()}
  await reports.getByRole('button', { name: '收取 ANALYSIS.md' }).click()
  await expect(reports.getByRole('alert')).toHaveText('指定报告尚未生成。请在助手完成后重试。')
  await expect(reports.locator('summary')).toHaveCount(1)
  const secondBody = '# [本地测试] Second submission output'
  fs.writeFileSync(path.join(secondDirectory, 'ANALYSIS.md'), secondBody)
  await reports.getByRole('button', { name: '收取 ANALYSIS.md' }).click()
  await expect(reports.locator('summary')).toHaveCount(2)
  await reports.locator('summary').last().click()
  await expect(reports.locator('pre').last()).toHaveText(secondBody)
  await expect(reports.locator('article').last()).toContainText('待你验收')
  // Preserve and assert the browser history before reload clears its observer.
  expect(await collectErrorBanners(page)).toEqual(['当前画面无法截取，请先播放或跳到可播放的时间。', '指定报告尚未生成。请在助手完成后重试。'])
  await page.reload()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  if (await page.locator('details.analysis-conversation-advanced').getAttribute('open') === null) {await page.locator('details.analysis-conversation-advanced > summary').click()}
  await reports.locator('summary').first().click()
  await expect(reports.locator('article').first()).toContainText('你已标记可用')
  await expect(reports.locator('article').first().getByLabel('验收备注')).toHaveValue('[本地测试] 我已核对原文引用')

  const reopened = await page.evaluate(async id => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments

    return (await api.get(id)).item!.deep_reports!
  }, binding.source_id)

  expect(reopened[0].collection?.workspace_id).toBe(binding.workspace_id)
  expect(reopened[1].collection?.workspace_id).toBe(secondBinding.workspace_id)
  expect(reopened[1].review).toBeUndefined()
  await test.info().attach('hc893-reopened-review', { body: JSON.stringify(reopened), contentType: 'application/json' })
  expect(fs.readFileSync(path.join(directory, 'ANALYSIS.md'), 'utf8')).toBe(body)
  await test.info().attach('hc892-separated-outputs', { body: JSON.stringify({ binding, secondBinding, pendingCollection, accepted: (await read()).item, secondBody, outputAuthor: 'test fixture' }), contentType: 'application/json' })
  await test.info().attach('hc892-output-ui', { body: await page.screenshot(), contentType: 'image/png' })
  await page.getByRole('button', { name: '删除资料' }).click()
  expect(fs.existsSync(secondDirectory)).toBe(false)
  await expect(page.getByRole('button', { name: /local-review-video-transcript.srt/ })).toHaveCount(0)
  expect(fs.existsSync(directory)).toBe(false)
  await test.info().attach('hc887-workspace-report', { body: JSON.stringify({ binding, report: saved.deep_reports![0], removedWithSource: true, outputAuthor: 'test fixture' }), contentType: 'application/json' })
}
