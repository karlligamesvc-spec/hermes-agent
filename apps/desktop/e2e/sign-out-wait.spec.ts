// hc-1142: 「退出登录」 left the window as it was for 2–3 s (Kael, 0.17.70, real
// account). Measured in this harness on fork main f159f8abf3, with 0.8 s added to
// every request to the account server: the IPC took 1.7 s (a capabilities GET, then
// the revoke), the login screen drew, and 0.15 s later it was gone again for 3.3 s,
// because the auth gate renders nothing while the gateway is down and every sign-out
// restarts the engine. Product mode now covers the window at the click, reuses the
// capabilities read when the menu opened, and keeps the login screen up through the
// restart. Fail-closed stays: the window looks signed out only after the revoke.
//
// Also here: a sign-in right after a sign-out (on main it lost its request to the
// engine the sign-out was stopping, ECONNRESET, and was left half done), and
// quitting the app in the middle of a sign-out.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** What the network to apex-nodes.com adds to every account-server request. */
const ROUND_TRIP_MS = 800

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

interface AccountRequest {
  path: string
  arrived: number
  answered?: number
}

interface Fixture {
  sandbox: ReturnType<typeof createSandbox>
  keys: Array<{ key: string; status: 'active' | 'revoked' | 'rotated' }>
  accountRequests: AccountRequest[]
  /** Chat calls the relay took, by key index. */
  relayed: number[]
  /** Chat calls the relay turned away. */
  rejected: string[]
  /** Delay every account-server request by this much. */
  setDelay: (ms: number) => void
  /** Leave the revoke unanswered. */
  setRevokeHangs: (hangs: boolean) => void
  current: () => App
  relaunch: () => Promise<void>
  quit: () => Promise<void>
  signIn: () => Promise<void>
  /** The web login sending the browser back to the app, for a sign-in already started. */
  finishBrowserSignIn: () => Promise<void>
  /** From now on the "browser" sends the app back the moment it is opened, as a parked handoff code does. */
  instantBrowser: () => Promise<void>
  openAccountMenu: () => Promise<void>
  send: (text: string) => Promise<void>
  replied: (text: string) => Promise<unknown>
  desktopLog: () => string
}

// Every change of what the window shows, stamped with Date.now() (the same clock as the fake servers).
const TIMELINE = `(() => {
  if (window.__hc1142) return
  const events = []
  window.__hc1142 = { events, armed: false }
  const rec = name => { if (window.__hc1142.armed) events.push({ name, at: Date.now() }) }
  document.addEventListener('pointerdown', () => rec('pointerdown'), true)
  const text = () => (document.body ? document.body.textContent || '' : '')
  const snapshot = () => ({
    login: [...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('登录 APEX')),
    cover: text().includes('正在退出登录'),
    menu: !!document.querySelector('[role="menu"]'),
    accountRow: !!document.querySelector('[data-single-thread-account]')
  })
  let last = snapshot()
  new MutationObserver(() => {
    const now = snapshot()
    for (const key of Object.keys(now)) {
      if (now[key] !== last[key]) {
        const name = key + '=' + now[key]
        requestAnimationFrame(() => rec(name))
      }
    }
    last = now
  }).observe(document, { attributes: true, characterData: true, childList: true, subtree: true })
  window.__hc1142.arm = () => { events.length = 0; last = snapshot(); window.__hc1142.armed = true }
})()`

