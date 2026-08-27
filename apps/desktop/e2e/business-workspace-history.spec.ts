import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { startMockServer } from './mock-server'
import { RealSessionBuilder } from './real-session-builder'
import { expect, test } from './test'

const HISTORY_PROMPT = 'HC-697 persisted customer handoff evidence'

test('Projects reads a durable session and restores its current stored tip', async () => {
  test.setTimeout(150_000)

  const mock = await startMockServer()
  const sandbox = createSandbox('business-workspace-history')

  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)

  const builder = await RealSessionBuilder.start(sandbox.hermesHome)

  const seeded = await builder.createSession({
    title: 'HC-697 durable history',
    turns: [HISTORY_PROMPT]
  })

  await builder.close()

  const { app, page } = await launchDesktop(buildAppEnv(sandbox))

  try {
    // This fixture already has a configured BYOK provider. Choose that real
    // first-run branch so the managed-account gate does not cover Projects.
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    await waitForAppReady({ app, page, sandbox, cleanup: async () => undefined }, 120_000)

    const startRow = page.getByRole('button').filter({ hasText: HISTORY_PROMPT }).first()

    await expect(startRow).toBeVisible({ timeout: 30_000 })

    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).click()
    const persistedRow = page.getByRole('button').filter({ hasText: HISTORY_PROMPT }).first()

    await expect(persistedRow).toBeVisible({ timeout: 30_000 })

    await persistedRow.click()
    await expect(page.locator('[data-slot="aui_thread-viewport"]')).toContainText(HISTORY_PROMPT, {
      timeout: 30_000
    })
    await expect.poll(() => page.evaluate(() => location.hash)).toContain(seeded.sessionId)
  } finally {
    await app.close().catch(() => undefined)
    await mock.close()
    sandbox.cleanup()
  }
})
