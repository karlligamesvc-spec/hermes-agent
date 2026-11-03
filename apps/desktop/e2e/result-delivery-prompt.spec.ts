// hc-1131: product mode's rule against local paths in replies reaches the LLM only in product mode.
//
// The switch lives in the renderer, the marker is written by main and read by the engine, so no
// single process can prove the chain. This flips the real setting in the real window and reads the
// system prompt the real engine (`hermes serve` from this checkout) sent to the mock LLM. Whether a
// real model then obeys the rule is outside what a mock can show.

import fs from 'node:fs'
import path from 'node:path'

import { receivedSystemPrompts, startMockServer } from '../../../tests-js/scripts/mock-server'

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
const RULE_HEADING = '【怎么交付文件 · 平台规则】'
const REPLY = 'hc1131-reply-ok'
const THREAD_COMPOSER = '[data-slot="composer-rich-input"]:visible'
// Developer mode opens a new session on the Start page, whose input is a plain textarea.
const START_PAGE_COMPOSER = 'textarea:visible'

const SECTION = /\n\n## Plugin Context: apex\.user-results\n[\s\S]*?(?=\n<!-- hermes-plugin-sections:end -->)/

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

/** Send one line and wait for the mock's reply to land, then return the prompt that turn's model call carried. */
async function promptForATurn(page: Launched['page'], composerSelector: string, text: string): Promise<string> {
  const before = receivedSystemPrompts.length
  const replies = (await page.locator('body').textContent())?.split(REPLY).length ?? 1
  const composer = page.locator(composerSelector).first()

  await composer.waitFor({ state: 'visible', timeout: 90_000 })
  await composer.click()
  await composer.type(text, { delay: 10 })
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    count => (document.body?.textContent ?? '').split('hc1131-reply-ok').length > count,
    replies,
    { timeout: 120_000 }
  )

  const prompts = receivedSystemPrompts.slice(before).filter(prompt => prompt.includes('Platform: desktop'))

  expect(prompts.length).toBeGreaterThan(0)

  return prompts.at(-1)!
}

async function setDeveloperMode(page: Launched['page'], on: boolean): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=config:appearance'
  })

  const row = page.locator('[id="setting-field-appearance.tool-view"]')

  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.getByText(on ? '开' : '关', { exact: true }).click()
}

const withoutMachineLines = (prompt: string) => prompt.replace(/^Conversation started: .*$/m, '')

test.describe('hc-1131 no local paths in replies: product mode only', () => {
  test.skip(process.platform === 'win32', 'single-thread dev launch is exercised on macOS and Linux')
  test.setTimeout(600_000)

  test('the engine sends the rule in product mode and leaves it out in developer mode', async () => {
    const mock = await startMockServer({ replyForPrompt: () => REPLY })
    const sandbox = createSandbox('hc1131')
    const marker = path.join(sandbox.hermesHome, 'apex', 'developer-mode')
    let running: Launched | undefined

    writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
    writeEnvFile(sandbox.hermesHome)

    try {
      // 1. Product mode: the rule is in what the model receives, in Desktop's chat.
      running = await launch(sandbox, SINGLE_THREAD)
      expect(fs.existsSync(marker)).toBe(false)

      const product = await promptForATurn(running.page, THREAD_COMPOSER, 'hc1131 产品模式')

      expect(product).toContain(RULE_HEADING)

      // 2. The real setting writes the marker, and a new session's prompt has no rule.
      await setDeveloperMode(running.page, true)
      await expect.poll(() => fs.existsSync(marker), { timeout: 15_000 }).toBe(true)
      await running.page.evaluate(() => {
        window.location.hash = '#/'
      })

      const developer = await promptForATurn(running.page, START_PAGE_COMPOSER, 'hc1131 开发者模式')

      expect(developer).not.toContain(RULE_HEADING)

      // 3. The one section is all that separates the two prompts.
      expect(SECTION.test(product)).toBe(true)
      expect(withoutMachineLines(developer)).toBe(withoutMachineLines(product.replace(SECTION, '')))

      await running.app.close()
      running = undefined

      // 4. Someone already in developer mode when this ships has no marker yet: the launch writes it.
      fs.rmSync(marker)
      running = await launch(sandbox, SINGLE_THREAD)
      await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true)

      // 5. Leaving developer mode removes it.
      await setDeveloperMode(running.page, false)
      await expect.poll(() => fs.existsSync(marker), { timeout: 15_000 }).toBe(false)
    } finally {
      await running?.app.close().catch(() => {})
      await mock.close()
      fs.rmSync(sandbox.root, { force: true, recursive: true, maxRetries: 3 })
    }
  })
})
