// hc-1218: in product mode, `/new` folds the thread into a summary that records results, not the approach.
//
// The marker is sent by the renderer's composer middleware, the switch is settled by main and the summary is
// written by the engine's segment-summary seam, so no single process can prove the chain. This types `/new`
// into the real one-thread composer and reads what the real engine (`hermes serve` from this checkout) asked
// the mock summary model for, and the summary row it stored. Whether a real model then leaves the approach
// out is outside what a mock can show.

import { execFileSync } from 'node:child_process'
import path from 'node:path'

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

type Launched = Awaited<ReturnType<typeof launchDesktop>>

const SINGLE_THREAD = { APEXNODES_SINGLE_THREAD: '1' }
const REPLY = 'hc1218-reply-ok'
const THREAD_COMPOSER = '[data-slot="composer-rich-input"]:visible'
const SUMMARIZER = 'You are a summarization agent creating a context checkpoint.'
const HANDOFF_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY]'
// apex_overlay/segment_summary.py BOUNDARY_RULES (first and last line) and HEADER.
const RULES_FIRST = 'SEGMENT BOUNDARY: this checkpoint closes one segment of a continuing conversation'

const RULES_LAST =
  '- Never present the earlier task as something to repeat, resume, or use as the default for a similar new request.'

const HEADER =
  '这段摘要记的是以前那次做成了什么、还差什么，不是这次的要求：同类的新任务照对应的技能重新确认，不照搬以前那次的做法。'

const COMPRESSION_CONFIG = `compression:
  protect_first_n: 0
  protect_last_n: 1
auxiliary:
  title_generation:
    enabled: false
  compression:
    provider: custom
    model: mock-model`

async function launch(sandbox: Sandbox, extra: Record<string, string>): Promise<Launched> {
  const launched = await launchDesktop(buildAppEnv(sandbox, extra))
  const { page } = launched
  const ownKey = page.getByRole('button', { name: '使用自己的密钥' })

  if (
    await ownKey.waitFor({ state: 'visible', timeout: 15_000 }).then(
      () => true,
      () => false
    )
  ) {
    await ownKey.click()
  }

  await waitForAppReady({ ...launched, sandbox, cleanup: async () => {} } as never, 120_000)

  return launched
}

/**
 * Put `text` in the one-thread composer in one go and press the send button: typed character by character,
 * a leading `/` opens the command picker and Enter would accept a completion instead of sending.
 */
async function send(page: Launched['page'], text: string): Promise<void> {
  const composer = page.locator(THREAD_COMPOSER).first()

  await composer.waitFor({ state: 'visible', timeout: 90_000 })
  await composer.click()
  // A cancelled send (the middleware's `/new`) leaves its text in the composer: start from an empty one.
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
  await expect.poll(() => composer.textContent()).toContain(text.slice(0, 40))
  await page.locator('[data-slot="composer-root"] button[type="submit"]').click()
}

async function turn(page: Launched['page'], text: string): Promise<void> {
  const replies = (await page.locator('body').textContent())?.split(REPLY).length ?? 1

  await send(page, text)
  await page.waitForFunction(
    count => (document.body?.textContent ?? '').split('hc1218-reply-ok').length > count,
    replies,
    { timeout: 120_000 }
  )
  // The next send must not land while this turn is still settling (a busy thread opens no segment).
  await page.waitForTimeout(1_500)
}

/** The newest handoff summary the engine stored: the part from its prefix on (it may be merged into a row). */
function storedSummary(hermesHome: string): null | string {
  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      path.join(hermesHome, 'state.db'),
      `SELECT content FROM messages WHERE content LIKE '%${HANDOFF_PREFIX}%' ORDER BY id DESC LIMIT 1;`
    ],
    { encoding: 'utf8' }
  ).trim()

  if (!out) {
    return null
  }

  const content = String((JSON.parse(out) as { content: string }[])[0]?.content ?? '')

  return content.slice(content.indexOf(HANDOFF_PREFIX))
}

test.describe('hc-1218 segment summary records results, not the approach', () => {
  test.skip(process.platform === 'win32', 'single-thread dev launch is exercised on macOS and Linux')
  test.setTimeout(600_000)

  test('/new asks the summarizer for results and pending, and the carried summary opens with the header', async () => {
    const mock = await startMockServer({ replyForPrompt: () => REPLY })
    const sandbox = createSandbox('hc1218')
    let running: Launched | undefined

    writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n', COMPRESSION_CONFIG)
    writeEnvFile(sandbox.hermesHome)

    try {
      running = await launch(sandbox, SINGLE_THREAD)

      // Long enough to fall outside the compressor's recency tail (about 10K tokens), so `/new` has a middle
      // to summarize; the later turns stay short and inside it.
      await turn(
        running.page,
        `hc1218 用这 5 张图做个 15 秒的视频，素材说明：${'storyboard notes for the demo clip '.repeat(2_000)}`
      )
      await turn(running.page, 'hc1218 以后做视频都用女声配音')
      await turn(running.page, 'hc1218 封面明天再定')

      const before = mock.receivedCompletions.length

      await send(running.page, '/new')

      await expect
        .poll(() => mock.receivedCompletions.slice(before).filter(c => c.prompt.includes(SUMMARIZER)).length, {
          timeout: 120_000,
          message: '/new should ask the summary model for the segment summary'
        })
        .toBe(1)

      const prompt = mock.receivedCompletions.slice(before).find(c => c.prompt.includes(SUMMARIZER))!.prompt

      expect(prompt).toContain(RULES_FIRST)
      expect(prompt.trimEnd().endsWith(RULES_LAST)).toBe(true)
      expect(prompt).not.toContain('FOCUS TOPIC')
      expect(prompt).not.toContain('【新的一段】')

      await expect
        .poll(() => storedSummary(sandbox.hermesHome)?.split('\n')[1] ?? null, {
          timeout: 60_000,
          message: 'the stored summary should open with the header right after the handoff prefix'
        })
        .toBe(HEADER)
      expect(storedSummary(sandbox.hermesHome)!.split(HEADER).length).toBe(2)

      // The one thread goes on from the summary. `/new` is a cancelled send, so the composer puts `/new` back
      // once the segment has started: wait for that (the notice) before typing the next message over it.
      await expect(running.page.getByText('好，前面的我记着，从这儿重新来。')).toBeVisible({ timeout: 60_000 })
      await running.page.waitForTimeout(1_500)
      await turn(running.page, 'hc1218 新的一段第一句')

      const summaries = mock.receivedCompletions
        .map((c, at) => ({ at, boundary: c.prompt.includes(RULES_FIRST), prompt: c.prompt }))
        .filter(c => c.prompt.includes(SUMMARIZER))

      console.log(
        '[hc1218] summary requests:',
        JSON.stringify(summaries.map(({ at, boundary, prompt }) => ({ at, boundary, chars: prompt.length })))
      )
      expect(summaries.filter(c => c.boundary)).toHaveLength(1)
    } finally {
      await running?.app.close().catch(() => {})
      await mock.close()
      sandbox.cleanup()
    }
  })
})
