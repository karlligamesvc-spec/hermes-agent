// hc-1130 拿到结果: one real turn in single-thread product mode. Dev Electron, a
// real engine (`hermes serve` from this checkout) and a scripted mock LLM: the
// engine really writes and patches the files, runs the command and raises the
// approval; the renderer reads the same events a user's turn produces. No paid
// call: the video is a small local clip handed over with MEDIA:, not one from
// `generate_video`.
//
// `HC1130_SHOTS=<dir>` keeps screenshots. Checks are soft, so a run on pristine
// main records every step for the before/after.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import type { ScriptedTurn } from '../../../tests-js/scripts/mock-server'
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

const VIDEO_NAME = '一条_15_秒的竖屏短视频_分三个镜头_镜头之间硬切_三个镜头里是同一个人_同一_4a2ea035.webm'
const AUDIO_NAME = '配音_口播_7b1c2d3e.wav'
const IMAGE_NAME = '收纳架封面_带字_9a8b7c6d.png'
const DOC_NAME = '拆解报告.docx'

const RESULT_PROMPT = '帮我生成一条竖屏短视频，再配上字幕'
const APPROVAL_PROMPT = '把这个项目的说明文件也改一下'
const CODE_PROMPT = '写一段 Python，打印你好'

const SCRIPT = (video: string) => `import sys\nV = "${video}"\ncaps = 39\nprint("字幕已加", caps, V)\n`

