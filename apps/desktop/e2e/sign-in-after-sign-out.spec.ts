// hc-1120: a primary spawned signed out builds its session before the sign-in, on no
// key (a resume builds the agent as soon as the history is loaded), and a session
// keeps its client. Every turn after the sign-in was a 401 until the app restarted
// (M7, 0.17.68, finding 15). A sign-in takes a while in a real browser, so these wait
// at the login screen; without the wait the build can run after the sign-in and read
// the new key from config.yaml, which hid this. Production runs single-thread, where
// the main line resumes at boot.
//
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
    replyForPrompt: prompt =>
      (prompt.match(/sign-in probe (one|two|three|four)/)?.[0] ?? 'other').replace(/ /g, '-') + '-ok'
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

const AT_THE_LOGIN_SCREEN_MS = 15_000

test('a fresh install: the first sign-in restarts the primary and the first turn goes out on the key', async () => {
  test.setTimeout(240_000)

  await withAccountServer('signin-fresh', {}, async ctx => {
    await expect(ctx.current().page.getByRole('button', { name: /登录 APEX/ })).toBeVisible({ timeout: 60_000 })
    await ctx.current().page.waitForTimeout(AT_THE_LOGIN_SCREEN_MS)
    await ctx.signIn()
    await formClosed(ctx)
    await expect
      .poll(ctx.desktopLog, { timeout: 30_000 })
      .toContain('restarting primary backend "default" for the refreshed relay key')
    await turnOnKey(ctx, 'sign-in probe one', 0)
    expect(ctx.rejected).toEqual([])
  })
})

// The first thing every new user does. The user types as soon as there is somewhere to type: Enter pressed
// while the renderer re-dials does not send, and the text has to still be there to send afterwards.
test('first open, sign in, first sentence: nothing lost, no 401, no red line', async () => {
  test.setTimeout(240_000)

  await withAccountServer('signin-first-sentence', {}, async ctx => {
    const { page } = ctx.current()
    await expect(page.getByRole('button', { name: /登录 APEX/ })).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(AT_THE_LOGIN_SCREEN_MS)

    const signedInAt = Date.now()
    const timeline: string[] = []
    let lastSeen = ''

    // What a person would see, as it changes: the login screen, and the composer's wording.
    const watching = setInterval(() => {
      void page
        .evaluate(() => {
          const login = document.body.innerText.includes('登录 APEX')

          const composer = document.querySelector<HTMLElement>('textarea, [contenteditable="true"]')

          const hint = composer?.getAttribute('placeholder') ?? composer?.getAttribute('data-placeholder') ?? ''

          return `login=${login} composer=${Boolean(composer)} hint=${hint}`
        })
        .then(seen => {
          if (seen !== lastSeen) {
            lastSeen = seen
            timeline.push(`${Date.now() - signedInAt} ms: ${seen}`)
          }
        })
        .catch(() => undefined)
    }, 50)

    await ctx.signIn()
    await turnOnKey(ctx, 'sign-in probe one', 0)
    clearInterval(watching)
    const replyAfter = Date.now() - signedInAt

    fs.writeFileSync(
      test.info().outputPath('timing.txt'),
      `sign-in to first reply: ${replyAfter} ms\n${timeline.join('\n')}\n`
    )
    expect(replyAfter, 'sign-in to the first reply').toBeLessThan(30_000)
    expect(ctx.rejected).toEqual([])
    expect(
      await page
        .getByText(RED)
        .first()
        .isVisible()
        .catch(() => false)
    ).toBe(false)
    expect(
      await page
        .getByText(/登录成功,但/)
        .first()
        .isVisible()
        .catch(() => false)
    ).toBe(false)
  })
})

// No pause at the login screen: the engine may still be busy, so its restart is put off, and the first
// sentence goes out before it.
test('sign in the moment the screen appears and send at once: the sentence still gets its reply', async () => {
  test.setTimeout(240_000)

  await withAccountServer('signin-send-at-once', {}, async ctx => {
    await expect(ctx.current().page.getByRole('button', { name: /登录 APEX/ })).toBeVisible({ timeout: 60_000 })
    await ctx.signIn()
    await turnOnKey(ctx, 'sign-in probe one', 0)

    fs.writeFileSync(
      test.info().outputPath('timing.txt'),
      `put off: ${ctx.desktopLog().includes('still holds the previous relay key')}; turned away: ${JSON.stringify(ctx.rejected)}\n`
    )
  })
})

// The narrowest case: a draft already in the box, Enter the moment the login screen goes, before the
// restart begins. The engine is busy with that turn, so its restart waits, and the sentence is answered.
test('a sentence sent before the restart begins gets its reply', async () => {
  test.setTimeout(240_000)

  await withAccountServer('signin-before-restart', {}, async ctx => {
    const { page } = ctx.current()
    await expect(page.getByRole('button', { name: /登录 APEX/ })).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(AT_THE_LOGIN_SCREEN_MS)

    const composer = page.locator('textarea, [contenteditable="true"]').first()
    await composer.focus()
    await page.keyboard.insertText('sign-in probe one')
    await ctx.signIn()

    await expect
      .poll(() => page.evaluate(() => document.body.innerText.includes('登录 APEX')), {
        intervals: [5],
        timeout: 30_000
      })
      .toBe(false)
    await composer.focus()
    await page.keyboard.press('Enter')

    await ctx.replied('sign-in probe one')
    expect(ctx.relayed.at(-1)).toBe(0)
    expect(ctx.rejected).toEqual([])
    fs.writeFileSync(
      test.info().outputPath('timing.txt'),
      `put off: ${ctx.desktopLog().includes('still holds the previous relay key')}\n`
    )
  })
})

