// hc-1166: several assistants on ONE engine. Every assistant stays a Hermes
// profile, but the primary engine serves them all, so a switch never starts a
// process. On one shared socket a call goes where its route says, so the guard
// here is the user's own view of it: what I type on an assistant reaches the
// model as THAT assistant (its SOUL, with APEX's own prompt sections loaded for
// its profile) and is stored in THAT assistant's conversation (its profile's
// state.db), and no second engine ever runs.
//
// Test one, round two switches back to APEX right after an assistant whose
// thread was created in round one. Before the fix APEX's thread lookup was
// routed as the assistant being left, the shell followed the wrong tip back
// there, and the first line typed on APEX went into the other assistant's
// conversation, with that assistant's identity.
//
// Test two runs two long turns at once (the mock holds both streams open) on
// two assistants and talks to a third meanwhile: the third answers, the two
// keep working in the background, their rows say so, and both finish once
// released.
//
// Test three: an assistant other than APEX searches the web with the search
// Desktop set up for the account (SEARXNG_URL / SEARXNG_API_KEY in the
// engine's spawn env). A profile the engine hosts never reads the process
// environment for a credential, so without apex_overlay/hosted_profiles.py the
// search fails with "SEARXNG_URL is not set" and the fake SearXNG hears nothing.
//
// Real dev Electron + one real engine (`hermes serve` from this checkout) + the
// mock LLM behind a logging proxy that reads each call's system prompt.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type Sandbox,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { allowErrorBanners, expect, type Page, test } from './test'

type Launched = Awaited<ReturnType<typeof launchDesktop>>

const COMPOSER = '[data-slot="composer-rich-input"]'
/** A line of APEX's own prompt sections (apex_overlay/desktop_version.py): the overlay is loaded for that profile. */
const OVERLAY_LINE = 'You are part of APEX'
/** The mock holds a stream that asks for this open until the test releases it (tests-js/scripts/mock-server.ts). */
const HOLD = 'HC891_PROVIDER_HOLD'

type Assistants = ReadonlyArray<readonly [string, string]>

interface Call {
  identity: string
  overlay: boolean
}

function seedAssistant(home: string, profile: string, name: string, created: number): void {
  const dir = path.join(home, 'profiles', profile)

  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(home, 'config.yaml'), path.join(dir, 'config.yaml'))
  fs.copyFileSync(path.join(home, '.env'), path.join(dir, '.env'))
  fs.writeFileSync(path.join(dir, 'SOUL.md'), `你叫${name}。\n\n你是一个帮忙的助手。\n`, 'utf8')
  fs.writeFileSync(
    path.join(dir, 'profile.yaml'),
    `ui_meta:\n  apex:\n    name: ${name}\n    created: ${created}\n    origin: product\n    color: blue\n    shape: rounded\n`,
    'utf8'
  )
}

/** Every `hermes … serve` process below this Electron, with the profile it was started as. */
function engines(electronPid: number): string[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(([, pid, ppid, command]) => ({ command, pid: Number(pid), ppid: Number(ppid) }))

  const below = new Set([electronPid])

  for (let grew = true; grew;) {
    grew = false

    for (const row of rows) {
      if (below.has(row.ppid) && !below.has(row.pid)) {
        below.add(row.pid)
        grew = true
      }
    }
  }

  return rows
    .filter(row => below.has(row.pid) && / serve --host 127\.0\.0\.1 /.test(row.command))
    .map(row => row.command.match(/--profile (\S+)/)?.[1] ?? '(none)')
}

/** One engine, started as APEX (the primary), whatever the assistants are doing. */
function expectOneEngine(launched: Launched, assistants: Assistants, when: string): void {
  const running = engines(launched.app.process().pid!)

  expect(running, `engines ${when}`).toHaveLength(1)
  expect(
    assistants.map(([id]) => id),
    `engines ${when}`
  ).not.toContain(running[0])
}

/** The user lines one profile's own state.db holds. */
function storedLines(home: string, profile: string): string[] {
  const file = profile === 'default' ? path.join(home, 'state.db') : path.join(home, 'profiles', profile, 'state.db')
  const db = new DatabaseSync(file, { readOnly: true })

  try {
    return (
      db.prepare("SELECT content FROM messages WHERE role = 'user' ORDER BY id").all() as Array<{ content: string }>
    )
      .map(row => row.content.match(/【[^】]+】/g)?.at(-1) ?? '')
      .filter(Boolean)
  } finally {
    db.close()
  }
}

