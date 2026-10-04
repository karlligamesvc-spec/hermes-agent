import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { packagedBinaryExists, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

test('installed version entry reaches the native package feed instead of the Git updater', async () => {
  test.skip(!packagedBinaryExists(), "Run 'npm run pack' first to test the installed update entry")
  test.setTimeout(120_000)
  let version = '0.0.0'
  let feedReads = 0
  const feed = http.createServer((request, response) => {
    if (['/latest-mac.yml', '/latest.yml'].includes(new URL(request.url || '/', 'http://localhost').pathname)) {
      feedReads += 1
      response.writeHead(200, { 'content-type': 'application/yaml' })
      response.end(JSON.stringify({ version, files: [{ url: 'APEX-current.zip', sha512: Buffer.alloc(64).toString('base64'), size: 1 }] }))
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>(resolve => feed.listen(0, '127.0.0.1', resolve))
  const feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`
  let fixture: Awaited<ReturnType<typeof setupPackagedMockBackend>> | undefined

  try {
    fixture = await setupPackagedMockBackend({ APEXNODES_API_BASE: feedUrl, APEXNODES_AUTH_BASE: feedUrl })
    const { app, page } = fixture
    version = await app.evaluate(async ({ app }) => {
      if (!app.isPackaged) {throw new Error('This regression must run in the packaged app')}
      const { createRequire } = await import('node:module')
      const resourcesPath = (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
      const require = createRequire(`${resourcesPath}/updater-deps/fixture.cjs`)
      const { autoUpdater } = require('./vendor/node_modules/electron-updater')
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.APEXNODES_API_BASE, useMultipleRangeRequest: false })

      return app.getVersion()
    })
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })
    if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {await later.click()}
    await waitForAppReady(fixture)
    await page.getByRole('contentinfo').getByRole('button', { name: `v${version}`, exact: true }).click()
    const check = page.getByRole('button', { name: '检查 APEX 更新', exact: true })
    await expect(check).toBeVisible()
    await expect(page.getByText(/isn't a git checkout/)).toHaveCount(0)
    const before = feedReads
    await check.click()
    await expect.poll(() => feedReads).toBeGreaterThan(before)
    await expect.poll(() => page.evaluate(async () => {
      const bridge = (window as unknown as { hermesDesktop: { shellUpdate: { getState: () => Promise<{ phase: string }> } } }).hermesDesktop
      return (await bridge.shellUpdate.getState()).phase
    })).toBe('idle')
    await expect(page.getByText(/isn't a git checkout/)).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('native-update-entry.png') })
  } finally {
    await fixture?.cleanup()
    await new Promise<void>(resolve => feed.close(() => resolve()))
  }
})