test('sign out and back in within one run: the next turn reaches the relay on the new key', async () => {
  test.setTimeout(300_000)

  await withAccountServer('signin-same-run', {}, async ctx => {
    await firstTurnThenSignOut(ctx)
    await expect.poll(ctx.desktopLog, { timeout: 60_000 }).toContain('so it no longer holds the revoked relay key')
    await ctx.current().page.waitForTimeout(AT_THE_LOGIN_SCREEN_MS)
    await ctx.signIn()
    await formClosed(ctx)
    await turnOnKey(ctx, 'sign-in probe two', 1)
    expect(ctx.rejected).toEqual([])
  })
})

test('reopen signed out, then sign in: the next turn reaches the relay on the new key', async () => {
  test.setTimeout(300_000)

  await withAccountServer('signin-reopen', {}, async ctx => {
    await firstTurnThenSignOut(ctx)
    await ctx.relaunch()
    await ctx.current().page.waitForTimeout(AT_THE_LOGIN_SCREEN_MS)
    await ctx.signIn()
    await formClosed(ctx)
    await turnOnKey(ctx, 'sign-in probe two', 1)
    expect(ctx.rejected).toEqual([])
  })
})

// M7's exact state: a sign-out on an older version left the key in config.yaml.
test('reopen after an older version signed out and left its key behind, then sign in', async () => {
  test.setTimeout(300_000)

  await withAccountServer('signin-reopen-leftover', {}, async ctx => {
    await ctx.signIn()
    await formClosed(ctx)
    await turnOnKey(ctx, 'sign-in probe one', 0)
    await ctx.relaunch(() => fs.rmSync(path.join(ctx.sandbox.userDataDir, 'apex-managed.json')))
    await ctx.current().page.waitForTimeout(AT_THE_LOGIN_SCREEN_MS)
    await ctx.signIn()
    await formClosed(ctx)
    await turnOnKey(ctx, 'sign-in probe two', 1)
    expect(ctx.rejected).toEqual([])
  })
})

// Several assistants: the primary serves the one pinned last time, APEX itself goes through the pool.
test('several assistants, the primary on one of them: reopen signed out, then sign in', async () => {
  test.setTimeout(420_000)

  await withAccountServer('signin-multi-bot', { APEXNODES_MULTI_BOT: '1' }, async ctx => {
    await ctx.signIn()
    await formClosed(ctx)
    await turnOnKey(ctx, 'sign-in probe one', 0)

    const created = ctx.current().page
    await created.getByRole('button', { name: '新建一个助手' }).click()
    await created.getByPlaceholder('比如：小红书文案').fill('剪辑助手')
    await created.getByRole('button', { name: '建好了' }).click()
    await expect(created.getByText('剪辑助手').first()).toBeVisible({ timeout: 60_000 })

    // Its first open asks three questions; a message before they are done is an answer, not a turn.
    await created.getByText('剪辑助手').first().click()
    await created.getByRole('button', { name: /文案/ }).first().click()
    await created.getByRole('button', { name: /简短直接/ }).click()
    await created.getByRole('button', { name: /抖音/ }).first().click()
    await expect(created.getByText(/分工定了/).first()).toBeVisible({ timeout: 30_000 })
    await turnOnKey(ctx, 'sign-in probe three', 0)

    await ctx.signOut()
    await expect(created.getByRole('button', { name: /登录 APEX/ })).toBeVisible({ timeout: 30_000 })

    const profiles = path.join(ctx.sandbox.hermesHome, 'profiles')
    const [assistant] = fs.readdirSync(profiles).filter(name => !name.startsWith('.'))

    // The pin a user gets by working in that assistant last (M7 pinned it the same way).
    await ctx.relaunch(() =>
      fs.writeFileSync(
        path.join(ctx.sandbox.userDataDir, 'active-profile.json'),
        JSON.stringify({ profile: assistant })
      )
    )
    await ctx.current().page.waitForTimeout(AT_THE_LOGIN_SCREEN_MS)
    await ctx.signIn()
    await formClosed(ctx)
    await expect
      .poll(ctx.desktopLog, { timeout: 30_000 })
      .toContain(`restarting primary backend "${assistant}" for the refreshed relay key`)

    const { page } = ctx.current()
    await page.getByText('剪辑助手').first().click()
    await turnOnKey(ctx, 'sign-in probe two', 1)
    await page.getByText('APEX', { exact: true }).last().click()
    // Text typed before its conversation is back is cleared when it arrives.
    await expect(page.getByText('sign-in-probe-one-ok').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    await turnOnKey(ctx, 'sign-in probe four', 1)
    expect(ctx.rejected).toEqual([])
  })
})