function wav(): Buffer {
  const rate = 8000
  const samples = Buffer.alloc(rate * 2)

  for (let at = 0; at < rate; at += 1) {
    samples.writeInt16LE(Math.round(Math.sin((at / rate) * 2 * Math.PI * 440) * 8000), at * 2)
  }

  const header = Buffer.alloc(44)

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)

  return Buffer.concat([header, samples])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  let crc = 0xffffffff

  for (const byte of body) {
    crc ^= byte

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }

  const length = Buffer.alloc(4)
  const tail = Buffer.alloc(4)

  length.writeUInt32BE(data.length)
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)

  return Buffer.concat([length, body, tail])
}

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)

  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2

  const rows = Buffer.alloc((width * 3 + 1) * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3

      rows[at] = 108
      rows[at + 1] = Math.round((x / width) * 120) + 60
      rows[at + 2] = Math.round((y / height) * 200) + 40
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

test.describe('hc-1130 the result of a turn in product mode', () => {
  test.skip(process.platform === 'win32', 'driven on the Mac the release is built on')
  test.setTimeout(420_000)

  test('files fold, every result has its actions, the approval stays', async () => {
    const sandbox = createSandbox('hc1130')
    const shots = process.env.HC1130_SHOTS
    const cwd = path.join(sandbox.root, 'work')
    const finished = path.join(cwd, '成片')
    const media = path.join(sandbox.hermesHome, 'cache', 'media')
    const video = path.join(media, VIDEO_NAME)
    const audio = path.join(media, AUDIO_NAME)
    const image = path.join(media, IMAGE_NAME)
    const doc = path.join(finished, DOC_NAME)

    fs.mkdirSync(finished, { recursive: true })
    fs.mkdirSync(media, { recursive: true })
    fs.copyFileSync(path.join(HERE, 'media', 'local-frame-evidence.webm'), video)
    fs.copyFileSync(path.join(HERE, 'media', 'analysis-review.docx'), doc)
    fs.writeFileSync(audio, wav())
    fs.writeFileSync(image, png(640, 360))

    const answer = [
      '做好了，这条成片你先看：',
      `MEDIA:${video}`,
      '配音和封面也一起给你：',
      `MEDIA:${audio}`,
      `MEDIA:${image}`,
      '拆解写成了文档：',
      `MEDIA:${doc}`
    ].join('\n\n')

    const steps: ScriptedTurn[] = [
      {
        text: '字幕我顺手加上。',
        toolCalls: [{ name: 'write_file', args: { path: path.join(cwd, 'burn.py'), content: SCRIPT(video) } }]
      },
      { text: '', toolCalls: [{ name: 'terminal', args: { command: `cd "${cwd}" && python3 burn.py` } }] },
      {
        text: '',
        toolCalls: [
          { name: 'patch', args: { path: path.join(cwd, 'burn.py'), old_string: 'caps = 39', new_string: 'caps = 12' } }
        ]
      },
      {
        text: '',
        toolCalls: [
          {
            name: 'write_file',
            args: { path: path.join(cwd, '文案.txt'), content: '先别买柜子\n乱的根，是东西只能往里堆\n' }
          }
        ]
      },
      { text: answer }
    ]

    const mock = await startMockServer({
      replyForPrompt: () => '好的。',
      scriptForPrompt: (prompt, toolResults) => {
        if (prompt.includes(RESULT_PROMPT)) {
          return steps[Math.min(toolResults, steps.length - 1)]
        }

        if (prompt.includes(APPROVAL_PROMPT)) {
          return toolResults === 0
            ? {
                text: '',
                toolCalls: [{ name: 'write_file', args: { path: path.join(cwd, 'AGENTS.md'), content: '# 说明\n' } }]
              }
            : { text: '说明文件的事办完了。' }
        }

        return prompt.includes(CODE_PROMPT) ? { text: '你要的代码：\n\n```python\nprint("你好 APEX")\n```' } : null
      }
    })

    writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
    writeEnvFile(sandbox.hermesHome)

    const { app, page } = await launchDesktop(
      buildAppEnv(sandbox, { APEXNODES_SINGLE_THREAD: '1', HERMES_DESKTOP_CWD: cwd })
    )

    const shot = async (name: string) => {
      if (shots) {
        fs.mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: path.join(shots, `${name}.png`) })
      }
    }

    const shotOf = async (name: string, locator: ReturnType<typeof page.locator>) => {
      if (shots) {
        fs.mkdirSync(shots, { recursive: true })
        await locator.scrollIntoViewIfNeeded()
        await locator.screenshot({ path: path.join(shots, `${name}.png`) })
      }
    }

    const send = async (text: string) => {
      const composer = page.locator('[data-slot="composer-rich-input"]:visible').first()

      await composer.waitFor({ state: 'visible', timeout: 90_000 })
      await composer.click()
      await composer.fill(text)
      await page.keyboard.press('Enter')
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

        main?.setSize(1220, 900)
        main?.show()
      })

      // ── The turn ────────────────────────────────────────────────────────
      await send(RESULT_PROMPT)
      await expect(page.getByText('拆解写成了文档：')).toBeVisible({ timeout: 180_000 })
      await expect(
        page.locator('[data-role="assistant"] video, [data-slot="aui_result-media"] video').first()
      ).toBeVisible()
      await page.waitForTimeout(1_000)

      // The engine really did the work behind the fold.
      expect.soft(fs.readFileSync(path.join(cwd, 'burn.py'), 'utf8')).toContain('caps = 12')
      expect.soft(fs.readFileSync(path.join(cwd, '文案.txt'), 'utf8')).toContain('先别买柜子')

      const transcript = page.locator('[data-slot="aui_assistant-message-content"]')

      await shot('01-turn-top')
      await page.getByRole('paragraph').filter({ hasText: '字幕我顺手加上。' }).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await shot('02-turn-work')

      const mainLine = await transcript.evaluateAll(nodes =>
        nodes
          .map(node => {
            const copy = node.cloneNode(true) as HTMLElement

            copy.querySelectorAll('[data-single-thread-process]').forEach(item => item.remove())

            return copy.textContent ?? ''
          })
          .join('\n')
      )

      for (const leak of ['burn.py', '文案.txt', 'import sys', sandbox.root, '个文件有改动', '查看改动']) {
        expect.soft(mainLine, `the chat must not show ${leak}`).not.toContain(leak)
      }

      expect.soft(await page.locator('[data-tool-row]').count(), 'no file card in the chat').toBe(0)
      expect.soft(await page.locator('[data-slot="aui_changed-files"]').count(), 'no changed-files card').toBe(0)

      // ── Saving a result: the real save path, the dialog stubbed ─────────
      await app.evaluate(
        ({ dialog, shell }, saved) => {
          const state = { revealed: [] as string[], saves: [] as string[] }

          ;(globalThis as Record<string, unknown>).__hc1130 = state
          dialog.showSaveDialog = (async (...args: unknown[]) => {
            const options = args.find(arg => arg && typeof arg === 'object' && 'defaultPath' in (arg as object)) as {
              defaultPath?: string
            }

            state.saves.push(String(options?.defaultPath))

            return { canceled: false, filePath: saved }
          }) as never
          shell.showItemInFolder = ((target: string) => {
            state.revealed.push(target)
          }) as never
        },
        path.join(sandbox.root, 'saved.webm')
      )

      const hc1130 = () =>
        app.evaluate(() => (globalThis as unknown as { __hc1130: { revealed: string[]; saves: string[] } }).__hc1130)

      const videoCard = page.locator('[data-slot="aui_result-media"][data-kind="video"]')

      const player = page.locator('[data-role="assistant"] video').first()

      await player.scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      await shot('03-video-card')

      const download = videoCard.getByRole('button', { exact: true, name: '下载' })

      if (await download.count()) {
        await download.click()
        await expect.poll(async () => (await hc1130()).saves.length, { timeout: 30_000 }).toBe(1)

        const [saved] = (await hc1130()).saves

        test.info().annotations.push({ type: 'save dialog default', description: saved })
        expect.soft(path.basename(saved)).toBe('一条 15 秒的竖屏短视频 分三个镜头.webm')
        expect.soft(saved).not.toContain(sandbox.root)
        await expect.poll(() => fs.existsSync(path.join(sandbox.root, 'saved.webm')), { timeout: 30_000 }).toBe(true)
        expect
          .soft(fs.readFileSync(path.join(sandbox.root, 'saved.webm')).equals(fs.readFileSync(video)), 'same bytes')
          .toBe(true)

        await videoCard.getByRole('button', { name: /在访达中显示|打开所在文件夹/ }).click()
        await expect.poll(async () => (await hc1130()).revealed).toEqual([video])
      } else {
        expect.soft(await download.count(), 'the video card has 下载').toBeGreaterThan(0)
      }

      // ── The native ⋮ menu ───────────────────────────────────────────────
      const box = await player.boundingBox()

      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(400)
        await page.mouse.click(box.x + box.width - 20, box.y + box.height - 42)
        await page.waitForTimeout(500)
        await shot('04-native-menu')
        await page.keyboard.press('Escape')
        await page.mouse.click(box.x + box.width / 2, box.y - 30)
      }

      for (const kind of ['audio', 'image']) {
        const found = page.locator(`[data-slot="aui_result-media"][data-kind="${kind}"]`)

        if (await found.count()) {
          await shotOf(`05-${kind}-card`, found)
          expect
            .soft(await found.getByRole('button', { exact: true, name: '下载' }).count(), `${kind} has 下载`)
            .toBe(1)
          expect.soft(await found.getByRole('button', { name: /在访达中显示|打开所在文件夹/ }).count()).toBe(1)
        } else {
          expect.soft(await found.count(), `a ${kind} result card`).toBeGreaterThan(0)
        }
      }

      const docName = page.getByText(/拆解报告/).last()

      await docName.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await shot('06-doc-card')

      // ── The process area keeps the files ────────────────────────────────
      const showProcess = page.getByRole('button', { name: '看过程' }).last()

      await showProcess.scrollIntoViewIfNeeded()
      await showProcess.click()
      await page.waitForTimeout(300)
      await shot('07-process-steps')

      const contents = page.locator('[data-process-files-toggle]')

      expect.soft(await contents.count(), '看内容 on each file step').toBeGreaterThanOrEqual(2)

      for (let at = await contents.count(); at > 0; at -= 1) {
        await contents.nth(at - 1).click()
      }

      await page.waitForTimeout(500)

      if ((await page.locator('[data-process-file]').count()) > 0) {
        await page.locator('[data-process-file]').first().scrollIntoViewIfNeeded()
        await shot('08-process-contents')
        expect
          .soft(await page.locator('[data-process-files]').allTextContents())
          .toEqual(expect.arrayContaining([expect.stringContaining('burn.py')]))
      } else {
        expect.soft(await page.locator('[data-process-file]').count(), 'files in the process area').toBeGreaterThan(0)
      }

      // ── Code the user asked for stays in the reply ──────────────────────
      await send(CODE_PROMPT)
      await expect(page.getByText('print("你好 APEX")')).toBeVisible({ timeout: 120_000 })
      await page.getByText('print("你好 APEX")').scrollIntoViewIfNeeded()
      await page.waitForTimeout(800)
      await shot('09-code-reply')

      // ── A protected write: the engine asks, the user sees it ────────────
      await send(APPROVAL_PROMPT)

      const explained = page.locator('[data-slot="tool-approval-explain"]').first()

      await expect(explained).toBeVisible({ timeout: 120_000 })
      await explained.scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      await shot('10-approval')
      expect.soft(fs.existsSync(path.join(cwd, 'AGENTS.md')), 'nothing written before the answer').toBe(false)
      await page
        .locator('[data-slot="tool-approval-explained"]')
        .last()
        .getByRole('button', { name: /^(运行|Run)/ })
        .click()
      await expect(page.getByRole('paragraph').filter({ hasText: '说明文件的事办完了。' })).toBeVisible({
        timeout: 120_000
      })
      expect.soft(fs.existsSync(path.join(cwd, 'AGENTS.md')), 'written once approved').toBe(true)
      await page.waitForTimeout(500)
      await shot('11-after-approval')
    } finally {
      await app.close().catch(() => {})
      await mock.close()
      sandbox.cleanup()
    }
  })
})
