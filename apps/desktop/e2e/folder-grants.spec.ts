// hc-1207: files and folders the user hands over from outside the assistant's working directory reach
// the agent. Dev Electron, a real engine (`hermes serve` from this checkout, apex-overlay applied)
// and the scripted mock LLM; the prompts the mock receives are what the engine made of each
// reference. The native open dialog cannot be driven, so main answers it with the path a user would
// pick: the answer still goes through main's hermes:selectPaths, which records it as handed over.
//
// Single-thread product mode, the main assistant (cwd = work/):
//   + 添加文件夹, + 添加文件或视频 (an .xlsx), a folder dropped on the composer, a folder and a
//   file dropped together, a folder copied in Finder and pasted, and a typed @folder: to a folder
//   nobody handed over (still refused).
// Several assistants on, a new assistant (apex-bot-2, its own engine): + 添加文件夹.
//
// The paste case writes the system clipboard and puts back its text, HTML and RTF afterwards.
// `HC1207_SHOTS=<dir>` keeps screenshots.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { ElectronApplication, Page } from '@playwright/test'

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
import { expect, test } from './test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const OUTSIDE = 'outside the allowed workspace'
const REPLY = '收到。'

type Mock = Awaited<ReturnType<typeof startMockServer>>

interface Handed {
  clips: string
  more: string
  notes: string
  other: string
  pasted: string
  sheet: string
}

/** Downloads/ beside work/: everything handed over sits outside the working directory. */
function downloads(sandbox: Sandbox): Handed {
  const root = path.join(sandbox.root, 'Downloads')

  const made = {
    clips: path.join(root, '素材 一批'),
    more: path.join(root, '第二批素材'),
    notes: path.join(root, '口播稿.txt'),
    other: path.join(sandbox.root, 'Other'),
    pasted: path.join(root, '粘贴的素材'),
    sheet: path.join(root, '作品列表.xlsx')
  }

  for (const folder of [made.clips, made.more, made.other, made.pasted]) {
    fs.mkdirSync(folder, { recursive: true })
  }

  fs.writeFileSync(path.join(made.clips, '镜头1.mp4'), 'fixture')
  fs.writeFileSync(path.join(made.clips, '说明.txt'), 'hello')
  fs.writeFileSync(path.join(made.more, '镜头2.mp4'), 'fixture')
  fs.writeFileSync(path.join(made.pasted, '镜头3.mp4'), 'fixture')
  fs.writeFileSync(path.join(made.other, '不该看到.mp4'), 'fixture')
  fs.writeFileSync(made.notes, '第一句口播\n')
  fs.copyFileSync(path.join(HERE, 'media', 'works.xlsx'), made.sheet)

  return made
}

async function launch(sandbox: Sandbox, mock: Mock, extra: Record<string, string>) {
  writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
  writeEnvFile(sandbox.hermesHome)

  const launched = await launchDesktop(
    buildAppEnv(sandbox, {
      APEX_PYTHON: process.env.APEX_PYTHON || path.join(REPO, '.venv', 'bin', 'python'),
      APEXNODES_SINGLE_THREAD: '1',
      ...extra
    })
  )

  const { app, page } = launched
  const ownKey = page.getByRole('button', { name: '使用自己的密钥' })

  if (
    await ownKey.waitFor({ state: 'visible', timeout: 60_000 }).then(
      () => true,
      () => false
    )
  ) {
    await ownKey.click()
  }

  await waitForAppReady({ app, page, sandbox, cleanup: async () => {} } as never, 120_000)
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((win: { getTitle: () => string }) => win.getTitle() === 'APEX')

    main?.setSize(1220, 860)
    main?.show()
  })

  return launched
}

/** Answer the native open dialog from main, as the user would: a folder for 添加文件夹, a file otherwise. */
async function answerDialog(app: ElectronApplication, picks: { file: string; folder: string }) {
  await app.evaluate(({ dialog }, answer) => {
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { properties?: string[] }

      return {
        canceled: false,
        filePaths: [options?.properties?.includes('openDirectory') ? answer.folder : answer.file]
      }
    }) as typeof dialog.showOpenDialog
  }, picks)
}

function composer(page: Page) {
  return page.locator('[data-slot="composer-rich-input"]:visible').first()
}

const dock = (page: Page) => page.locator('[data-slot="composer-dock"]').first()

async function pick(page: Page, row: string, label: string) {
  await page.getByRole('button', { name: '添加图片、文件和更多' }).first().click()
  await page.getByRole('menuitem', { name: row }).click()
  await expect(dock(page)).toContainText(label, { timeout: 15_000 })
}

async function dropOnComposer(page: Page, files: string[]) {
  const box = await composer(page).boundingBox()

  expect(box).toBeTruthy()

  const cdp = await page.context().newCDPSession(page)
  const data = { dragOperationsMask: 1, files, items: [] }
  const point = { x: box!.x + 40, y: box!.y + 12 }

  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', { type, ...point, data })
  }
}

/** Send `ask` and return the prompt the model got for it, once its reply is on screen. */
async function send(page: Page, mock: Mock, ask: string): Promise<string> {
  const replies = page.getByRole('paragraph').filter({ hasText: REPLY })
  const before = await replies.count()

  await composer(page).click()
  await page.keyboard.type(ask)
  await page.keyboard.press('Enter')
  await expect.poll(() => mock.receivedPrompts.some(prompt => prompt.includes(ask)), { timeout: 60_000 }).toBe(true)
  await expect(replies).toHaveCount(before + 1, { timeout: 120_000 })

  return mock.receivedPrompts.find(prompt => prompt.includes(ask))!
}

