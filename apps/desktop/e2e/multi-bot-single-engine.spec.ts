// hc-1166: several assistants on ONE engine. Every assistant stays a Hermes
// profile, but the primary engine serves them all, so a switch never starts a
// process. On one shared socket a call goes where its route says, so the guard
// here is the user's own view of it: what I type on an assistant reaches the
// model as THAT assistant (its SOUL) and is stored in THAT assistant's
// conversation (its profile's state.db), and no second engine ever runs.
//
// Round two switches back to APEX right after an assistant whose thread was
// created in round one. Before the fix APEX's thread lookup was routed as the
// assistant being left, the shell followed the wrong tip back there, and the
// first line typed on APEX went into the other assistant's conversation, with
// that assistant's identity.
//
// Real dev Electron + one real engine (`hermes serve` from this checkout) + the
// mock LLM behind a logging proxy that reads each call's system prompt.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop, writeEnvFile, writeMockProviderConfig } from './fixtures'
import { allowErrorBanners, expect, type Page, test } from './test'

const COMPOSER = '[data-slot="composer-rich-input"]'

const ASSISTANTS: ReadonlyArray<readonly [string, string]> = [
  ['apex-bot-2', '剪辑助手'],
  ['apex-bot-3', '运营助手']
]

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

test.setTimeout(300_000)

test('one engine serves every assistant, and each line reaches the model as the assistant it was typed to', async () => {
  allowErrorBanners()

  const mock = await startMockServer({
    replyForPrompt: prompt => `回声${(prompt.match(/【[^】]+】/g) ?? ['【无】']).at(-1)}`
  })

  // marker → the identity line of the system prompt that call carried.
  const identities = new Map<string, string>()
  const target = new URL(mock.url)

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

          if (marker && !identities.has(marker)) {
            identities.set(marker, system.match(/你叫\s*[^，。,\n]{1,12}|You are [A-Za-z]+/)?.[0] ?? '(none)')
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

  const sandbox = createSandbox('one-engine')

  writeMockProviderConfig(sandbox.hermesHome, `http://127.0.0.1:${(proxy.address() as { port: number }).port}`)
  writeEnvFile(sandbox.hermesHome)
  ASSISTANTS.forEach(([profile, name], index) =>
    seedAssistant(sandbox.hermesHome, profile, name, 1_700_000_000_000 + index)
  )

  const { app, page } = await launchDesktop(
    buildAppEnv(sandbox, {
      APEXNODES_MULTI_BOT: '1',
      APEXNODES_MULTI_BOT_SINGLE_ENGINE: '1',
      APEXNODES_SINGLE_THREAD: '1'
    })
  )

  try {
    const ownKey = page.getByRole('button', { name: '使用自己的密钥' })

    if (
      await ownKey.waitFor({ state: 'visible', timeout: 20_000 }).then(
        () => true,
        () => false
      )
    ) {
      await ownKey.click()
    }

    await expect(page.locator('[data-single-thread-bot="apex-bot-3"]')).toBeVisible({ timeout: 180_000 })

    const expected: Record<string, string[]> = { default: [] }
    const order = ['default', ...ASSISTANTS.map(([profile]) => profile)]

    for (const round of [1, 2]) {
      for (const profile of order) {
        await page.locator(`[data-single-thread-bot="${profile}"]`).click()
        await page.waitForTimeout(800)

        const marker = `【${profile}-${round}】`

        await send(page, `你是谁${marker}`)
        await expect(page.getByText(`回声${marker}`).first()).toBeVisible({ timeout: 60_000 })
        ;(expected[profile] ??= []).push(marker)

        const identity = identities.get(marker) ?? '(no call)'
        const name = ASSISTANTS.find(([id]) => id === profile)?.[1]

        if (name) {
          expect(identity, `${marker} reached the model as`).toBe(`你叫${name}`)
        } else {
          expect(identity, `${marker} reached the model as`).toMatch(/APEX/)
        }

        // One engine for every assistant, started as APEX, whatever the switch just asked for.
        expect(engines(app.process().pid!), `engines after ${marker}`).toHaveLength(1)
        expect(
          ASSISTANTS.map(([id]) => id),
          `engines after ${marker}`
        ).not.toContain(engines(app.process().pid!)[0])
      }
    }

    for (const profile of order) {
      expect(storedLines(sandbox.hermesHome, profile), `${profile}'s own conversation`).toEqual(expected[profile])
    }
  } finally {
    await app.close().catch(() => undefined)
    await mock.close()
    proxy.close()
  }
})
