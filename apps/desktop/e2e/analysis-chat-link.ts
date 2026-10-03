import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { AnalysisChatLink } from '../shared/analysis-chat-link'
import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import type { PackagedMockBackendFixture } from './fixtures'
import { resolvePackagedE2ePython } from './python-prerequisite'
import { allowErrorBanners, expect, test } from './test'

/** Real Desktop submit -> real runtime persistence -> native receipt -> source-side reopen.
 * ASR/account/model are isolated fixtures; this does not verify a report or Hypit execution. */
export async function verifyAnalysisChatLink(fixture: PackagedMockBackendFixture, outcome: 'complete' | 'error' | 'interrupted' = 'complete') {
  const { page, sandbox, mock } = fixture

  if (outcome === 'error') {allowErrorBanners()}
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  const back = page.getByRole('button', { name: '返回资料入口' })
  if (await back.isVisible()) {await back.click()}
  await page.getByRole('textbox', { name: '粘贴资料链接' }).fill('https://www.iesdouyin.com/share/video/123456')
  await page.getByRole('button', { name: '打开链接' }).click()
  const overview = page.locator('details.analysis-conversation-advanced')
  await overview.locator(':scope > summary').click()
  await expect(overview).toBeVisible({ timeout: 15_000 })
  await overview.getByRole('button', { name: '准备深度拆解' }).click()
  const goal = page.getByRole('textbox', { name: '业务目标' })
  await expect(goal).toHaveValue(/输出目录/)
  const prompt = await goal.inputValue()
  const directory = JSON.parse(prompt.trim().split('\n').at(-1)!) as string

  const source = JSON.parse(fs.readFileSync(path.join(directory, 'apex-source.json'), 'utf8')) as {
    source_id: string; scope: string; revision: string; workspace_id: string
  }

  expect(path.basename(directory)).toBe(source.workspace_id)
  expect(path.basename(path.dirname(directory))).toBe('attempts')
  const receiptDirectory = path.resolve(directory, '../..')

  const read = () => page.evaluate(async input => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments

    return api.readDeepChat!(input.source_id, input.scope, input.revision)
  }, source)

  expect(await read()).toEqual({ ok: true, item: null })
  expect(fs.existsSync(path.join(receiptDirectory, 'apex-chat.json'))).toBe(false)

  if (outcome !== 'complete') {await goal.fill(`${outcome === 'error' ? 'HC891_PROVIDER_FAILURE' : 'HC891_PROVIDER_HOLD'}\n${prompt}`)}
  const before = mock.receivedPrompts.length
  await page.getByRole('button', { name: '开始执行', exact: true }).click()
  await expect.poll(async () => (await read()).item?.sessionId, { timeout: 30_000 }).toBeTruthy()
  const link = (await read()).item as AnalysisChatLink
  await expect.poll(() => mock.receivedPrompts.slice(before).some(text => text.includes(directory)), { timeout: 60_000 }).toBe(true)
  expect(link.workspaceId).toBe(source.workspace_id)
  expect(link.turn?.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(link.turn?.runtimeSessionId).toBeTruthy()

  if (outcome === 'interrupted') {
    await mock.waitForHeldStream()
    await page.locator('form').getByRole('button', { name: '停止', exact: true }).click()
    mock.releaseHeldStream()
  }

  const python = resolvePackagedE2ePython({ repoRoot: path.resolve(import.meta.dirname, '../../..'), explicit: process.env.HERMES_DESKTOP_PYTHON })

  const result = spawnSync(python, ['-I', '-c',
    "import json,sqlite3,sys; from pathlib import Path; db=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); db.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in db.execute('SELECT role,content FROM messages WHERE session_id=? ORDER BY id',(sys.argv[2],))])); db.close()",
    path.join(sandbox.hermesHome, 'state.db'), link.sessionId
  ], { encoding: 'utf8', timeout: 10_000 })

  expect(result.status, result.stderr).toBe(0)
  const rows = JSON.parse(result.stdout) as Array<{ role: string; content: string }>
  expect(rows.some(row => row.role === 'user' && row.content.includes(directory))).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(receiptDirectory, 'apex-chat.json'), 'utf8')).item).toEqual(link)
  // A receipt cannot manufacture output files or analysis completion.
  expect(fs.existsSync(path.join(directory, 'ANALYSIS.md'))).toBe(false)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  if (await page.locator('details.analysis-conversation-advanced').getAttribute('open') === null) {await page.locator('details.analysis-conversation-advanced > summary').click()}
  const tools = page.locator('details.analysis-conversation-advanced')
  if (await tools.getAttribute('open') === null) {await tools.locator(':scope > summary').click()}
  const reports = page.getByRole('region', { name: '深度分析报告' })
  await expect(reports).toContainText('不代表报告已完成或内容已核验')
  await expect.poll(async () => {
    const refresh = reports.getByRole('button', { name: '刷新本次发送状态', exact: true })

    const current = (await read()).item?.outcome?.status

    if (current === outcome) {return current}

    if (await refresh.evaluateAll(elements => elements.some(element => !element.hasAttribute('disabled')))) {
      try {await refresh.click({ timeout: 1000 })} catch (error) {
        // The mount-time read can settle and remove this button between probe and click.
        if ((await read()).item?.outcome?.status !== outcome) {throw error}
      }
    }

    return (await read()).item?.outcome?.status
  }, { timeout: 60_000 }).toBe(outcome)
  const expected = { complete: '执行已结束；报告及内容尚未核验。', error: '本次执行失败，请打开聊天查看。', interrupted: '本次执行已中断。' }[outcome]
  await expect(reports).toContainText(expected)
  await reports.getByRole('button', { name: '打开最近发送的拆解会话' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/${encodeURIComponent(link.sessionId)}`)
  await page.reload()
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(4)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  if (await page.locator('details.analysis-conversation-advanced').getAttribute('open') === null) {await page.locator('details.analysis-conversation-advanced > summary').click()}
  await expect(reports.getByRole('button', { name: '打开最近发送的拆解会话' })).toBeVisible()
  await expect(reports).toContainText(expected)
  expect((await read()).item).toMatchObject({ ...link, outcome: { status: outcome } })
  const persisted = JSON.parse(fs.readFileSync(path.join(receiptDirectory, 'apex-chat.json'), 'utf8')).item
  expect(persisted).toMatchObject({ ...link, outcome: { status: outcome } })
  expect(fs.existsSync(path.join(directory, 'ANALYSIS.md'))).toBe(false)
  await test.info().attach(`hc891-${outcome}-observed`, { body: JSON.stringify(persisted), contentType: 'application/json' })
  await test.info().attach('hc890-real-submitted-chat', { body: JSON.stringify({ link, userRows: rows.filter(row => row.role === 'user').length }), contentType: 'application/json' })
  await reports.scrollIntoViewIfNeeded()
  await test.info().attach(`hc891-${outcome}-source-ui`, { body: await page.screenshot(), contentType: 'image/png' })
  await page.getByRole('button', { name: '删除资料', exact: true }).click()
  await expect.poll(() => fs.existsSync(directory)).toBe(false)
}