async function withAccountServer(name: string, body: (ctx: Fixture) => Promise<void>) {
  const sandbox = createSandbox(name)

  const mock = await startMockServer({
    replyForPrompt: prompt => (prompt.match(/sign-out probe (one|two|three)/)?.[0] ?? 'other').replace(/ /g, '-') + '-ok'
  })

  const keys: Fixture['keys'] = []
  const accountRequests: AccountRequest[] = []
  const relayed: number[] = []
  const rejected: string[] = []
  const token = `local.${Buffer.from(JSON.stringify({ sub: USER })).toString('base64url')}.signout`
  let delayMs = 0
  let revokeHangs = false

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
    const seen: AccountRequest = { path: pathname, arrived: Date.now() }
    accountRequests.push(seen)
    const payload = await readJson(request)

    if (delayMs) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    const json = (status: number, answer: unknown) => {
      seen.answered = Date.now()
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer))
    }

    if (pathname === '/api/v1/desktop/provision-key/capabilities') {
      json(200, { version: 1 })
    } else if (pathname === '/api/v1/desktop/provision-key') {
      keys.filter(entry => entry.status === 'active').forEach(entry => (entry.status = 'rotated'))
      keys.push({ key: `sk-apex-signout-wait-${keys.length + 1}-${Date.now()}`, status: 'active' })
      json(200, {
        provision_revision: payload.provision_revision,
        api_key: keys.at(-1)?.key,
        base_url: `${relayUrl}/v1`,
        model: 'mock-model',
        email: 'signout@example.invalid',
        name: 'Sign-out fixture'
      })
    } else if (pathname === '/api/v1/desktop/provision-key/revoke') {
      if (revokeHangs) {
        return // The answer never comes; teardown closes the connection.
      }

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
        APEXNODES_SINGLE_THREAD: '1'
      })
    )

    // The system browser, as far as the app can tell: remember where it was sent.
    await fixture.app.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { hc1142Opened: opened })

      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
    await fixture.page.addInitScript(TIMELINE)
    await fixture.page.evaluate(TIMELINE)

    return fixture
  }

  let running: App | undefined = await launch()
  const current = () => running as App

  // What the web login does once the user has signed in: send the browser back to the app.
  const finishBrowserSignIn = async () => {
    const { app } = current()
    let opened = ''

    await expect
      .poll(
        async () => {
          opened = await app.evaluate(
            () => (globalThis as unknown as { hc1142Opened: string[] }).hc1142Opened.shift() ?? ''
          )

          return opened
        },
        { timeout: 15_000 }
      )
      .not.toBe('')

    const start = new URL(opened)
    const back = new URL(String(start.searchParams.get('desktop_cb')))
    back.searchParams.set('token', token)
    back.searchParams.set('state', String(start.searchParams.get('state')))
    await fetch(back)
  }

  try {
    await body({
      sandbox,
      keys,
      accountRequests,
      relayed,
      rejected,
      setDelay: ms => {
        delayMs = ms
      },
      setRevokeHangs: hangs => {
        revokeHangs = hangs
      },
      current,
      relaunch: async () => {
        await running?.app.close()
        running = await launch()
      },
      quit: async () => {
        await running?.app.close()
        running = undefined
      },
      signIn: async () => {
        await current().page.getByRole('button', { name: /登录 APEX/ }).click({ timeout: 60_000 })
        await finishBrowserSignIn()
      },
      finishBrowserSignIn,
      instantBrowser: async () => {
        await current().app.evaluate(({ shell }, loginToken) => {
          shell.openExternal = async (url: string) => {
            const start = new URL(url)
            const back = new URL(String(start.searchParams.get('desktop_cb')))
            back.searchParams.set('token', loginToken)
            back.searchParams.set('state', String(start.searchParams.get('state')))
            void fetch(back)
          }
        }, token)
      },
      openAccountMenu: async () => {
        const { page } = current()
        await page.locator('[data-single-thread-account]').click({ timeout: 60_000 })
        await page.getByRole('menuitem', { name: '退出登录' }).waitFor({ state: 'visible', timeout: 10_000 })
      },
      send: async text => {
        const { page } = current()
        const composer = page.locator('[data-slot="composer-rich-input"]:visible, textarea:visible').first()
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
          { timeout: 60_000 }
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

    relay.closeAllConnections()
    account.closeAllConnections()
    await new Promise<void>(resolve => relay.close(() => resolve()))
    await new Promise<void>(resolve => account.close(() => resolve()))
    await mock.close()
    sandbox.cleanup()
  }
}

const loginScreen = (ctx: Fixture) => ctx.current().page.getByRole('button', { name: /登录 APEX/ })

async function signedInWithATurn(ctx: Fixture, text: string) {
  await expect(loginScreen(ctx)).toBeVisible({ timeout: 90_000 })
  await ctx.signIn()
  await expect(loginScreen(ctx)).toBeHidden({ timeout: 60_000 })
  await expect
    .poll(ctx.desktopLog, { timeout: 30_000 })
    .toContain('restarting primary backend "default" for the refreshed relay key')
  await ctx.send(text)
  await ctx.replied(text)
}

/** desktop.log lines from `since` on that start with `prefix`. */
function logLinesSince(ctx: Fixture, since: number, needle: string): string[] {
  return ctx
    .desktopLog()
    .split('\n')
    .filter(line => Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] ?? '') >= since - 5 && line.includes(needle))
}

/** Processes of this user whose environment carries `needle` (macOS/Linux `ps -E`). */
function processesHolding(needle: string): string[] {
  const listing = execFileSync('ps', ['-Eww', '-o', 'pid=,command=', '-U', String(process.getuid?.() ?? '')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })

  return listing
    .split('\n')
    .filter(line => line.includes(needle))
    .map(line => line.trim().split(/\s+/)[0])
}

