import { expect, type Page } from '@playwright/test'

import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

/** Real renderer -> runtime RPC -> HTTP model double -> native storage -> reopen. */
export async function verifySourceAnswer(page: Page, sourceId: string, expectedAnchorId: string) {
  const question = `HC886_SOURCE_QUESTION ${sourceId}`
  await page.getByRole('textbox', { name: '针对当前资料提问' }).fill(question)
  const conversation = await page.getByRole('log').count() > 0
  await page.getByRole('button', { name: conversation ? '发送' : '让助手回答', exact: true }).click()

  const answer = () => conversation ? page.locator('.analysis-conversation-turn').filter({ has: page.getByText(question, { exact: true }) })
    : page.getByRole('article').filter({ has: page.getByRole('heading', { name: question, exact: true }) })

  await expect(answer()).toContainText('[本地测试] 当前资料的回答已附出处。', { timeout: 90_000 })

  if (!conversation) {await expect(answer()).toContainText('助手回答 · 请核对出处')}

  const source = await page.evaluate(async id => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments

    return (await api.get(id)).item!
  }, sourceId)

  const saved = source.questions!.filter(item => item.question === question)
  expect(saved).toHaveLength(1)
  expect(saved[0].answer_type).toBe('semantic_answer')
  expect(saved[0].source_revision).toBe(source.analysis_revision)
  expect(saved[0].citations).toEqual([{ anchor_id: expectedAnchorId,
    location: source.anchors!.find(anchor => anchor.id === expectedAnchorId)!.location }])
  await answer().getByRole('button', { name: /查看出处/ }).click()
  await expect(page.locator(`#analysis-anchor-${expectedAnchorId}`)).toBeInViewport()
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: new RegExp(source.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click()
  await expect(answer()).toContainText('[本地测试] 当前资料的回答已附出处。')
}
