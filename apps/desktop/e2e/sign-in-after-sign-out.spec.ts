// hc-1121: signing in through the real login screen while the primary restarts
// for the new key. The restart takes the renderer's socket down right when the
// screen checks the runtime, so a successful sign-in (M7, 0.17.68, finding 16)
// stayed on the screen with a red line blaming the relay, and retrying only
// restarted the engine again. relogin-relay-key.spec.ts calls the bridge directly
// and never reaches that check.

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RED = '登录成功,但运行时无法连接'

function listen(server: http.Server): Promise<string> {
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  )
}

async function readJson(request: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }

  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

type App = Awaited<ReturnType<typeof launchDesktop>>

interface Fixture {
  sandbox: ReturnType<typeof createSandbox>
  keys: Array<{ key: string; status: 'active' | 'revoked' | 'rotated' }>
  /** Chat calls the relay turned away, by what they presented. */
  rejected: string[]
  /** Chat calls the relay took, by key index. */
  relayed: number[]
  current: () => App
  /** Quit, do `whileClosed`, start again on the same home and user data. */
  relaunch: (whileClosed?: () => void) => Promise<void>
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  send: (text: string) => Promise<void>
  replied: (text: string) => Promise<unknown>
  desktopLog: () => string
}

async function withAccountServer(
  name: string,
  extraEnv: Record<string, string>,
  body: (ctx: Fixture) => Promise<void>
) {
  const sandbox = createSandbox(name)

  const mock = await startMockServer({
    replyForPrompt: prompt => (prompt.match(/sign-in probe (one|two)/)?.[0] ?? 'other').replace(/ /g, '-') + '-ok'
  })

  const keys: Fixture['keys'] = []
  const rejected: string[] = []
  const relayed: number[] = []
  const token = `local.${Buffer.from(JSON.stringify({ sub: USER })).toString('base64url')}.signin`

  const relay = http.createServer((request, response) => {
    const presented = String(request.headers.authorization || '').replace(/^Bearer /, '')
    const index = keys.findIndex(entry => entry.key === presented)
    const chat = String(request.url || '').endsWith('/chat/completions')

    if (index < 0 || keys[index].status !== 'active') {
      if (chat) {
        rejected.push(index < 0 ? presented || '(no key)' : `key ${index} (${keys[index].status})`)
      }

      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'rejected', type: 'authentication_error' } }))

      return
    }

    if (chat) {
      relayed.push(index)
    }

    const upstream = http.request(
      `${mock.url}${request.url}`,
      { method: request.method, headers: request.headers },
      reply => {
        response.writeHead(reply.statusCode || 502, reply.headers)
        reply.pipe(response)
      }
    )

    request.pipe(upstream)
  })

  const relayUrl = await listen(relay)

  const account = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname

    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (pathname === '/api/v1/desktop/provision-key/capabilities') {
      json(200, { version: 1 })
    } else if (pathname === '/api/v1/desktop/provision-key') {
      const payload = await readJson(request)
      keys.filter(entry => entry.status === 'active').forEach(entry => (entry.status = 'rotated'))
      keys.push({ key: `sk-apex-signin-${keys.length + 1}-${Date.now()}`, status: 'active' })
      json(200, {
        provision_revision: payload.provision_revision,
        api_key: keys.at(-1)?.key,
        base_url: `${relayUrl}/v1`,
        model: 'mock-model',
        email: 'signin@example.invalid',
        name: 'Sign-in fixture'
      })
    } else if (pathname === '/api/v1/desktop/provision-key/revoke') {
      const payload = await readJson(request)
      keys.filter(entry => entry.status === 'active').forEach(entry => (entry.status = 'revoked'))
      json(200, {
        revoked: true,
        ...(payload.provision_revision ? { provision_revision: payload.provision_revision } : {})
      })
    } else {
      json(404, { detail: 'fixture route unavailable' })
    }
  })

  const base = await listen(account)
  const logPath = path.join(sandbox.hermesHome, 'logs', 'desktop.log')

  const launch = async (): Promise<App> => {
    const fixture = await launchDesktop(
      buildAppEnv(sandbox, {
        APEXNODES_API_BASE: base,
        APEXNODES_AUTH_BASE: base,
        HERMES_DESKTOP_PYTHON: process.env.HERMES_DESKTOP_PYTHON || '',
        APEXNODES_SINGLE_THREAD: '1',
        ...extraEnv
      })
    )

    // The system browser, as far as the app can tell: remember where it was sent.
    await fixture.app.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { hc1120Opened: opened })

      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })

    return fixture
  }

  let running: App | undefined = await launch()
  const current = () => running as App

  try {
    await body({
      sandbox,
      keys,
      rejected,
      relayed,
      current,
      relaunch: async whileClosed => {
        await running?.app.close()
        running = undefined
        whileClosed?.()
        running = await launch()
      },
      signIn: async () => {
        const { app, page } = current()
        await page.getByRole('button', { name: /登录 APEX/ }).click({ timeout: 60_000 })
        let opened = ''

        await expect
          .poll(
            async () => {
              opened = await app.evaluate(
                () => (globalThis as unknown as { hc1120Opened: string[] }).hc1120Opened.shift() ?? ''
              )

              return opened
            },
            { timeout: 15_000 }
          )
          .not.toBe('')

        // What the web login does once the user has signed in: send the browser back to the app.
        const start = new URL(opened)
        const back = new URL(String(start.searchParams.get('desktop_cb')))
        back.searchParams.set('token', token)
        back.searchParams.set('state', String(start.searchParams.get('state')))
        await fetch(back)
      },
      signOut: async () => {
        const { page } = current()
        allowErrorBanners()
        await page.getByRole('button', { name: /^打开账户菜单/ }).click()
        await page.getByRole('menuitem', { name: '退出登录' }).click()
      },
      send: async text => {
        const { page } = current()
        const composer = page.locator('textarea:visible, [contenteditable="true"]:visible').first()
        await composer.waitFor({ state: 'visible', timeout: 90_000 })
        await composer.click()
        await composer.type(text, { delay: 10 })

        // Enter pressed while the renderer re-dials a restarted engine is not sent (relogin-relay-key.spec.ts).
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
        current().page.waitForFunction(
          reply => (document.body?.textContent ?? '').includes(reply),
          `${text.replace(/ /g, '-')}-ok`,
          { timeout: 45_000 }
        ),
      desktopLog: () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
    })
  } finally {
    await running?.app.close()

    for (const log of ['desktop.log', 'agent.log', 'errors.log']) {
      const file = path.join(sandbox.hermesHome, 'logs', log)

      if (fs.existsSync(file)) {
        fs.copyFileSync(file, test.info().outputPath(log))
      }
    }

    await new Promise<void>(resolve => relay.close(() => resolve()))
    await new Promise<void>(resolve => account.close(() => resolve()))
    await mock.close()
    sandbox.cleanup()
  }
}