/** A proxy in front of the mock LLM that records, per marker, the identity and overlay line its call carried. */
async function startIdentityProxy(
  mockUrl: string
): Promise<{ calls: Map<string, Call>; close: () => void; url: string }> {
  const calls = new Map<string, Call>()
  const target = new URL(mockUrl)

  const proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = []

    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)

      if (req.url?.includes('/chat/completions')) {
        try {
          const messages: Array<{ content?: unknown; role?: string }> = JSON.parse(body.toString('utf8')).messages ?? []

          const text = (m?: { content?: unknown }) =>
            typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')

          const system = messages
            .filter(m => m.role === 'system')
            .map(text)
            .join('\n')

          const marker = text([...messages].reverse().find(m => m.role === 'user'))
            .match(/【[^】]+】/g)
            ?.at(-1)

          if (marker && !calls.has(marker)) {
            calls.set(marker, {
              identity: system.match(/你叫\s*[^，。,\n]{1,12}|You are [A-Za-z]+/)?.[0] ?? '(none)',
              overlay: system.includes(OVERLAY_LINE)
            })
          }
        } catch {
          // Not JSON: nothing to record.
        }
      }

      const upstream = http.request(
        { headers: req.headers, host: target.hostname, method: req.method, path: req.url, port: target.port },
        reply => {
          res.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(res)
        }
      )

      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      upstream.end(body)
    })
  })

  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()))

  return {
    calls,
    close: () => proxy.close(),
    url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  }
}

/** A sandbox with these assistants, launched with several assistants on one engine, past the sign-in gate. */
async function launchOneEngine(
  prefix: string,
  llmUrl: string,
  assistants: Assistants,
  extraEnv: Record<string, string> = {}
): Promise<Launched & { sandbox: Sandbox }> {
  const sandbox = createSandbox(prefix)

  writeMockProviderConfig(sandbox.hermesHome, llmUrl)
  writeEnvFile(sandbox.hermesHome)
  assistants.forEach(([profile, name], index) =>
    seedAssistant(sandbox.hermesHome, profile, name, 1_700_000_000_000 + index)
  )

  const launched = await launchDesktop(
    buildAppEnv(sandbox, {
      APEXNODES_MULTI_BOT: '1',
      APEXNODES_MULTI_BOT_SINGLE_ENGINE: '1',
      APEXNODES_SINGLE_THREAD: '1',
      ...extraEnv
    })
  )

  const ownKey = launched.page.getByRole('button', { name: '使用自己的密钥' })

  if (
    await ownKey.waitFor({ state: 'visible', timeout: 20_000 }).then(
      () => true,
      () => false
    )
  ) {
    await ownKey.click()
  }

  await expect(launched.page.locator(`[data-single-thread-bot="${assistants.at(-1)![0]}"]`)).toBeVisible({
    timeout: 180_000
  })

  return { ...launched, sandbox }
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER).first()

  await expect(async () => {
    const ownKey = page.getByRole('button', { name: '使用自己的密钥' })

    if (await ownKey.isVisible().catch(() => false)) {
      await ownKey.click()
    }

    await composer.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await composer.type(text, { delay: 1 })
    await page.keyboard.press('Enter')
    await expect(composer).not.toContainText(text, { timeout: 1_000 })
  }).toPass({ timeout: 60_000 })
}

/** The call for `marker` reached the model as `name` (APEX when null), with APEX's prompt sections loaded. */
function expectCallAs(calls: Map<string, Call>, marker: string, name: null | string): void {
  const call = calls.get(marker) ?? { identity: '(no call)', overlay: false }

  if (name) {
    expect(call.identity, `${marker} reached the model as`).toBe(`你叫${name}`)
  } else {
    expect(call.identity, `${marker} reached the model as`).toMatch(/APEX/)
  }

  expect(call.overlay, `${marker} carried APEX's prompt sections`).toBe(true)
}

test.setTimeout(300_000)

test('one engine serves every assistant, and each line reaches the model as the assistant it was typed to', async () => {
  allowErrorBanners()

  const assistants: Assistants = [
    ['apex-bot-2', '剪辑助手'],
    ['apex-bot-3', '运营助手']
  ]

  const mock = await startMockServer({
    replyForPrompt: prompt => `回声${(prompt.match(/【[^】]+】/g) ?? ['【无】']).at(-1)}`
  })

  const proxy = await startIdentityProxy(mock.url)
  const launched = await launchOneEngine('one-engine', proxy.url, assistants)
  const { page, sandbox } = launched

  try {
    const expected: Record<string, string[]> = { default: [] }
    const order = ['default', ...assistants.map(([profile]) => profile)]

    for (const round of [1, 2]) {
      for (const profile of order) {
        await page.locator(`[data-single-thread-bot="${profile}"]`).click()
        await page.waitForTimeout(800)

        const marker = `【${profile}-${round}】`

        await send(page, `你是谁${marker}`)
        await expect(page.getByText(`回声${marker}`).first()).toBeVisible({ timeout: 60_000 })
        ;(expected[profile] ??= []).push(marker)

        expectCallAs(proxy.calls, marker, assistants.find(([id]) => id === profile)?.[1] ?? null)
        expectOneEngine(launched, assistants, `after ${marker}`)
      }
    }

    for (const profile of order) {
      expect(storedLines(sandbox.hermesHome, profile), `${profile}'s own conversation`).toEqual(expected[profile])
    }
  } finally {
    await launched.app.close().catch(() => undefined)
    await mock.close()
    proxy.close()
  }
})

