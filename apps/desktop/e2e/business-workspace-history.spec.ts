import { startMockServer } from '../../../tests-js/scripts/mock-server'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { RealSessionBuilder } from './real-session-builder'
import { expect, test } from './test'

const HISTORY_PROMPT = 'HC-697 persisted customer handoff evidence'

test('Projects and sidebar reopen the same durable session', async () => {
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

    const sessionRow = page.getByRole('button', { name: 'HC-697 durable history', exact: true })

    await expect(sessionRow).toBeVisible({ timeout: 30_000 })

    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).click()
    await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()

    await expect(sessionRow).toBeVisible()
    const projectRow = page.getByRole('button', { name: /HC-697 durable history HC-697/ })

    await expect(projectRow).toBeVisible()
    await projectRow.click()
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
