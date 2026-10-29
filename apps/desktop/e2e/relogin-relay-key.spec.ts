// hc-1106: signing in again rotates the relay key, and the relay then answers
// the old one with 401. The running engine must move onto the new key: before
// the fix it kept the old one until the app quit, so the next turn in the same
// conversation failed with 「当前APEX凭据无效或已失效」.

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop, waitForAppReady, writeMockProviderConfig } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

const ROTATED = '当前APEX凭据无效或已失效。请在正在使用的 APEX客户端重新登录或修复连接，然后重试。'

function listen(server: http.Server): Promise<string> {
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  )
}

interface Relogin {
  page: Awaited<ReturnType<typeof launchDesktop>>['page']
  mock: Awaited<ReturnType<typeof startMockServer>>
  relayed: Array<{ key: number; path: string }>
  rejected: Array<{ key: number; path: string }>
  signIn: () => Promise<unknown>
  send: (text: string) => Promise<void>
  replied: (text: string) => Promise<unknown>
  desktopLog: () => string
}

// Real engine (hermes serve from this checkout) + a fake APEX account server that mints a new key
// on every sign-in + a fake relay that accepts only the newest key and forwards it to the mock.
async function withRelogin(
  name: string,
  mockOptions: Parameters<typeof startMockServer>[0],
  body: (ctx: Relogin) => Promise<void>
) {
  const sandbox = createSandbox(name)

  // The engine appends its own notes to a first prompt, so the reply is a token, not an echo.
  const mock = await startMockServer({
    ...mockOptions,
    replyForPrompt: prompt => (prompt.match(/relogin probe (one|two|hold)/)?.[0] ?? 'other').replace(/ /g, '-') + '-ok'
  })

  const keys: string[] = []
  const relayed: Array<{ key: number; path: string }> = []
  const rejected: Array<{ key: number; path: string }> = []
  const keyIndex = (auth: string) => keys.indexOf(auth.replace(/^Bearer /, ''))

  // The relay: only the newest key passes; an older one was rotated away (api-relay answers 401).
  const relay = http.createServer((request, response) => {
    const used = keyIndex(String(request.headers.authorization || ''))
    const path = String(request.url || '')

    if (used < 0 || used !== keys.length - 1) {
      rejected.push({ key: used, path })
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: ROTATED, type: 'authentication_error' } }))

      return
    }

    relayed.push({ key: used, path })

    const upstream = http.request(`${mock.url}${path}`, { method: request.method, headers: request.headers }, reply => {
      response.writeHead(reply.statusCode || 502, reply.headers)
      reply.pipe(response)
    })

    request.pipe(upstream)
  })

  const relayUrl = await listen(relay)

  // The APEX account server: every sign-in provisions a fresh key (the server rotates the old one).
  const account = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname

    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (pathname === '/api/v1/auth/login') {
      json(200, {
        access_token: `local.${Buffer.from(JSON.stringify({ sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toString('base64url')}.relogin`,
        email: 'relogin@example.invalid',
        name: 'Relogin fixture'
      })
    } else if (pathname === '/api/v1/desktop/provision-key/capabilities') {
      json(200, { version: 1 })
    } else if (pathname === '/api/v1/desktop/provision-key') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
      }

      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      keys.push(`sk-apex-relogin-${keys.length + 1}-${Date.now()}`)
      json(200, {
        provision_revision: payload.provision_revision,
        api_key: keys.at(-1),
        base_url: `${relayUrl}/v1`,
        model: 'mock-model',
        email: 'relogin@example.invalid',
        name: 'Relogin fixture'
      })
    } else {
      json(404, { detail: 'fixture route unavailable' })
    }
  })

  const base = await listen(account)
  writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
  const logPath = (log: string) => `${sandbox.hermesHome}/logs/${log}`
  let app: Awaited<ReturnType<typeof launchDesktop>>['app'] | undefined

  try {
    const fixture = await launchDesktop(
      buildAppEnv(sandbox, {
        APEXNODES_API_BASE: base,
        APEXNODES_AUTH_BASE: base,
        HERMES_DESKTOP_PYTHON: process.env.HERMES_DESKTOP_PYTHON || ''
      })
    )

    app = fixture.app
    const page = fixture.page
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })

    if (
      await later.waitFor({ state: 'visible', timeout: 3000 }).then(
        () => true,
        () => false
      )
    ) {
      await later.click()
    }

    await waitForAppReady({ ...fixture, sandbox, mock, mockUrl: mock.url, cleanup: async () => {} })

    await body({
      page,
      mock,
      relayed,
      rejected,
      signIn: () =>
        page.evaluate(async () => {
          const bridge = (
            window as unknown as {
              hermesDesktop: {
                managed: { signIn: (payload: { email: string; password: string }) => Promise<{ ok: boolean }> }
              }
            }
          ).hermesDesktop

          return bridge.managed.signIn({ email: 'relogin@example.invalid', password: 'fixture-password' })
        }),
      send: async text => {
        const composer = page.locator('textarea:visible, [contenteditable="true"]:visible').first()
        await composer.waitFor({ state: 'visible', timeout: 90_000 })
        await composer.click()
        await composer.type(text, { delay: 10 })

        // Enter pressed while the renderer re-dials a restarted engine is not sent; the text stays in
        // the composer, and a user presses it again. Sent = the composer is empty.
        const unsent = () => composer.evaluate(el => ((el as HTMLTextAreaElement).value ?? el.textContent ?? '').trim())

        for (let attempt = 0; attempt < 6; attempt += 1) {
          await page.keyboard.press('Enter')

          if (
            await expect
              .poll(unsent, { timeout: 5_000 })
              .toBe('')
              .then(
                () => true,
                () => false
              )
          ) {
            return
          }
        }

        throw new Error(`the composer never sent "${text}"`)
      },
      replied: text =>
        page.waitForFunction(
          reply => (document.body?.textContent ?? '').includes(reply),
          `${text.replace(/ /g, '-')}-ok`,
          {
            timeout: 90_000
          }
        ),
      desktopLog: () => (fs.existsSync(logPath('desktop.log')) ? fs.readFileSync(logPath('desktop.log'), 'utf8') : '')
    })
  } finally {
    // A stream the test left held would keep mock.close() waiting forever.
    mock.releaseHeldStream()
    await app?.close()

    for (const log of ['desktop.log', 'agent.log', 'errors.log']) {
      if (fs.existsSync(logPath(log))) {
        fs.copyFileSync(logPath(log), test.info().outputPath(log))
      }
    }

    await new Promise<void>(resolve => relay.close(() => resolve()))
    await new Promise<void>(resolve => account.close(() => resolve()))
    await mock.close()
    sandbox.cleanup()
  }
}