function expectListing(prompt: string, folder: string, entries: string[]) {
  expect(prompt).not.toContain(OUTSIDE)
  expect(prompt).toContain('📁 @folder:')
  expect(prompt).toContain(path.basename(folder))

  for (const entry of entries) {
    expect(prompt).toContain(`- ${entry}`)
  }
}

test.describe('hc-1207 handed-over files and folders outside the working directory', () => {
  test.skip(process.platform !== 'darwin', 'the Finder paste is written in its macOS form')
  test.setTimeout(600_000)

  test('single-thread main assistant: menu, drop, mixed drop and paste reach the agent; a typed ref does not', async () => {
    const sandbox = createSandbox('hc1207-main')
    const work = path.join(sandbox.root, 'work')
    const handed = downloads(sandbox)
    const shots = process.env.HC1207_SHOTS
    const mock = await startMockServer({ replyForPrompt: () => REPLY })

    fs.mkdirSync(work, { recursive: true })

    const { app, page } = await launch(sandbox, mock, { HERMES_DESKTOP_CWD: work })

    const saved = await app.evaluate(({ clipboard }) => ({
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      text: clipboard.readText()
    }))

    const shot = async (name: string) => {
      if (shots) {
        fs.mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: path.join(shots, `${name}.png`) })
      }
    }

    try {
      await answerDialog(app, { file: handed.sheet, folder: handed.clips })
      await composer(page).waitFor({ state: 'visible', timeout: 90_000 })

      // + 添加文件夹
      await pick(page, '添加文件夹', '素材 一批')
      await shot('01-menu-folder')
      expectListing(await send(page, mock, '看看这批素材'), handed.clips, ['镜头1.mp4', '说明.txt'])

      // + 添加文件或视频: the sheet is copied into the assistant's attachments/
      await pick(page, '添加文件或视频', '作品列表.xlsx')
      const sheetPrompt = await send(page, mock, '复盘这张表')
      expect(sheetPrompt).not.toContain(OUTSIDE)
      // A file picked into an open chat is staged by the drop-time upload and again at send (作品列表-2.xlsx).
      expect(sheetPrompt).toMatch(/📎 @file:\S*attachments\/作品列表(-\d+)?\.xlsx/)

      // A folder dropped on the composer
      await dropOnComposer(page, [handed.more])
      await expect(dock(page)).toContainText('第二批素材', { timeout: 15_000 })
      await shot('02-dropped-folder')
      expectListing(await send(page, mock, '这些也看看'), handed.more, ['镜头2.mp4'])

      // A folder and a file dropped together
      await dropOnComposer(page, [handed.clips, handed.notes])
      await expect(dock(page)).toContainText('口播稿.txt', { timeout: 15_000 })
      const mixed = await send(page, mock, '素材和口播稿一起看')
      expectListing(mixed, handed.clips, ['镜头1.mp4'])
      expect(mixed).toContain('第一句口播')

      // A folder copied in Finder and pasted with the composer focused
      await app.evaluate(
        ({ clipboard }, url) => clipboard.writeBuffer('public.file-url', Buffer.from(url)),
        pathToFileURL(handed.pasted).href
      )
      await composer(page).click()
      await page.keyboard.press('Meta+V')
      await expect(dock(page)).toContainText('粘贴的素材', { timeout: 15_000 })
      expectListing(await send(page, mock, '粘贴的也看看'), handed.pasted, ['镜头3.mp4'])

      // Typed by hand: nobody handed this folder over, so the workspace guard still refuses it.
      const typed = await send(page, mock, `再看 @folder:${handed.other} 这个`)
      expect(typed).toContain(OUTSIDE)
      expect(typed).not.toContain('不该看到.mp4')
      await shot('03-after-all')
    } finally {
      await app.evaluate(({ clipboard }, previous) => clipboard.write(previous), saved).catch(() => {})
      await app.close().catch(() => {})
      await mock.close()
    }
  })

  test('several assistants on: a new assistant (its own engine) gets a menu folder', async () => {
    const sandbox = createSandbox('hc1207-bot')
    const handed = downloads(sandbox)
    const mock = await startMockServer({ replyForPrompt: () => REPLY })
    const { app, page } = await launch(sandbox, mock, { APEXNODES_MULTI_BOT: '1' })

    try {
      await page.getByRole('button', { name: /新建一个助手|New assistant/ }).click()
      await page.getByPlaceholder(/比如：小红书文案|e\.g\. Captions/).fill('复盘助手')
      await page.getByRole('button', { name: /^(建好了|Create)$/ }).click()

      for (let step = 0; step < 3; step += 1) {
        const card = page.locator('section[data-first-open-card]:has([role="group"] button)')

        if (
          !(await card
            .first()
            .waitFor({ state: 'visible', timeout: 20_000 })
            .then(
              () => true,
              () => false
            ))
        ) {
          break
        }

        const asked = await card.first().getAttribute('data-first-open-card')

        await card.first().locator('[role="group"] button').first().click()
        await expect(page.locator(`section[data-first-open-card="${asked}"]:has([role="group"] button)`)).toHaveCount(0, {
          timeout: 60_000
        })
      }

      await answerDialog(app, { file: handed.sheet, folder: handed.clips })
      await pick(page, '添加文件夹', '素材 一批')
      await pick(page, '添加文件或视频', '作品列表.xlsx')

      const prompt = await send(page, mock, '新助手看看这批素材和表')

      expectListing(prompt, handed.clips, ['镜头1.mp4', '说明.txt'])
      // The sheet was copied into apex-bot-2's own attachments/: this turn ran on that assistant's engine.
      expect(prompt).toMatch(/📎 @file:\S*profiles\/apex-bot-2\/attachments\/作品列表(-\d+)?\.xlsx/)
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })
})