// The login screen unmounts while the gateway is down (DesktopAuthGate's `enabled`), so "the button
// is hidden" proves nothing during a restart: the red line lands when the engine is back. Watch through
// the restart, then look at where it settled.
async function formClosed({ current }: Fixture) {
  const { page } = current()
  const red = page.getByText(RED).first()
  const until = Date.now() + 12_000

  while (Date.now() < until) {
    expect(await red.isVisible().catch(() => false), 'a red line blaming the relay').toBe(false)
    await page.waitForTimeout(100)
  }

  await expect(page.getByRole('button', { name: /登录 APEX/ })).toBeHidden({ timeout: 25_000 })
}

async function turnOnKey(ctx: Fixture, text: string, key: number) {
  await ctx.send(text)
  await ctx.replied(text).catch(error => {
    throw new Error(
      `no reply; the relay saw ${JSON.stringify(ctx.relayed)}, turned away ${JSON.stringify(ctx.rejected)}: ${error}`
    )
  })
  expect(
    ctx.relayed.at(-1),
    `the relay saw: ${JSON.stringify(ctx.relayed)}; turned away: ${JSON.stringify(ctx.rejected)}`
  ).toBe(key)
}

async function firstTurnThenSignOut(ctx: Fixture) {
  await ctx.signIn()
  await formClosed(ctx)
  await turnOnKey(ctx, 'sign-in probe one', 0)
  await ctx.signOut()
  await expect(ctx.current().page.getByRole('button', { name: /登录 APEX/ })).toBeVisible({ timeout: 30_000 })
}

test('signing in again from the account menu closes the login screen, with no red line', async () => {
  test.setTimeout(300_000)

  await withAccountServer('signin-again', {}, async ctx => {
    await ctx.signIn()
    await formClosed(ctx)
    await turnOnKey(ctx, 'sign-in probe one', 0)

    allowErrorBanners()
    const { page } = ctx.current()
    await page.getByRole('button', { name: /^打开账户菜单/ }).click()
    await page.getByRole('menuitem', { name: '重新登录' }).click()
    await ctx.signIn()
    await formClosed(ctx)
    await expect
      .poll(ctx.desktopLog, { timeout: 30_000 })
      .toContain('restarting primary backend "default" for the refreshed relay key')
    await page.screenshot({ path: test.info().outputPath('after-sign-in-again.png') })

    await turnOnKey(ctx, 'sign-in probe two', 1)
    expect(ctx.rejected).toEqual([])
    expect(ctx.keys.map(entry => entry.status)).toEqual(['rotated', 'active'])
  })
})

// Without single-thread mode the account row stays mounted behind the login screen.
test('signing out and back in does not bring the account menu back', async () => {
  test.setTimeout(240_000)

  await withAccountServer('signin-menu-closed', { APEXNODES_SINGLE_THREAD: '0' }, async ctx => {
    await firstTurnThenSignOut(ctx)
    await ctx.signIn()
    await formClosed(ctx)
    await expect(ctx.current().page.getByRole('menuitem', { name: '退出登录' })).toBeHidden({ timeout: 10_000 })
    await turnOnKey(ctx, 'sign-in probe two', 1)
  })
})
