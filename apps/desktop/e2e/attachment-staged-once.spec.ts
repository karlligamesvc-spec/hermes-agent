// hc-1210 A sent file is copied into the assistant's attachments/ once. Dev
// Electron, a real engine (`hermes serve` from this checkout) and a scripted
// mock LLM; the native open panel is answered from main. No paid call.
//
// Before the fix, a file picked into a chat that already had a session was
// staged twice: the drop-time upload copied it in as 作品列表.xlsx, and the send,
// which could no longer find that upload's result in the cleared composer,
// copied it again as 作品列表-2.xlsx and handed the model the -2 copy. A file
// dropped on the Start page went the same way (口播第一条.webm + -2.webm).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type Sandbox,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { type ElectronApplication, expect, type Page, test } from './test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const REPLY = '收到。'

type Mock = Awaited<ReturnType<typeof startMockServer>>

async function launch(sandbox: Sandbox, mock: Mock, singleThread: boolean) {
  const work = path.join(sandbox.root, 'work')

  fs.mkdirSync(work, { recursive: true })
  writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
  writeEnvFile(sandbox.hermesHome)

  const env = buildAppEnv(sandbox, {
    APEX_PYTHON: process.env.APEX_PYTHON || path.join(REPO, '.venv', 'bin', 'python'),
    HERMES_DESKTOP_CWD: work,
    ...(singleThread ? { APEXNODES_SINGLE_THREAD: '1' } : {})
  })

  if (!singleThread) {
    // The Start launcher is the home only with single-thread mode off.
    delete env.APEXNODES_SINGLE_THREAD
  }

  const launched = await launchDesktop(env)
  const { app, page } = launched
  const ownKey = page.getByRole('button', { name: '使用自己的密钥' })

  if (
    await ownKey.waitFor({ state: 'visible', timeout: 15_000 }).then(
      () => true,
      () => false
    )
  ) {
    await ownKey.click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })

    if (
      await later.waitFor({ state: 'visible', timeout: 3000 }).then(
        () => true,
        () => false
      )
    ) {
      await later.click()
    }
  }

  await waitForAppReady({ app, page, sandbox, cleanup: async () => {} } as never, 120_000)
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((win: { getTitle: () => string }) => win.getTitle() === 'APEX')

    main?.setSize(1220, 860)
    main?.show()
  })

  return launched
}

/** What the engine copied into the assistant's attachments/ (single-thread main assistant: HERMES_HOME). */
const staged = (sandbox: Sandbox) => {
  const dir = path.join(sandbox.hermesHome, 'attachments')

  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

async function answerOpenPanel(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, file)
}

async function waitForReply(page: Page, count: number) {
  await expect(page.getByRole('paragraph').filter({ hasText: REPLY })).toHaveCount(count, { timeout: 120_000 })
}

const promptFor = (mock: Mock, ask: string) => mock.receivedPrompts.find(prompt => prompt.includes(ask)) ?? ''

test.describe('hc-1210 a sent file is staged once', () => {
  test.setTimeout(300_000)

  test('a file picked into a chat that already has a session', async () => {
    const sandbox = createSandbox('hc1210-pick')
    const sheet = path.join(sandbox.root, 'Downloads', '作品列表.xlsx')

    fs.mkdirSync(path.dirname(sheet), { recursive: true })
    fs.copyFileSync(path.join(HERE, 'media', 'analysis-review.xlsx'), sheet)

    const mock = await startMockServer({ replyForPrompt: () => REPLY })
    const { app, page } = await launch(sandbox, mock, true)

    try {
      const composer = page.locator('[data-slot="composer-rich-input"]:visible').first()

      await composer.waitFor({ state: 'visible', timeout: 90_000 })
      await composer.click()
      await page.keyboard.type('你好')
      await page.keyboard.press('Enter')
      await waitForReply(page, 1)

      // + 添加文件或视频, then send right away: the drop-time upload is still running.
      await answerOpenPanel(app, sheet)
      await page.getByRole('button', { name: '添加图片、文件和更多' }).first().click()
      await page.getByRole('menuitem', { name: '添加文件或视频' }).click()
      await expect(page.locator('[data-slot="composer-dock"]').first()).toContainText('作品列表.xlsx', {
        timeout: 15_000
      })
      await composer.click()
      await page.keyboard.type('复盘这张表')
      await page.keyboard.press('Enter')
      await waitForReply(page, 2)

      expect(staged(sandbox)).toEqual(['作品列表.xlsx'])
      expect(promptFor(mock, '复盘这张表')).toContain(
        `@file:${path.join(fs.realpathSync(sandbox.hermesHome), 'attachments', '作品列表.xlsx')}`
      )
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })

  test('a file dropped on the Start page and sent from there', async () => {
    const sandbox = createSandbox('hc1210-start')
    const take = path.join(sandbox.root, '口播第一条.webm')

    fs.copyFileSync(path.join(HERE, 'media', 'local-frame-evidence.webm'), take)

    const mock = await startMockServer({ replyForPrompt: () => REPLY })
    const { app, page } = await launch(sandbox, mock, false)

    try {
      const goal = page.getByRole('textbox', { name: '业务目标' })
      const launcher = page.locator('[data-business-goal-launcher]')

      await goal.waitFor({ state: 'visible', timeout: 90_000 })

      // A Finder drop: CDP's drag carries a real path, as Finder's does.
      const box = await launcher.boundingBox()

      expect(box).toBeTruthy()

      const cdp = await page.context().newCDPSession(page)
      const data = { dragOperationsMask: 1, files: [take], items: [] }
      const point = { x: box!.x + 60, y: box!.y + 20 }

      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await cdp.send('Input.dispatchDragEvent', { type, ...point, data })
      }

      await expect(launcher).toContainText('口播第一条.webm', { timeout: 15_000 })
      await goal.click()
      await page.keyboard.type('帮我转逐字稿')
      await page.keyboard.press('Enter')
      await waitForReply(page, 1)

      expect(staged(sandbox)).toEqual(['口播第一条.webm'])
      expect(promptFor(mock, '帮我转逐字稿')).toContain(
        `@file:${path.join(fs.realpathSync(sandbox.hermesHome), 'attachments', '口播第一条.webm')}`
      )
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })
})
