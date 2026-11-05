// hc-1159 ⌘V of a video copied in Finder on the business Start page, with
// single-thread mode off (the default home: the Start launcher, not the chat
// composer). Dev Electron, a real engine (`hermes serve` from this checkout)
// and a scripted mock LLM, the same harness as hc-1158's paste-copied-file
// spec. The system clipboard gets a file copy (`public.file-url`, which
// Chromium reads as a pasted File the way it reads a Finder copy), and ⌘V goes
// through Chromium's own paste command. Three pastes: with the launcher input
// focused, on the page around it, and on Start again after a chat, when the
// chat composer stays mounted (hidden) behind it. No paid call.
//
// The spec writes the system clipboard; it puts back the text, HTML and RTF
// that were there before. `HC1159_SHOTS=<dir>` keeps screenshots.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { expect, test } from './test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')

const ANSWER = '逐字稿整理好了。'
const FOUR = ['转逐字稿', '拆它为什么火', '仿写成我的脚本', '复刻成我的']

/** The engine stages a sent file under `attachments/` and may add a `-2`, so prompts are matched on the stem. */
const stem = (file: string) => path.parse(file).name

test.describe('hc-1159 a video copied in Finder, pasted on the Start page (single-thread off)', () => {
  test.skip(process.platform !== 'darwin', 'the clipboard file copy is written in its macOS form')
  test.setTimeout(300_000)

  test('⌘V attaches the take to the launcher like a drop, focused or not, and once', async () => {
    const sandbox = createSandbox('hc1159')
    const shots = process.env.HC1159_SHOTS
    const work = path.join(sandbox.root, 'work')
    const takes = ['口播第一条', '口播第二条', '口播第三条'].map(name => path.join(sandbox.root, `${name}.webm`))
    const [first, second, third] = takes as [string, string, string]

    fs.mkdirSync(work, { recursive: true })

    for (const take of takes) {
      fs.copyFileSync(path.join(HERE, 'media', 'local-frame-evidence.webm'), take)
    }

    const mock = await startMockServer({
      replyForPrompt: () => '好的。',
      scriptForPrompt: prompt => (prompt.includes(stem(first)) ? { text: ANSWER } : null)
    })

    writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
    writeEnvFile(sandbox.hermesHome)

    const env = buildAppEnv(sandbox, {
      APEX_PYTHON: process.env.APEX_PYTHON || path.join(REPO, '.venv', 'bin', 'python'),
      HERMES_DESKTOP_CWD: work
    })

    // The Start launcher is the home only with single-thread mode off.
    delete env.APEXNODES_SINGLE_THREAD

    const { app, page } = await launchDesktop(env)

    const saved = await app.evaluate(({ clipboard }) => ({
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      text: clipboard.readText()
    }))

    const copyInFinder = (file: string) =>
      app.evaluate(
        ({ clipboard }, url) => clipboard.writeBuffer('public.file-url', Buffer.from(url)),
        pathToFileURL(file).href
      )

    const shot = async (name: string, locator?: ReturnType<typeof page.locator>) => {
      if (!shots) {
        return
      }

      fs.mkdirSync(shots, { recursive: true })
      const file = path.join(shots, `${name}.png`)

      await (locator ? locator.screenshot({ path: file }) : page.screenshot({ path: file }))
    }

    const focusIsInAnInput = () =>
      page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null

        return Boolean(active?.isContentEditable || active?.tagName === 'TEXTAREA' || active?.tagName === 'INPUT')
      })

    try {
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

      const goal = page.getByRole('textbox', { name: '业务目标' })
      const launcher = page.locator('[data-business-goal-launcher]')
      const group = launcher.getByRole('group', { name: '用这条视频做什么' })
      const pills = launcher.locator('[data-slot="composer-attachments"] > *')

      await goal.waitFor({ state: 'visible', timeout: 90_000 })
      // The chat composer is not on this page.
      await expect(page.locator('[data-slot="composer-rich-input"]:visible')).toHaveCount(0)
      await shot('00-start')

      // ── ⌘V with the launcher input focused ───────────────────────────
      await copyInFinder(first)
      await goal.click()
      await page.keyboard.press('Meta+V')

      await expect(group.getByRole('button')).toHaveText(FOUR)
      await expect(launcher).toContainText(path.basename(first))
      // The file came in as an attachment, not as its name typed into the input.
      await expect(goal).toHaveValue('')
      await expect(pills).toHaveCount(1)
      await page.waitForTimeout(500)
      await shot('01-pasted-in-launcher')
      await shot('02-launcher-chips', launcher)

      // ── ⌘V on the page around the launcher, nothing focused ──────────
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.locator('[data-slot="aui_intro"] h1').first().click()
      expect(await focusIsInAnInput()).toBe(false)
      await copyInFinder(second)
      await page.keyboard.press('Meta+V')

      await expect(launcher).toContainText(path.basename(second))
      await expect(group.getByRole('button')).toHaveText(FOUR)
      await expect(goal).toBeFocused()
      await expect(pills).toHaveCount(2)
      await page.waitForTimeout(500)
      await shot('03-pasted-on-page')

      // ── 转逐字稿 sends the request with both takes riding along ───────
      await group.getByRole('button', { name: '转逐字稿', exact: true }).click()
      await expect
        .poll(
          () => mock.receivedPrompts.some(prompt => prompt.includes(stem(first)) && prompt.includes(stem(second))),
          { timeout: 30_000 }
        )
        .toBe(true)

      await expect(page.getByRole('paragraph').filter({ hasText: ANSWER })).toBeVisible({ timeout: 120_000 })

      // ── Back on Start with the chat composer mounted behind it ───────
      await page.keyboard.press('Meta+N')
      await goal.waitFor({ state: 'visible', timeout: 30_000 })
      await expect(page.locator('[data-slot="composer-rich-input"]').first()).toBeAttached()
      await expect(page.locator('[data-slot="composer-rich-input"]:visible')).toHaveCount(0)
      // A sent draft can come back on Start after ⌘N (a drop does the same, outside
      // this change); count what is there first.
      const leftover = await pills.count()

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.locator('[data-slot="aui_intro"] h1').first().click()
      expect(await focusIsInAnInput()).toBe(false)
      await copyInFinder(third)
      await page.keyboard.press('Meta+V')

      await expect(launcher).toContainText(path.basename(third))
      await expect(group.getByRole('button')).toHaveText(FOUR)
      await expect(pills.filter({ hasText: path.basename(third) })).toHaveCount(1)
      await expect(pills).toHaveCount(leftover + 1)
      await page.waitForTimeout(500)
      await shot('04-pasted-on-start-after-chat')
    } finally {
      await app.evaluate(({ clipboard }, previous) => clipboard.write(previous), saved).catch(() => {})
      await app.close().catch(() => {})
      await mock.close()
    }
  })
})
