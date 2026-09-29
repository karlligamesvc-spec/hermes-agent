import fs from 'node:fs'
import path from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import { expect, test } from './test'

/** Output bytes are a fixture, not a claim that a model/Hypit authored or verified them. */
export async function verifyWorkspaceReport(app: ElectronApplication, page: Page) {
  const draft = await page.getByRole('textbox', { name: '业务目标' }).inputValue()
  const directory = JSON.parse(draft.trim().split('\n').at(-1)!) as string
  expect(draft.length).toBeLessThan(4000)
  expect(path.basename(path.dirname(path.dirname(path.dirname(directory))))).toBe('analysis-workspaces')
  const binding = JSON.parse(fs.readFileSync(path.join(directory, 'apex-source.json'), 'utf8'))
  const body = '# [本地测试] 工作目录报告\n<script>window.workspaceExecuted = true</script>'
  fs.writeFileSync(path.join(directory, 'ANALYSIS.md'), body)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  const reports = page.getByRole('region', { name: '深度分析报告' })
  await reports.getByRole('button', { name: '收取 ANALYSIS.md' }).click()
  await expect(reports.locator('summary')).toContainText('ANALYSIS.md')
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '开始' }).first().click()
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  await reports.locator('summary').click()
  await expect(reports.locator('pre')).toHaveText(body)
  await expect(reports.locator('script')).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 780, height: 800 }, false))
  await reports.getByRole('button', { name: '收取 TIMELINE.md' }).scrollIntoViewIfNeeded()
  await expect(reports.getByRole('button', { name: '收取 TIMELINE.md' })).toBeInViewport()
  await expect(reports.getByRole('button', { name: '收取 ANALYSIS.md' })).toBeInViewport()
  await test.info().attach('hc887-narrow-report-ui', { body: await page.screenshot(), contentType: 'image/png' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1220, height: 800 }, false))

  const saved = await page.evaluate(async id => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments

    return (await api.get(id)).item!
  }, binding.source_id)

  expect(saved.analysis_scope).toBe(binding.scope)
  expect(saved.analysis_revision).toBe(binding.revision)
  expect(saved.deep_reports).toHaveLength(1)
  expect(saved.deep_reports![0].body).toBe(body)
  await reports.getByRole('button', { name: '收取 ANALYSIS.md' }).click()
  await expect(reports.locator('summary')).toHaveCount(1)
  await page.getByRole('button', { name: '删除资料' }).click()
  await expect(page.getByRole('button', { name: /local-review-video-transcript.srt/ })).toHaveCount(0)
  expect(fs.existsSync(directory)).toBe(false)
  await test.info().attach('hc887-workspace-report', { body: JSON.stringify({ binding, report: saved.deep_reports![0], removedWithSource: true, outputAuthor: 'test fixture' }), contentType: 'application/json' })
}
