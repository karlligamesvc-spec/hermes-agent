// hc-1226: in product mode, `/new` sent in the one thread does not come back into the composer.
//
// `/new` is carried out by the renderer's single-thread composer middleware (session.compress on the real
// engine, `hermes serve` from this checkout, against a mock model). It used to end its send as a cancel, and
// the composer puts a cancelled send's words back: a few seconds after `/new`, `/new` was in the box again,
// and sending it folded the thread a second time. This drives the real one-thread composer both ways: a
// `/new` that could not run (a reply still streaming) stays in the box, and one that ran leaves it empty, so
// a second press of the send button folds nothing.

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
type Page = Launched['page']

const SINGLE_THREAD = { APEXNODES_SINGLE_THREAD: '1' }
const REPLY = 'hc1226-reply-ok'
const HOLD = 'hc1226-hold-this-reply'
const THREAD_COMPOSER = '[data-slot="composer-rich-input"]:visible'
const SEND = '[data-slot="composer-root"] button[type="submit"]'
const SUMMARIZER = 'You are a summarization agent creating a context checkpoint.'
const RESTARTED = '好，前面的我记着，从这儿重新来。'
const NOT_NOW = '这会儿还没法从头来，稍后再发一次。'

const COMPRESSION_CONFIG = `compression:
  protect_first_n: 0
  protect_last_n: 1
auxiliary:
  title_generation:
    enabled: false
  compression:
    provider: custom
    model: mock-model`

async function launch(sandbox: Sandbox): Promise<Launched> {
  const launched = await launchDesktop(buildAppEnv(sandbox, SINGLE_THREAD))
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

const composer = (page: Page) => page.locator(THREAD_COMPOSER).first()

/** What the one-thread composer holds now, without the editor's trailing line break. */
async function composerText(page: Page): Promise<string> {
  return ((await composer(page).textContent()) ?? '').replace(/[\u200b\n]/g, '').trim()
}

/**
 * Put `text` in an empty one-thread composer in one go and press the send button: typed character by
 * character, a leading `/` opens the command picker and Enter would accept a completion instead of sending.
 */
async function send(page: Page, text: string): Promise<void> {
  const box = composer(page)

  await box.waitFor({ state: 'visible', timeout: 90_000 })
  await box.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
  await expect.poll(() => composerText(page)).toContain(text.slice(0, 40))
  await page.locator(SEND).click()
}

const replies = async (page: Page) => (await page.locator('body').textContent())?.split(REPLY).length ?? 1

async function waitForReply(page: Page, before: number): Promise<void> {
  await page.waitForFunction(
    ([token, count]) => (document.body?.textContent ?? '').split(token as string).length > (count as number),
    [REPLY, before] as const,
    { timeout: 120_000 }
  )
  // The next send must not land while this turn is still settling (a busy thread opens no segment).
  await page.waitForTimeout(1_500)
}

async function turn(page: Page, text: string): Promise<void> {
  const before = await replies(page)

  await send(page, text)
  await waitForReply(page, before)
}

test.describe('hc-1226 /new in the one thread clears the composer', () => {
  test.skip(process.platform === 'win32', 'single-thread dev launch is exercised on macOS and Linux')
  test.setTimeout(600_000)

  test('kept while it cannot run; carried out, it does not come back and is not sent twice', async () => {
    const mock = await startMockServer({ holdFirstStreamForPrompt: HOLD, replyForPrompt: () => REPLY })
    const sandbox = createSandbox('hc1226')
    let running: Launched | undefined
    let held = false

    writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n', COMPRESSION_CONFIG)
    writeEnvFile(sandbox.hermesHome)

    let base = 0
    const summaries = () => mock.receivedCompletions.filter(c => c.prompt.includes(SUMMARIZER)).length - base

    try {
      running = await launch(sandbox)
      const { page } = running

      // Long enough to fall outside the compressor's recency tail (about 10K tokens), so `/new` has a middle
      // to summarize and asks the summary model once per fold.
      await turn(
        page,
        `hc1226 用这 5 张图做个 15 秒的视频，素材说明：${'storyboard notes for the demo clip '.repeat(2_000)}`
      )

      // 1. A reply still streaming: `/new` cannot run now, so it stays in the box with the notice.
      base = summaries()
      const beforeHeld = await replies(page)

      await send(page, `hc1226 再写一版文案 ${HOLD}`)
      await mock.waitForHeldStream()
      held = true
      await send(page, '/new')
      await expect(page.getByText(NOT_NOW)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => composerText(page), { timeout: 10_000 }).toBe('/new')
      expect(summaries()).toBe(0)

      mock.releaseHeldStream()
      held = false
      await waitForReply(page, beforeHeld)
      // A last short turn: the fold keeps the recent tail and needs a middle before it to summarize.
      await turn(page, 'hc1226 封面明天再定')

      // 2. Idle: `/new` folds the thread once and the composer stays empty.
      await send(page, '/new')
      await expect(page.getByText(RESTARTED)).toBeVisible({ timeout: 120_000 })
      await expect.poll(summaries, { timeout: 60_000, message: '/new should ask the summary model once' }).toBe(1)

      // The old cancel put `/new` back right after the notice; give it more than that to show up.
      await page.waitForTimeout(4_000)
      expect(await composerText(page)).toBe('')

      // Pressing send again on the empty composer sends nothing and folds nothing.
      await composer(page).click()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(4_000)
      expect(await composerText(page)).toBe('')
      expect(summaries()).toBe(1)

      // The thread goes on from the summary.
      await turn(page, 'hc1226 新的一段第一句')
      expect(summaries()).toBe(1)
    } finally {
      if (held) {
        mock.releaseHeldStream()
      }

      await running?.app.close().catch(() => {})
      await mock.close()
      sandbox.cleanup()
    }
  })
})