test('two assistants run long turns at once on the one engine while a third answers', async () => {
  allowErrorBanners()

  const assistants: Assistants = [
    ['apex-bot-2', '剪辑助手'],
    ['apex-bot-3', '运营助手'],
    ['apex-bot-4', '文案助手']
  ]

  const mock = await startMockServer({
    replyForPrompt: prompt => `回声${(prompt.match(/【[^】]+】/g) ?? ['【无】']).at(-1)}`
  })

  const proxy = await startIdentityProxy(mock.url)
  const launched = await launchOneEngine('one-engine-busy', proxy.url, assistants)
  const { page, sandbox } = launched
  const row = (profile: string) => page.locator(`[data-single-thread-bot="${profile}"]`)
  let released = false

  try {
    // Two long turns, each held open by the mock once it has started.
    for (const [profile, name] of assistants.slice(0, 2)) {
      await row(profile).click()
      await page.waitForTimeout(800)

      const marker = `【long-${profile}】`

      await send(page, `${HOLD} 做一个长任务${marker}`)
      await expect.poll(() => proxy.calls.has(marker), { timeout: 60_000 }).toBe(true)
      expectCallAs(proxy.calls, marker, name)
    }

    // The first one keeps working in the background, and its row says so.
    await expect(row('apex-bot-2')).toHaveAttribute('data-state', 'working', { timeout: 30_000 })

    // A third assistant still answers right away while both are working.
    await row('apex-bot-4').click()
    await page.waitForTimeout(800)

    const sentAt = Date.now()

    await send(page, '你好【free-apex-bot-4】')
    await expect(page.getByText('回声【free-apex-bot-4】').first()).toBeVisible({ timeout: 30_000 })
    const answeredIn = Date.now() - sentAt

    console.log(`[hc-1166] a third assistant answered in ${answeredIn} ms while two long turns ran`)
    expect(answeredIn, 'a free assistant waited on the busy ones').toBeLessThan(20_000)
    expectCallAs(proxy.calls, '【free-apex-bot-4】', '文案助手')

    for (const [profile] of assistants.slice(0, 2)) {
      await expect(row(profile), `${profile} is still working in the background`).toHaveAttribute(
        'data-state',
        'working'
      )
    }

    expectOneEngine(launched, assistants, 'with two long turns running')

    // Release both; each finishes in its own conversation.
    mock.releaseHeldStream()
    released = true

    for (const [profile] of assistants.slice(0, 2)) {
      await expect(row(profile), `${profile} settles`).not.toHaveAttribute('data-state', 'working', {
        timeout: 60_000
      })
      await row(profile).click()
      await expect(page.getByText(`回声【long-${profile}】`).first()).toBeVisible({ timeout: 60_000 })
    }

    expect(storedLines(sandbox.hermesHome, 'apex-bot-2')).toEqual(['【long-apex-bot-2】'])
    expect(storedLines(sandbox.hermesHome, 'apex-bot-3')).toEqual(['【long-apex-bot-3】'])
    expect(storedLines(sandbox.hermesHome, 'apex-bot-4')).toEqual(['【free-apex-bot-4】'])
    expectOneEngine(launched, assistants, 'after both long turns')
  } finally {
    if (!released) {
      mock.releaseHeldStream()
    }

    await launched.app.close().catch(() => undefined)
    await mock.close()
    proxy.close()
  }
})

test('an assistant other than APEX searches the web with the search Desktop set up for the account', async () => {
  allowErrorBanners()

  const searches: Array<{ key: string; query: string }> = []

  const searxng = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/search') {
      searches.push({ key: String(req.headers['x-api-key'] ?? ''), query: url.searchParams.get('q') ?? '' })
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        results: [
          {
            content: 'found with the account search',
            score: 1,
            title: 'hc1166 search hit',
            url: 'https://example.invalid/hit'
          }
        ]
      })
    )
  })

  await new Promise<void>(resolve => searxng.listen(0, '127.0.0.1', () => resolve()))

  const assistants: Assistants = [['apex-bot-2', '剪辑助手']]

  const mock = await startMockServer({
    replyForPrompt: prompt => `回声${(prompt.match(/【[^】]+】/g) ?? ['【无】']).at(-1)}`
  })

  const proxy = await startIdentityProxy(mock.url)

  const launched = await launchOneEngine('one-engine-search', proxy.url, assistants, {
    SEARXNG_API_KEY: 'account-search-key',
    SEARXNG_URL: `http://127.0.0.1:${(searxng.address() as { port: number }).port}`
  })

  const { page } = launched

  try {
    await page.locator('[data-single-thread-bot="apex-bot-2"]').click()
    await page.waitForTimeout(800)
    await send(page, 'E2E_CALL(web_search)[{"query":"hc1166-hosted-search"}]【search-apex-bot-2】')

    await expect(page.getByText(/hc1166 search hit/).first()).toBeVisible({ timeout: 60_000 })
    expect(searches).toEqual([{ key: 'account-search-key', query: 'hc1166-hosted-search' }])
    expectCallAs(proxy.calls, '【search-apex-bot-2】', '剪辑助手')
    expectOneEngine(launched, assistants, 'after the search')
  } finally {
    await launched.app.close().catch(() => undefined)
    await mock.close()
    proxy.close()
    searxng.close()
  }
})
