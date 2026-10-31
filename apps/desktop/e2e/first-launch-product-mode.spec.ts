// hc-1127: a brand-new install opened on the old workspace and only reached product mode
// after quitting and reopening. The window and the engine both start before the platform
// config has ever been fetched, so everything that reads it at launch reads "nothing".
// These run a truly fresh home through the real sign-in path against a fake platform.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, DESKTOP_ROOT, findElectron } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RECORDER = path.join(import.meta.dirname, 'first-launch-recorder.cjs')

/** The active row in production when this was written, minus nothing: all five switches and the product defaults. */
const PLATFORM_ON = {
  config_yaml: { timezone: '', 'agent.image_input_mode': 'auto', 'display.show_reasoning': true },
  desktop_features: {
    multi_bot: true,
    hypihub_apex: true,
    multi_bot_max: 4,
    single_thread: true,
    multi_bot_max_v2: 5
  }
}

const PLATFORM_OFF = {
  config_yaml: PLATFORM_ON.config_yaml,
  desktop_features: {
    ...PLATFORM_ON.desktop_features,
    multi_bot: false,
    hypihub_apex: false,
    single_thread: false
  }
}

interface ConfigBehaviour {
  /** ms before the config answers. */
  delayMs?: number
  payload?: unknown
  status?: number
  version?: number
}

function listen(server: http.Server): Promise<string> {
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  )
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

interface Frame {
  at: number
  login: boolean
  old: string[]
  product: boolean
  visibility: string
}

interface Harness {
  app: () => ElectronApplication
  /** Every model request's body, as the relay saw it. */
  chatBodies: string[]
  /** Every request for the client config, in order. */
  configHits: Array<{ at: number; known: null | string }>
  desktopLog: () => string
  /** The engine's environment, read from the process itself. */
  engineEnv: (name: string) => string
  frames: () => Promise<Frame[]>
  marks: () => Promise<Array<{ at: number; name: string }>>
  page: () => Page
  /** Quit and start again on the same home and user data. */
  relaunch: () => Promise<void>
  /** Change how the fake platform answers from now on. */
  setConfig: (next: ConfigBehaviour) => void
  shot: (name: string) => Promise<void>
  signIn: () => Promise<void>
}

