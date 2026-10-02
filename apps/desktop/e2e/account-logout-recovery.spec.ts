import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop, waitForAppReady, writeMockProviderConfig } from './fixtures'
import { allowErrorBanners, collectErrorBanners, expect, test } from './test'

test('expired platform JWT cannot trap the account behind a silent failed logout', async () => {
  test.setTimeout(120_000)
  const sandbox = createSandbox('account-logout-recovery')
  const mock = await startMockServer()
  let expired = false
  let rejectedRequests = 0
  const fixtureToken = `local.${Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toString('base64url')}.fixture`

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname

    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    if (pathname === '/api/v1/auth/login') {
      json(200, { access_token: fixtureToken, email: 'fixture@example.invalid', name: 'Logout fixture' })
    } else if (expired && request.headers.authorization) {
      rejectedRequests += 1
      json(401, { detail: 'Token expired' })
    } else if (pathname === '/api/v1/desktop/provision-key/capabilities') {
      json(200, { version: 1 })
    } else if (pathname === '/api/v1/desktop/provision-key') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      json(200, { provision_revision: body.provision_revision, api_key: 'sk-apex-local-logout-fixture', base_url: mock.url, model: 'mock-model',
        email: 'fixture@example.invalid', name: 'Logout fixture' })
    } else {
      json(404, { detail: 'fixture route unavailable' })
    }
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
  let app: Awaited<ReturnType<typeof launchDesktop>>['app'] | undefined

  try {
    const fixture = await launchDesktop(buildAppEnv(sandbox, {
      APEXNODES_API_BASE: base, APEXNODES_AUTH_BASE: base,
      HERMES_DESKTOP_PYTHON: process.env.HERMES_DESKTOP_PYTHON || ''
    }))

    app = fixture.app
    const page = fixture.page
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })

    if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) { await later.click() }
    await waitForAppReady({ ...fixture, sandbox, mock, mockUrl: mock.url, cleanup: async () => {} })

    const result = await page.evaluate(async () => {
      const bridge = (window as unknown as { hermesDesktop: { managed: {
        signIn: (payload: { email: string; password: string }) => Promise<{ ok: boolean }>
      } } }).hermesDesktop

      return bridge.managed.signIn({ email: 'fixture@example.invalid', password: 'fixture-password' })
    })

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    await page.reload()
    await expect(page.getByRole('button', { name: '打开账户菜单: Logout fixture' })).toBeVisible()
    const credentialPath = path.join(sandbox.userDataDir, 'apex-managed.json')
    const before = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
    expired = true
    allowErrorBanners()
    await page.getByRole('button', { name: '打开账户菜单: Logout fixture' }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(page.getByText('退出登录未完成。请重试；如果登录已过期，可重新登录。', { exact: true })).toBeVisible()
    expect(rejectedRequests).toBeGreaterThan(0)
    const after = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
    expect(before.relayKey).toBeTruthy()
    expect(before.accessToken).toBeTruthy()
    expect(after.relayKey).toEqual(before.relayKey)
    expect(after.accessToken).toEqual(before.accessToken)
    await page.getByRole('button', { name: '重新登录', exact: true }).click()
    await expect(page.getByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。', { exact: true })).toBeVisible()
    const errors = await collectErrorBanners(page)
    expect(errors.every(message => message.includes('退出登录未完成'))).toBe(true)
    await page.screenshot({ path: test.info().outputPath('logout-expired-sign-in.png') })
  } finally {
    await app?.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await mock.close()
    sandbox.cleanup()
  }
})
