// hc-1158 ⌘V of a video copied in Finder, in single-thread product mode.
// Dev Electron, a real engine (`hermes serve` from this checkout) and a scripted
// mock LLM, the same harness as hc-1156's trim-entry spec, but the take comes
// in by paste instead of a drag. The system clipboard gets a file copy
// (`public.file-url`, which Chromium reads as a pasted File the way it reads a
// Finder copy), and ⌘V goes through Chromium's own paste command. Two pastes:
// one with the composer focused, one landing on the transcript. No paid call.
//
// The spec writes the system clipboard; it puts back the text, HTML and RTF
// that were there before. `HC1158_SHOTS=<dir>` keeps screenshots.

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

const ASK = '把这段口播剪干净'
const ANSWER = '剪好了：去掉了 5 处长停顿。'
const TRIM = ['剪干净', '剪干净再加字幕', '先找同类视频对照']

test.describe('hc-1158 a video copied in Finder, pasted into single-thread product mode', () => {
  test.skip(process.platform !== 'darwin', 'the clipboard file copy is written in its macOS form')
  test.setTimeout(300_000)

  test('⌘V attaches the take like a drop and offers the trim chips, focused or not', async () => {
    const sandbox = createSandbox('hc1158')
    const shots = process.env.HC1158_SHOTS
    const work = path.join(sandbox.root, 'work')
    const first = path.join(sandbox.root, '口播第一条.webm')
    const second = path.join(sandbox.root, '口播第二条.webm')

    fs.mkdirSync(work, { recursive: true })
    fs.copyFileSync(path.join(HERE, 'media', 'local-frame-evidence.webm'), first)
    fs.copyFileSync(path.join(HERE, 'media', 'local-frame-evidence.webm'), second)

    const mock = await startMockServer({
      replyForPrompt: () => '好的。',
      scriptForPrompt: prompt => (prompt.includes(ASK) ? { text: ANSWER } : null)
    })

    writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
    writeEnvFile(sandbox.hermesHome)

    const { app, page } = await launchDesktop(
      buildAppEnv(sandbox, {
        APEXNODES_SINGLE_THREAD: '1',
        APEX_PYTHON: process.env.APEX_PYTHON || path.join(REPO, '.venv', 'bin', 'python'),
        HERMES_DESKTOP_CWD: work
      })
    )

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

    try {
      const ownKey = page.getByRole('button', { name: '使用自己的密钥' })

      if (
        await ownKey.waitFor({ state: 'visible', timeout: 15_000 }).then(
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

      const composer = page.locator('[data-slot="composer-rich-input"]:visible').first()
      const dock = page.locator('[data-slot="composer-dock"]').first()
      const group = page.getByRole('group', { name: '用这条视频做什么' })

      await composer.waitFor({ state: 'visible', timeout: 90_000 })

      // ── ⌘V with the composer focused ─────────────────────────────────
      await copyInFinder(first)
      await composer.click()
      await page.keyboard.press('Meta+V')

      await expect(group.getByRole('button')).toHaveText(TRIM)
      await expect(dock).toContainText(path.basename(first))
      // The file came in as an attachment, not as its name typed into the input.
      await expect(composer).toHaveText('')
      await page.waitForTimeout(500)
      await shot('01-pasted-take')
      await shot('02-trim-chips', dock)

      // ── 剪干净 sends the sentence with the take riding along ──────────
      await group.getByRole('button', { name: '剪干净', exact: true }).click()
      await expect
        .poll(
          () => mock.receivedPrompts.some(prompt => prompt.includes(ASK) && prompt.includes(path.basename(first))),
          {
            timeout: 30_000
          }
        )
        .toBe(true)

      const answer = page.getByRole('paragraph').filter({ hasText: ANSWER })

      await expect(answer).toBeVisible({ timeout: 120_000 })
      await expect(group).toHaveCount(0)

      // ── ⌘V landing on the transcript (paste-to-focus) ──────────────────
      await copyInFinder(second)
      await answer.click()
      expect(
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null

          return Boolean(active?.isContentEditable || active?.tagName === 'TEXTAREA' || active?.tagName === 'INPUT')
        })
      ).toBe(false)
      await page.keyboard.press('Meta+V')

      await expect(group.getByRole('button')).toHaveText(TRIM)
      await expect(dock).toContainText(path.basename(second))
      await expect(composer).toHaveText('')
      await page.waitForTimeout(500)
      await shot('03-pasted-on-transcript')
    } finally {
      await app.evaluate(({ clipboard }, previous) => clipboard.write(previous), saved).catch(() => {})
      await app.close().catch(() => {})
      await mock.close()
    }
  })
})