async function withFreshInstall(
  name: string,
  options: { apiBase?: string; config: ConfigBehaviour; env?: Record<string, string>; seedCache?: unknown },
  body: (ctx: Harness) => Promise<void>
) {
  allowErrorBanners()

  const sandbox = createSandbox(name)
  const mock = await startMockServer({ replyForPrompt: () => 'first-sentence-ok' })
  const keys: string[] = []
  const chatBodies: string[] = []
  const configHits: Harness['configHits'] = []
  let config = options.config
  const token = `local.${Buffer.from(JSON.stringify({ sub: USER })).toString('base64url')}.firstlaunch`

  const relay = http.createServer(async (request, response) => {
    const raw = await readBody(request)

    if (String(request.url || '').endsWith('/chat/completions')) {
      chatBodies.push(raw.toString('utf8'))
    }

    const upstream = http.request(
      `${mock.url}${request.url}`,
      { method: request.method, headers: request.headers },
      reply => {
        response.writeHead(reply.statusCode || 502, reply.headers)
        reply.pipe(response)
      }
    )

    upstream.end(raw)
  })

  const relayUrl = await listen(relay)

  const platform = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost')

    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (url.pathname === '/api/v1/desktop/client-config') {
      configHits.push({ at: Date.now(), known: url.searchParams.get('known_version') })
      const { delayMs = 0, payload = PLATFORM_ON, status = 200, version = 7 } = config

      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }

      if (status !== 200) {
        json(status, { detail: 'fixture' })
      } else if (Number(url.searchParams.get('known_version') || 0) >= version) {
        json(200, { version: Number(url.searchParams.get('known_version')), unchanged: true })
      } else {
        json(200, { version, payload, updated_at: '2026-10-29T06:41:58+00:00' })
      }
    } else if (url.pathname === '/api/v1/desktop/provision-key/capabilities') {
      json(200, { version: 1 })
    } else if (url.pathname === '/api/v1/desktop/provision-key') {
      const payload = JSON.parse((await readBody(request)).toString('utf8') || '{}')
      keys.push(`sk-apex-firstlaunch-${keys.length + 1}-${Date.now()}`)
      json(200, {
        provision_revision: payload.provision_revision,
        api_key: keys.at(-1),
        base_url: `${relayUrl}/v1`,
        model: 'mock-model',
        email: 'firstlaunch@example.invalid',
        name: 'First launch fixture'
      })
    } else if (url.pathname === '/api/v1/desktop/provision-key/revoke') {
      json(200, { revoked: true })
    } else {
      json(404, { detail: 'fixture route unavailable' })
    }
  })

  const platformBase = await listen(platform)

  if (options.seedCache) {
    fs.mkdirSync(sandbox.userDataDir, { recursive: true })
    fs.writeFileSync(path.join(sandbox.userDataDir, 'apex-client-config.json'), JSON.stringify(options.seedCache))
  }

  const framesDir = process.env.E2E_FIRST_LAUNCH_SAVE ? path.join(process.env.E2E_FIRST_LAUNCH_SAVE, name) : ''

  const launch = async () => {
    const launched = await _electron.launch({
      executablePath: findElectron(),
      args: ['-r', RECORDER, DESKTOP_ROOT, '--disable-gpu', '--no-sandbox'],
      cwd: DESKTOP_ROOT,
      env: buildAppEnv(sandbox, {
        APEXNODES_API_BASE: options.apiBase ?? platformBase,
        APEXNODES_AUTH_BASE: platformBase,
        HERMES_DESKTOP_PYTHON: process.env.HERMES_DESKTOP_PYTHON || '',
        ...(framesDir ? { E2E_FIRST_LAUNCH_FRAMES: path.join(framesDir, 'frames') } : {}),
        ...options.env
      })
    })

    const firstPage = await launched.firstWindow()

    await launched.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { hc1127Opened: opened })

      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })

    return { app: launched, page: firstPage }
  }

  let running = await launch()
  const logPath = path.join(sandbox.hermesHome, 'logs', 'desktop.log')

  const engineEnv = (variable: string) => {
    const root = running.app.process().pid
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    const parents = new Map<number, number>()
    const commands = new Map<number, string>()

    for (const row of rows) {
      const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)

      if (match) {
        parents.set(Number(match[1]), Number(match[2]))
        commands.set(Number(match[1]), match[3])
      }
    }

    const under = (pid: number) => {
      for (let at = pid; at > 1; at = parents.get(at) ?? 0) {
        if (at === root) {
          return true
        }
      }

      return false
    }

    const engine = [...commands.entries()].find(([pid, command]) => under(pid) && command.includes(' serve --host 127.0.0.1 '))

    if (!engine) {
      return '(no engine)'
    }

    const environment = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(engine[0])], { encoding: 'utf8' })

    return environment.match(new RegExp(`(?:^|\\s)${variable}=(\\S*)`))?.[1] ?? '(unset)'
  }

  try {
    await body({
      app: () => running.app,
      chatBodies,
      configHits,
      desktopLog: () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''),
      engineEnv,
      frames: () => running.page.evaluate(() => (window as unknown as { hc1127Frames: () => Frame[] }).hc1127Frames()),
      marks: () =>
        running.app.evaluate(() => (globalThis as unknown as { hc1127Marks: Array<{ at: number; name: string }> }).hc1127Marks),
      page: () => running.page,
      relaunch: async () => {
        await running.app.close()
        running = await launch()
      },
      setConfig: next => {
        config = next
      },
      shot: async label => {
        if (framesDir) {
          fs.mkdirSync(framesDir, { recursive: true })
          await running.page.screenshot({ path: path.join(framesDir, `${label}.png`) })
        }
      },
      signIn: async () => {
        const { app, page } = running
        await page.getByRole('button', { name: /登录 APEX/ }).click({ timeout: 60_000 })
        let opened = ''

        await expect
          .poll(
            async () => {
              opened = await app.evaluate(
                () => (globalThis as unknown as { hc1127Opened: string[] }).hc1127Opened.shift() ?? ''
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
    })
  } finally {
    await running.app.close().catch(() => undefined)

    for (const log of ['desktop.log', 'agent.log', 'errors.log']) {
      const file = path.join(sandbox.hermesHome, 'logs', log)

      if (fs.existsSync(file)) {
        fs.copyFileSync(file, test.info().outputPath(log))
      }
    }

    await new Promise<void>(resolve => relay.close(() => resolve()))
    await new Promise<void>(resolve => platform.close(() => resolve()))
    await mock.close()
    sandbox.cleanup()
  }
}

const OLD_SHELL = ['今天想推进什么业务', '沉浸式分析']

/** The cap, plus what the rest of the ready handler takes on a loaded machine. */
const HOLD_LIMIT_MS = 3_500

/** What the public endpoint took from this Mac (curl, five runs, 0.84–0.87 s). A local fake answers before the first window reads the cache, which hides the bug. */
const REAL_RTT_MS = 850

const LOGIN = /登录 APEX/

async function reachComposer(page: Page) {
  const composer = page.locator('[data-slot="composer-rich-input"]').first()
  await composer.waitFor({ state: 'visible', timeout: 90_000 })

  return composer
}

async function sayFirstSentence(page: Page) {
  const composer = await reachComposer(page)
  const line = '帮我想一条短视频选题'

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await composer.click()
    await page.keyboard.insertText(line)
    await page.keyboard.press('Enter')

    const sent = await expect
      .poll(async () => ((await composer.textContent()) ?? '').trim(), { timeout: 5_000 })
      .toBe('')
      .then(
        () => true,
        () => false
      )

    if (sent) {
      return
    }
  }

  throw new Error('the composer never sent the first sentence')
}

/** Past the sign-in restart: the login screen is gone and the shell has settled. */
async function signedInAndSettled(ctx: Harness) {
  await ctx.signIn()
  await ctx.page().getByRole('button', { name: LOGIN }).waitFor({ state: 'hidden', timeout: 60_000 })
  await expect.poll(() => ctx.engineEnv('HERMES_HOME'), { timeout: 30_000 }).not.toBe('(no engine)')
  await ctx.page().waitForTimeout(3_000)
}

async function expectProductShell(ctx: Harness) {
  await reachComposer(ctx.page())
  expect(await ctx.page().getByText(OLD_SHELL[0]).count()).toBe(0)
  expect(await ctx.page().getByText(OLD_SHELL[1]).count()).toBe(0)
}

async function expectOldShell(ctx: Harness) {
  await expect(ctx.page().getByText(OLD_SHELL[0]).first()).toBeVisible({ timeout: 30_000 })
}

/** What the page and the app said, kept next to the test's result. */
async function note(ctx: Harness) {
  test.info().annotations.push(
    { type: 'frames', description: JSON.stringify(await ctx.frames()) },
    { type: 'marks', description: JSON.stringify(await ctx.marks()) },
    { type: 'config-hits', description: JSON.stringify(ctx.configHits) }
  )
}

function oldShellFrames(frames: Frame[]) {
  return frames.filter(frame => frame.old.length > 0)
}

async function holdMs(ctx: Harness) {
  const marks = await ctx.marks()
  const at = (name: string) => marks.find(mark => mark.name === name)?.at ?? NaN

  return at('window-created') - at('app-ready')
}

async function expectFlippedToProductShell(ctx: Harness) {
  await expect(ctx.page().locator('[data-slot="composer-rich-input"]').first()).toBeVisible({ timeout: 45_000 })
  await expect(ctx.page().getByText(OLD_SHELL[0])).toHaveCount(0, { timeout: 15_000 })
}

/** For comparing the off path against clean main: ids, times and ports are not the product. */
async function saveNormalizedDom(ctx: Harness, label: string) {
  const target = process.env.E2E_FIRST_LAUNCH_SAVE

  if (!target) {
    return
  }

  const html = await ctx.page().evaluate(() => document.body.outerHTML)

  const normalized = html
    .replace(/«r[^»]*»|:r[0-9a-z]+:|radix-[^"\s]+|DndDescribedBy-\d+|DndLiveRegion-\d+/g, 'ID')
    .replace(/127\.0\.0\.1:\d+/g, 'HOST')
    .replace(/></g, '>\n<')

  fs.writeFileSync(path.join(target, `${test.info().title.slice(0, 12).replace(/\W+/g, '-')}-${label}.html`), normalized)
}

test.describe('first launch of a new install (hc-1127)', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 })

  test('platform on: product mode before and after signing in, never the old shell, engine told', async () => {
    await withFreshInstall('hc1127-on', { config: { delayMs: REAL_RTT_MS } }, async ctx => {
      await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
      await ctx.shot('1-before-sign-in')

      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')
      expect(ctx.engineEnv('APEX_MULTI_BOT_ACTIVE')).toBe('1')
      expect(ctx.engineEnv('APEX_HYPIHUB_ACTIVE')).toBe('1')
      expect(await ctx.page().evaluate(() => localStorage.getItem('apex.desktop.feature.single-thread'))).toBe('true')

      await signedInAndSettled(ctx)
      await ctx.shot('2-after-sign-in')
      await expectProductShell(ctx)
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')

      await sayFirstSentence(ctx.page())
      await ctx
        .page()
        .waitForFunction(() => (document.body?.textContent ?? '').includes('first-sentence-ok'), undefined, {
          timeout: 60_000
        })
      await ctx.shot('3-first-reply')
      await note(ctx)

      expect(ctx.chatBodies.some(body => body.includes('APEX 怎么说话'))).toBe(true)

      const frames = await ctx.frames()
      expect(oldShellFrames(frames)).toEqual([])
      expect(frames.some(frame => frame.product)).toBe(true)

      // One request settled the launch: the boot check did not ask again.
      expect(ctx.configHits.filter(hit => hit.known === null)).toHaveLength(1)
    })
  })

  test('platform off: the old shell on the first launch, the engine left alone, nothing flips', async () => {
    await withFreshInstall('hc1127-off', { config: { delayMs: REAL_RTT_MS, payload: PLATFORM_OFF, version: 8 } }, async ctx => {
      await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
      await ctx.shot('1-before-sign-in')
      await saveNormalizedDom(ctx, 'login')

      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('(unset)')
      expect(ctx.engineEnv('APEX_MULTI_BOT_ACTIVE')).toBe('(unset)')
      expect(await ctx.page().evaluate(() => localStorage.getItem('apex.desktop.feature.single-thread'))).toBe('false')

      await signedInAndSettled(ctx)
      await expectOldShell(ctx)
      await ctx.shot('2-after-sign-in')
      await saveNormalizedDom(ctx, 'signed-in')
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('(unset)')
      await note(ctx)
      expect((await ctx.frames()).filter(frame => frame.product)).toEqual([])
    })
  })

  test('install switch 0 beats a platform on', async () => {
    await withFreshInstall(
      'hc1127-install-0',
      { config: { delayMs: REAL_RTT_MS }, env: { APEXNODES_SINGLE_THREAD: '0' } },
      async ctx => {
        await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
        expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('(unset)')
        expect(ctx.engineEnv('APEX_MULTI_BOT_ACTIVE')).toBe('(unset)')
        await signedInAndSettled(ctx)
        await expectOldShell(ctx)
      }
    )
  })

  test('install switch 1 beats a platform off', async () => {
    await withFreshInstall(
      'hc1127-install-1',
      { config: { delayMs: REAL_RTT_MS, payload: PLATFORM_OFF, version: 8 }, env: { APEXNODES_SINGLE_THREAD: '1' } },
      async ctx => {
        await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
        expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')
        await signedInAndSettled(ctx)
        await expectProductShell(ctx)
        expect(oldShellFrames(await ctx.frames())).toEqual([])
      }
    )
  })

  test('the config request fails at launch: the window opens at once, and sign-in still gets product mode', async () => {
    await withFreshInstall('hc1127-failed', { config: { status: 404 } }, async ctx => {
      await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
      await ctx.shot('1-before-sign-in')
      expect(await holdMs(ctx)).toBeLessThan(HOLD_LIMIT_MS)
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('(unset)')

      // The account answers and the config does too: the connection is back by now.
      ctx.setConfig({ delayMs: REAL_RTT_MS })
      await signedInAndSettled(ctx)
      await ctx.shot('2-after-sign-in')
      await expectProductShell(ctx)
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')
      await note(ctx)
      expect(oldShellFrames(await ctx.frames())).toEqual([])
    })
  })

  test('offline at launch: nothing listens, the window opens, the login screen is up', async () => {
    await withFreshInstall('hc1127-offline', { apiBase: 'http://127.0.0.1:9', config: {} }, async ctx => {
      await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
      await ctx.shot('1-before-sign-in')
      await note(ctx)
      expect(await holdMs(ctx)).toBeLessThan(HOLD_LIMIT_MS)
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('(unset)')
    })
  })

  test('a connection that never answers: the window opens at the cap, and nothing old shows', async () => {
    await withFreshInstall('hc1127-silent', { config: { delayMs: 600_000 } }, async ctx => {
      await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
      await ctx.shot('1-before-sign-in')
      const held = await holdMs(ctx)

      test.info().annotations.push({ type: 'hold-ms', description: String(held) })
      expect(held).toBeGreaterThan(2_400)
      expect(held).toBeLessThan(HOLD_LIMIT_MS)
      await note(ctx)
      expect(oldShellFrames(await ctx.frames())).toEqual([])
    })
  })

  test('a config later than the cap but before sign-in: flips under the login screen, and the engine gets it at sign-in', async () => {
    await withFreshInstall('hc1127-late', { config: { delayMs: 3_500 } }, async ctx => {
      await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
      await ctx.shot('1-before-sign-in')

      await expect
        .poll(() => ctx.page().evaluate(() => localStorage.getItem('apex.desktop.feature.single-thread')), {
          timeout: 15_000
        })
        .toBe('true')
      // The engine was already up: it hears at the sign-in restart.
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('(unset)')

      await signedInAndSettled(ctx)
      await ctx.shot('2-after-sign-in')
      await expectProductShell(ctx)
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')
      await note(ctx)
      expect(oldShellFrames(await ctx.frames())).toEqual([])
    })
  })

  test('a config later than sign-in: the shell follows it when it lands, the engine from the next launch', async () => {
    await withFreshInstall('hc1127-after-sign-in', { config: { delayMs: 600_000 } }, async ctx => {
      await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })

      // The launch's request gives up first; sign-in asks again, and that answer outlasts its wait.
      await expect.poll(() => ctx.desktopLog(), { timeout: 30_000 }).toContain('[client-config] fetch unavailable')
      ctx.setConfig({ delayMs: 4_000 })

      await ctx.signIn()
      await ctx.page().getByRole('button', { name: LOGIN }).waitFor({ state: 'hidden', timeout: 60_000 })
      await ctx.shot('1-signed-in')

      await expectFlippedToProductShell(ctx)
      await ctx.shot('2-after-config-landed')
      await note(ctx)

      await ctx.relaunch()
      await reachComposer(ctx.page())
      expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')
    })
  })

  test('a cached install is left alone: no hold, and a newer config counts from the next launch', async () => {
    await withFreshInstall(
      'hc1127-cached',
      { config: { payload: PLATFORM_OFF, version: 8 }, seedCache: { appliedVersion: 7, fetchedAt: 1, payload: PLATFORM_ON, version: 7 } },
      async ctx => {
        await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
        const held = await holdMs(ctx)

        test.info().annotations.push({ type: 'hold-ms', description: String(held) })
        expect(held).toBeLessThan(600)
        expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')
        await expect.poll(() => ctx.configHits.map(hit => hit.known)).toEqual(['7'])
        await expect
          .poll(() => ctx.desktopLog(), { timeout: 15_000 })
          .toContain('[client-config] stored platform config v8 (boot)')

        // This launch still runs on v7. The next one runs on v8, and the engine with it.
        expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('1')
        await ctx.relaunch()
        await expect(ctx.page().getByRole('button', { name: LOGIN })).toBeVisible({ timeout: 90_000 })
        expect(ctx.engineEnv('APEX_SINGLE_THREAD_ACTIVE')).toBe('(unset)')
      }
    )
  })
})