/** Every file under `root` whose bytes contain `needle`. */
function filesHolding(root: string, needle: string): string[] {
  const found: string[] = []
  const bytes = Buffer.from(needle)

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && fs.readFileSync(full).includes(bytes)) {
        found.push(path.relative(root, full))
      }
    }
  }

  walk(root)

  return found.sort()
}

test('the click answers at once; the login screen comes with the revoke and stays through the engine restart', async () => {
  test.setTimeout(300_000)

  await withAccountServer('sign-out-wait-timing', async ctx => {
    await signedInWithATurn(ctx, 'sign-out probe one')
    // A later launch has not read the capabilities yet: opening the menu does.
    await ctx.relaunch()
    await ctx.current().page.locator('[data-single-thread-account]').waitFor({ state: 'visible', timeout: 90_000 })
    await ctx.current().page.waitForTimeout(3_000)
    ctx.setDelay(ROUND_TRIP_MS)

    const { page } = ctx.current()
    await ctx.openAccountMenu()
    // Someone reading the menu before the click.
    await page.waitForTimeout(1_500)
    await page.evaluate(() => (window as any).__hc1142.arm())
    const before = ctx.accountRequests.length
    allowErrorBanners()
    await page.getByRole('menuitem', { name: '退出登录' }).click()

    // Watch until the engine the sign-out restarted is back, and a second past that.
    const clickedAt = Date.now()
    await expect
      .poll(() => logLinesSince(ctx, clickedAt, 'Hermes backend is ready').length, { timeout: 60_000 })
      .toBeGreaterThan(0)
    await page.waitForTimeout(1_000)

    const events: Array<{ at: number; name: string }> = await page.evaluate(() => (window as any).__hc1142.events)
    const t0 = events.find(event => event.name === 'pointerdown')?.at ?? clickedAt
    const first = (name: string) => (events.find(event => event.name === name)?.at ?? Number.NaN) - t0
    const during = ctx.accountRequests.slice(before)

    fs.writeFileSync(
      test.info().outputPath('timing.txt'),
      [
        `account server delay ${ROUND_TRIP_MS} ms per request`,
        ...events.map(event => `${event.at - t0} ms: ${event.name}`),
        ...during.map(item => `${item.path}: arrived ${item.arrived - t0} ms, answered ${(item.answered ?? Number.NaN) - t0} ms`),
        ...logLinesSince(ctx, t0, '[managed] signed out')
      ].join('\n') + '\n'
    )

    // At once: the menu closes and the window says it is signing out.
    expect(first('cover=true')).toBeLessThan(300)
    expect(first('menu=false')).toBeLessThan(300)
    // Fail-closed: no login screen before the server answered the revoke.
    const revoke = during.find(item => item.path.endsWith('/provision-key/revoke'))
    expect(revoke?.answered).toBeDefined()
    expect(first('login=true') + t0).toBeGreaterThanOrEqual(revoke!.answered!)
    // One round trip: the revoke is the only request the click waits for; the capabilities were read at menu open.
    expect(during.map(item => item.path)).toEqual(['/api/v1/desktop/provision-key/revoke'])
    expect(first('login=true')).toBeLessThan(ROUND_TRIP_MS + 600)
    // And it stays: the engine restart no longer takes the login screen away.
    expect(events.filter(event => event.name === 'login=false')).toEqual([])
    await expect(loginScreen(ctx)).toBeVisible()

    const lines = logLinesSince(ctx, t0, '[managed] sign')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/; took \d+ ms: fence \d+, capabilities \d+, revoke \d+, clear \d+, clean-up \d+$/)
  })
})

test('signing in again right after signing out ends on the new key', async () => {
  test.setTimeout(300_000)

  await withAccountServer('sign-out-wait-resign', async ctx => {
    await signedInWithATurn(ctx, 'sign-out probe one')
    allowErrorBanners()
    await ctx.openAccountMenu()
    await ctx.current().page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(loginScreen(ctx)).toBeVisible({ timeout: 30_000 })
    const signedOutAt = Date.now()

    // Straight away, while the sign-out's engine restart is still under way.
    expect(logLinesSince(ctx, signedOutAt, 'Hermes backend is ready')).toEqual([])
    await ctx.signIn()
    // The button reads 正在登录… while the sign-in runs: wait for the account itself.
    await ctx.current().page.locator('[data-single-thread-account]').waitFor({ state: 'visible', timeout: 90_000 })
    expect(ctx.keys.map(entry => entry.status)).toEqual(['revoked', 'active'])

    await ctx.send('sign-out probe two')
    await ctx.replied('sign-out probe two')
    expect(ctx.relayed.at(-1), `relayed ${JSON.stringify(ctx.relayed)}; rejected ${JSON.stringify(ctx.rejected)}`).toBe(1)
    // The engine runs on the new key, never on the revoked one.
    await expect.poll(() => processesHolding(ctx.keys[1].key).length, { timeout: 60_000 }).toBeGreaterThan(0)
    expect(processesHolding(ctx.keys[0].key)).toEqual([])
    fs.writeFileSync(
      test.info().outputPath('relay.txt'),
      `relayed ${JSON.stringify(ctx.relayed)}\nrejected ${JSON.stringify(ctx.rejected)}\n`
    )
  })
})

