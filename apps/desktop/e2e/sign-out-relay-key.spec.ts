// hc-1114: after 「退出登录」 the server has revoked this computer's relay key and
// no copy of it stays on the computer — not in any config.yaml, not in the
// engine's config backups, not in a running process — and desktop.log says so.
// M7 (hc-1083) found two api_key lines left in config.yaml and no log line.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop, waitForAppReady, writeMockProviderConfig } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

const ACCOUNTS: Record<string, string> = {
  'alice@example.invalid': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bob@example.invalid': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}

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

/** Every file under `root` whose bytes contain `needle`: a walk that knows nothing about the scrub. */
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

interface Fixture {
  page: Awaited<ReturnType<typeof launchDesktop>>['page']
  sandbox: ReturnType<typeof createSandbox>
  keys: Array<{ key: string; account: string; status: 'active' | 'revoked' | 'rotated' }>
  revokes: Array<{ bearerAccount: string; body: any }>
  signIn: (email: string) => Promise<{ ok: boolean }>
  send: (text: string) => Promise<void>
  replied: (text: string) => Promise<unknown>
  desktopLog: () => string
}

// Real engine (hermes serve from this checkout) + a fake APEX account server and relay that follow
// apex desktop_provisioning: provision rotates the same account's key, revoke retires the proven one.
async function withAccountServer(name: string, body: (ctx: Fixture) => Promise<void>) {
  const sandbox = createSandbox(name)

  const mock = await startMockServer({
    replyForPrompt: prompt => (prompt.match(/sign-out probe (one|two)/)?.[0] ?? 'other').replace(/ /g, '-') + '-ok'
  })

  const keys: Fixture['keys'] = []
  const revokes: Fixture['revokes'] = []
  const tokenFor = (account: string) =>
    `local.${Buffer.from(JSON.stringify({ sub: account })).toString('base64url')}.so`
  const accountOf = (auth: string | undefined) =>
    Object.values(ACCOUNTS).find(id => auth === `Bearer ${tokenFor(id)}`) || ''

  const relay = http.createServer((request, response) => {
    const used = keys.find(entry => `Bearer ${entry.key}` === request.headers.authorization)

    if (!used || used.status !== 'active') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'revoked', type: 'authentication_error' } }))

      return
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

    if (pathname === '/api/v1/auth/login') {
      const { email } = await readJson(request)
      json(200, { access_token: tokenFor(ACCOUNTS[email]), email, name: email.split('@')[0] })
    } else if (pathname === '/api/v1/desktop/provision-key/capabilities') {
      json(200, { version: 1 })
    } else if (pathname === '/api/v1/desktop/provision-key') {
      const owner = accountOf(request.headers.authorization)
      const payload = await readJson(request)
      keys
        .filter(entry => entry.account === owner && entry.status === 'active')
        .forEach(entry => (entry.status = 'rotated'))
      keys.push({ key: `sk-apex-signout-${keys.length + 1}-${Date.now()}`, account: owner, status: 'active' })
      json(200, {
        provision_revision: payload.provision_revision,
        api_key: keys.at(-1)?.key,
        base_url: `${relayUrl}/v1`,
        model: 'mock-model',
        email: Object.keys(ACCOUNTS).find(email => ACCOUNTS[email] === owner),
        name: 'Sign-out fixture'
      })
    } else if (pathname === '/api/v1/desktop/provision-key/revoke') {
      const owner = accountOf(request.headers.authorization)
      const payload = await readJson(request)
      revokes.push({ bearerAccount: owner, body: payload })

      const held = keys.find(
        entry =>
          entry.account === owner &&
          crypto.createHash('sha256').update(entry.key).digest('hex') === payload.legacy_key_hash
      )

      if (held?.status === 'active') {
        held.status = 'revoked'
      }

      json(200, {
        revoked: Boolean(held),
        ...(payload.provision_revision ? { provision_revision: payload.provision_revision } : {})
      })
    } else {
      json(404, { detail: 'fixture route unavailable' })
    }
  })

  const base = await listen(account)
  writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
  const logPath = path.join(sandbox.hermesHome, 'logs', 'desktop.log')
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
      sandbox,
      keys,
      revokes,
      signIn: email =>
        page.evaluate(
          async address =>
            (
              window as unknown as {
                hermesDesktop: {
                  managed: { signIn: (payload: { email: string; password: string }) => Promise<{ ok: boolean }> }
                }
              }
            ).hermesDesktop.managed.signIn({ email: address, password: 'fixture-password' }),
          email
        ),
      send: async text => {
        const composer = page.locator('textarea:visible, [contenteditable="true"]:visible').first()
        await composer.waitFor({ state: 'visible', timeout: 90_000 })
        await composer.click()
        await composer.type(text, { delay: 10 })
        await page.keyboard.press('Enter')
      },
      replied: text =>
        page.waitForFunction(
          reply => (document.body?.textContent ?? '').includes(reply),
          `${text.replace(/ /g, '-')}-ok`,
          {
            timeout: 90_000
          }
        ),
      desktopLog: () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
    })
  } finally {
    await app?.close()

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

test('signing out revokes the key, leaves no copy on disk or in a running process, and logs one line', async () => {
  test.setTimeout(300_000)

  await withAccountServer(
    'sign-out-relay-key',
    async ({ page, sandbox, keys, revokes, signIn, send, replied, desktopLog }) => {
      expect(await signIn('alice@example.invalid')).toMatchObject({ ok: true })
      await page.reload()
      // A turn, so the engine has built a session on the key (and backed config.yaml up).
      await send('sign-out probe one')
      await replied('sign-out probe one')
      const key = keys[0].key

      // A second assistant: its home holds its own copy of config.yaml.
      const assistant = path.join(sandbox.hermesHome, 'profiles', 'apex-bot-2')
      fs.mkdirSync(assistant, { recursive: true })
      fs.writeFileSync(path.join(assistant, 'SOUL.md'), '# 剪辑助手\n')
      fs.copyFileSync(path.join(sandbox.hermesHome, 'config.yaml'), path.join(assistant, 'config.yaml'))

      const before = filesHolding(sandbox.root, key)
      expect(before).toContain('hermes-home/config.yaml')
      expect(before).toContain('hermes-home/profiles/apex-bot-2/config.yaml')
      expect(before.some(file => file.startsWith('hermes-home/backups/config/config.yaml.good.'))).toBe(true)

      allowErrorBanners()
      await page.getByRole('button', { name: /^打开账户菜单/ }).click()
      await page.getByRole('menuitem', { name: '退出登录' }).click()

      // The server was asked with the proof of the exact key, by the account that held it.
      await expect.poll(() => revokes.length, { timeout: 30_000 }).toBe(1)
      expect(revokes[0].bearerAccount).toBe(ACCOUNTS['alice@example.invalid'])
      expect(revokes[0].body.legacy_key_hash).toBe(crypto.createHash('sha256').update(key).digest('hex'))
      expect(JSON.stringify(revokes[0].body)).not.toContain(key)
      expect(keys[0].status).toBe('revoked')

      await expect
        .poll(desktopLog, { timeout: 30_000 })
        .toContain(
          "[managed] signed out: the server revoked this computer's relay key and the stored credential is deleted; relay key removed from"
        )
      await expect
        .poll(desktopLog, { timeout: 90_000 })
        .toContain(
          '[apexnodes] restarting primary backend "default" so it no longer holds the revoked relay key (sign-out;'
        )

      // No copy anywhere under the sandbox (homes, backups, user data, logs) and no process still on it.
      await expect.poll(() => processesHolding(key), { timeout: 60_000 }).toEqual([])
      expect(filesHolding(sandbox.root, key)).toEqual([])
      expect(desktopLog().match(/\[managed\] sign(ed)?[- ]out/g)?.length).toBe(1)
      await page.screenshot({ path: test.info().outputPath('signed-out.png') })
    }
  )
})

test("signing in as another account revokes the previous account's key for this computer", async () => {
  test.setTimeout(240_000)

  await withAccountServer('switch-account-relay-key', async ({ keys, revokes, signIn, desktopLog }) => {
    expect(await signIn('alice@example.invalid')).toMatchObject({ ok: true })
    expect(await signIn('bob@example.invalid')).toMatchObject({ ok: true })

    await expect.poll(() => revokes.length, { timeout: 30_000 }).toBe(1)
    expect(revokes[0].bearerAccount).toBe(ACCOUNTS['alice@example.invalid'])
    expect(revokes[0].body.legacy_key_hash).toBe(crypto.createHash('sha256').update(keys[0].key).digest('hex'))
    expect(keys.map(entry => [entry.account, entry.status])).toEqual([
      [ACCOUNTS['alice@example.invalid'], 'revoked'],
      [ACCOUNTS['bob@example.invalid'], 'active']
    ])
    await expect
      .poll(desktopLog, { timeout: 30_000 })
      .toContain(
        "[managed] signed in as another account: the server revoked the previous account's relay key for this computer"
      )
  })
})