const completions = (calls: Array<{ key: number; path: string }>, key: number) =>
  calls.filter(call => call.key === key && call.path.endsWith('/chat/completions'))

test('a re-login moves the running engine onto the new relay key', async () => {
  test.setTimeout(300_000)

  await withRelogin('relogin-relay-key', {}, async ({ page, relayed, rejected, signIn, send, replied }) => {
    // First sign-in, then a conversation whose engine session is built on that key.
    expect(await signIn()).toMatchObject({ ok: true })
    await page.reload()
    await send('relogin probe one')
    await replied('relogin probe one')
    expect(completions(relayed, 0).length).toBeGreaterThan(0)

    // Sign in again on the same device: key 2 is minted, key 1 is rotated away.
    allowErrorBanners()
    expect(await signIn()).toMatchObject({ ok: true })
    const rejectedBefore = rejected.length

    // The next turn in the same conversation must reach the relay with the new key.
    await send('relogin probe two')
    await replied('relogin probe two')
    await page.screenshot({ path: test.info().outputPath('relogin-second-turn.png') })
    expect(completions(relayed, 1).length).toBeGreaterThan(0)
    expect(rejected.slice(rejectedBefore).filter(call => call.path.endsWith('/chat/completions'))).toEqual([])
  })
})

test('a re-login during a reply lets the turn finish, then moves the engine onto the new key', async () => {
  test.setTimeout(360_000)

  await withRelogin(
    'relogin-relay-key-busy',
    { holdFirstStreamForPrompt: 'relogin probe hold' },
    async ({ page, mock, relayed, rejected, signIn, send, replied, desktopLog }) => {
      expect(await signIn()).toMatchObject({ ok: true })
      await page.reload()
      await send('relogin probe hold')
      await mock.waitForHeldStream()

      // Re-login while the reply is still streaming: the engine is asked, says busy, and keeps the turn.
      allowErrorBanners()
      expect(await signIn()).toMatchObject({ ok: true })
      // desktop.log is appended asynchronously: poll for the line instead of reading it once.
      await expect
        .poll(desktopLog, { timeout: 15_000 })
        .toContain('primary backend "default" still holds the previous relay key; restarting it once idle (busy')
      expect(desktopLog()).not.toContain('restarting primary backend')

      mock.releaseHeldStream()
      await replied('relogin probe hold')

      // Idle now: the 30 s retry restarts it.
      await expect
        .poll(() => desktopLog().includes('restarting primary backend "default" for the refreshed relay key'), {
          timeout: 75_000
        })
        .toBe(true)

      const rejectedBefore = rejected.length
      await send('relogin probe two')
      await replied('relogin probe two')
      await page.screenshot({ path: test.info().outputPath('relogin-after-busy-turn.png') })
      expect(completions(relayed, 1).length).toBeGreaterThan(0)
      expect(rejected.slice(rejectedBefore).filter(call => call.path.endsWith('/chat/completions'))).toEqual([])
    }
  )
})
