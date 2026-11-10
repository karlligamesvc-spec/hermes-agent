import fs from 'node:fs'
import path from 'node:path'

import { setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

test('native home folder drop stages a card and sends the directory through the real backend', async () => {
  test.setTimeout(120_000)
  const fixture = await setupMockBackend()
  try {
    const { page, sandbox } = fixture
    const ownKey = page.getByRole('button', { name: '使用自己的密钥' })
    if (await ownKey.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false)) {
      await ownKey.click()
      const later = page.getByRole('button', { name: '稍后再选择提供方' })
      if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {await later.click()}
    }
    await waitForAppReady(fixture)
    const folder = path.join(sandbox.root, '客户 视频素材')
    fs.mkdirSync(folder)
    // Only directory reference handoff is under test; these are not decoded.
    for (let i = 1; i <= 60; i += 1) {fs.writeFileSync(path.join(folder, `片段${i}.mp4`), 'fixture')}
    fs.mkdirSync(path.join(folder, '第二批'))
    fs.writeFileSync(path.join(folder, '第二批', '镜头.mov'), 'fixture')
    const editor = page.getByRole('textbox', { name: '业务目标' })
    await expect(editor).toBeVisible()
    const bounds = await editor.boundingBox()
    expect(bounds).toBeTruthy()
    const cdp = await page.context().newCDPSession(page)
    const data = { items: [], files: [folder], dragOperationsMask: 1 }
    const point = { x: bounds!.x + 30, y: bounds!.y + 15 }
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data })
    await expect(page.locator('[data-business-goal-launcher]')).toContainText('客户 视频素材')
    await page.screenshot({ path: test.info().outputPath('folder-drop.png') })
    await editor.fill('请列出这个文件夹中的视频')
    await page.getByRole('button', { name: '开始执行', exact: true }).click()
    await expect.poll(() => fixture.mock.receivedPrompts.some(prompt => prompt.includes('请列出这个文件夹中的视频')), { timeout: 30_000 }).toBe(true)
    // hc-1207: the folder is outside the chat's working directory. The path alone also appears in the
    // engine's refusal ("path is outside the allowed workspace"), so check what the engine expanded:
    // its 📁 listing with the clips and the nested folder in it.
    const prompt = fixture.mock.receivedPrompts.find(text => text.includes('请列出这个文件夹中的视频'))!
    expect(prompt).not.toContain('outside the allowed workspace')
    expect(prompt).toMatch(/📁 @folder:\S*客户 视频素材/)

    for (const entry of ['- 片段1.mp4', '- 片段60.mp4', '- 第二批/', '- 镜头.mov']) {expect(prompt).toContain(entry)}
  } finally {await fixture.cleanup()}
})
