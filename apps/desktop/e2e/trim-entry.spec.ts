// hc-1156 口播精剪的入口和过程说法: one real turn in single-thread product mode.
// Dev Electron, a real engine (`hermes serve` from this checkout) and a scripted
// mock LLM. A real video file is dragged onto the composer through Chromium's
// own drag events (CDP `Input.dispatchDragEvent` carrying the file's path, the
// same route a Finder drag takes into the drop handler), its trim chip sends
// the request, and the engine really runs the four footage_motion.py
// subcommands through the terminal tool in the shape the skill writes them.
// The 口播精剪 subcommands themselves land with apex-nodes hc-1153–1155; until
// then a stub at the installed skill path stands in, so the steps finish. No
// paid call.
//
// `HC1156_SHOTS=<dir>` keeps screenshots.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const REPO = path.resolve(HERE, '..', '..', '..')

const ASK = '把这段口播剪干净'
const ANSWER = '剪好了：去掉了 7 处长停顿和 1 段说错重来的地方。'
const RUN = '"$APEX_PYTHON" "$HERMES_HOME/skills/apexnodes/short-video-studio/scripts/footage_motion.py"'

// Records each call and holds `trim` long enough to see it running.
const STUB = [
  'import os, sys, time',
  'command = sys.argv[1]',
  'with open(os.path.join(os.environ["HERMES_HOME"], "footage-stub-calls.log"), "a") as log:',
  '    log.write(command + "\\n")',
  'if command == "trim":',
  '    time.sleep(8)',
  'print(command, "ok")',
  ''
].join('\n')

test.describe('hc-1156 口播精剪 in single-thread product mode', () => {
  test.skip(process.platform === 'win32', 'driven on the Mac the release is built on')
  test.setTimeout(360_000)

  test('a dropped take offers the trim chips; the cut reads in plain words', async () => {
    const sandbox = createSandbox('hc1156')
    const shots = process.env.HC1156_SHOTS
    const work = path.join(sandbox.root, 'work')
    const take = path.join(sandbox.root, '口播第一条.webm')
    const stub = path.join(sandbox.hermesHome, 'skills', 'apexnodes', 'short-video-studio', 'scripts')
    const calls = path.join(sandbox.hermesHome, 'footage-stub-calls.log')

    fs.mkdirSync(work, { recursive: true })
    fs.copyFileSync(path.join(HERE, 'media', 'local-frame-evidence.webm'), take)

    const steps: ScriptedTurn[] = [
      {
        text: '',
        toolCalls: [{ name: 'terminal', args: { command: `${RUN} pacing "${take}" --out "${work}/pacing.json"` } }]
      },
      {
        text: '',
        toolCalls: [
          { name: 'terminal', args: { command: `${RUN} recipe "${work}/pacing.json" --out "${work}/recipe.json"` } }
        ]
      },
      {
        text: '',
        toolCalls: [
          {
            name: 'terminal',
            args: { command: `${RUN} trim "${take}" --recipe "${work}/recipe.json" --out "${work}/trimmed.mp4"` }
          }
        ]
      },
      {
        text: '',
        toolCalls: [
          { name: 'terminal', args: { command: `${RUN} compare "${work}/trimmed.mp4" --recipe "${work}/recipe.json"` } }
        ]
      },
      { text: ANSWER }
    ]

    const mock = await startMockServer({
      replyForPrompt: () => '好的。',
      scriptForPrompt: (prompt, toolResults) =>
        prompt.includes(ASK) ? steps[Math.min(toolResults, steps.length - 1)] : null
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

      // Platform skills would sit here; the stub goes in after start-up.
      fs.mkdirSync(stub, { recursive: true })
      fs.writeFileSync(path.join(stub, 'footage_motion.py'), STUB)

      // ── Drag the take in ─────────────────────────────────────────────
      const composer = page.locator('[data-slot="composer-rich-input"]:visible').first()

      await composer.waitFor({ state: 'visible', timeout: 90_000 })

      const box = (await composer.boundingBox())!
      const cdp = await page.context().newCDPSession(page)
      const data = { items: [], files: [take], dragOperationsMask: 1 }
      const point = { x: box.x + 40, y: box.y + box.height / 2 }

      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data })

      const group = page.getByRole('group', { name: '用这条视频做什么' })

      await expect(group.getByRole('button')).toHaveText(['剪干净', '剪干净再加字幕', '先找同类视频对照'])
      await page.waitForTimeout(500)
      await shot('01-dropped-take')
      await shot('02-trim-chips', page.locator('[data-slot="composer-dock"]').first())

      // ── 剪干净: the sentence goes out with the take (staged as an attachment copy) ──
      await group.getByRole('button', { name: '剪干净', exact: true }).click()
      await expect
        .poll(() => mock.receivedPrompts.some(prompt => prompt.includes(ASK) && prompt.includes(path.basename(take))), {
          timeout: 30_000
        })
        .toBe(true)

      const activity = page.locator('[data-single-thread-activity]')

      await expect(activity.locator('[role="status"]')).toContainText('正在剪掉停顿和口误', { timeout: 90_000 })
      await expect.soft(activity.locator('[data-single-thread-stage]')).toHaveText('已看完素材，正在剪辑')
      await shot('03-cut-running')
      await shot('04-cut-running-line', activity)

      // ── Finished: the four steps behind 看过程 ──────────────────────
      await expect(page.getByRole('paragraph').filter({ hasText: ANSWER })).toBeVisible({ timeout: 120_000 })
      await page.getByRole('button', { name: '看过程' }).last().click()

      const titles = page.locator('[data-process-step] .font-medium')

      await expect(titles).toHaveText(['量节奏', '定剪法', '剪掉停顿和口误', '对照检查'])

      const process = page.locator('[data-single-thread-process]').last()
      const words = (await process.innerText()).trim()

      for (const mechanism of ['footage_motion', 'APEX_PYTHON', 'HERMES_HOME', '.py', 'pacing', 'trim']) {
        expect.soft(words).not.toContain(mechanism)
      }

      await page.waitForTimeout(500)
      await shot('05-steps')

      // The engine really ran the four subcommands, in order.
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['pacing', 'recipe', 'trim', 'compare'])
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })
})