// A web handoff code parked for the login screen (hc-530) starts a sign-in the moment the screen mounts,
// while the sign-out is still stopping the engine. On main that sign-in lost its request with the process
// (ECONNRESET): the server had minted the new key, and this computer was left half signed in.
test('a sign-in started the moment the sign-out returns still ends on the new key', async () => {
  test.setTimeout(300_000)

  await withAccountServer('sign-out-wait-race', async ctx => {
    await signedInWithATurn(ctx, 'sign-out probe one')
    const { page } = ctx.current()
    await ctx.instantBrowser()

    const signedOut = await page.evaluate(async () => {
      const scope = window as any
      const outcome = await scope.hermesDesktop.managed.signOut()

      scope.__hc1142Resign = scope.hermesDesktop.managed.browserSignIn({ provider: 'apex', target: { connectionId: null, profile: null } })

      return outcome
    })

    expect(signedOut).toEqual({ ok: true })
    expect(await page.evaluate(() => (window as any).__hc1142Resign)).toMatchObject({ ok: true, hasRelayKey: true })
    expect(ctx.keys.map(entry => entry.status)).toEqual(['revoked', 'active'])
    await expect.poll(() => processesHolding(ctx.keys[1].key).length, { timeout: 60_000 }).toBeGreaterThan(0)
    expect(processesHolding(ctx.keys[0].key)).toEqual([])
  })
})

test('quitting while the sign-out restarts the engine leaves no key behind, on disk or in a process', async () => {
  test.setTimeout(300_000)

  await withAccountServer('sign-out-wait-quit-restart', async ctx => {
    await signedInWithATurn(ctx, 'sign-out probe one')
    const key = ctx.keys[0].key
    allowErrorBanners()
    await ctx.openAccountMenu()
    await ctx.current().page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(loginScreen(ctx)).toBeVisible({ timeout: 30_000 })
    // desktop.log is appended asynchronously.
    const since = Date.now() - 30_000
    await expect.poll(() => logLinesSince(ctx, since, '[managed] signed out: the server revoked').length, { timeout: 5_000 }).toBe(1)
    const signedOut = logLinesSince(ctx, since, '[managed] signed out: the server revoked')[0]
    const signedOutAt = Date.parse(signedOut.match(/^\[([^\]]+)\]/)![1])

    // The login screen is up and the engine is still on its way back: quit now.
    expect(logLinesSince(ctx, signedOutAt, 'Hermes backend is ready')).toEqual([])
    await ctx.quit()

    expect(ctx.keys[0].status).toBe('revoked')
    await expect.poll(() => processesHolding(key), { timeout: 30_000 }).toEqual([])
    expect(filesHolding(ctx.sandbox.root, key)).toEqual([])

    await ctx.relaunch()
    await expect(loginScreen(ctx)).toBeVisible({ timeout: 90_000 })
  })
})

test('quitting before the server answered clears nothing: the credential and the key stay', async () => {
  test.setTimeout(300_000)

  await withAccountServer('sign-out-wait-quit-revoke', async ctx => {
    await signedInWithATurn(ctx, 'sign-out probe one')
    const key = ctx.keys[0].key
    const stored = path.join(ctx.sandbox.userDataDir, 'apex-managed.json')
    expect(fs.existsSync(stored)).toBe(true)

    // The server never answers the revoke, and the app is quit while it waits.
    ctx.setRevokeHangs(true)
    allowErrorBanners()
    await ctx.openAccountMenu()
    await ctx.current().page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(ctx.current().page.getByText('正在退出登录…')).toBeVisible({ timeout: 5_000 })
    await expect.poll(() => ctx.accountRequests.some(item => item.path.endsWith('/revoke')), { timeout: 30_000 }).toBe(true)
    await ctx.quit()

    // Fail-closed: nothing the server did not confirm is cleared, and no engine outlives the app.
    expect(ctx.keys.map(entry => entry.status)).toEqual(['active'])
    expect(fs.existsSync(stored)).toBe(true)
    expect(filesHolding(ctx.sandbox.hermesHome, key)).toContain('config.yaml')
    await expect.poll(() => processesHolding(key), { timeout: 30_000 }).toEqual([])
  })
})
