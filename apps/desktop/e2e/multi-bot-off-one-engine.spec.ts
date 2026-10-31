// hc-1115: with several assistants forced off (APEXNODES_MULTI_BOT=0), the
// screen shows APEX alone, so only one engine may run, as APEX (the default
// profile), and active-profile.json must not be set to another assistant.
// Before the fix the first-boot heuristic picked the assistant with the
// busiest state.db, the primary engine started as that assistant, and the
// heuristic undid a hand edit back to APEX on the next launch.
//
// The state the off launch meets is made by the app itself: a launch with
// several assistants on, an assistant created from the sidebar and a turn
// with it. Real dev Electron + real engines (`hermes serve` from this
// checkout) + the mock LLM. Engines are counted with `ps` (macOS / Linux).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type Sandbox,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { expect, test } from './test'

type Launched = Awaited<ReturnType<typeof launchDesktop>>

const SINGLE_THREAD = { APEXNODES_SINGLE_THREAD: '1' }

/** Every `hermes … serve` process below this Electron, with the profile it was started as. */
function engines(electronPid: number): Array<{ pid: number; profile: string }> {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }))

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
    .map(row => ({ pid: row.pid, profile: row.command.match(/--profile (\S+)/)?.[1] ?? '(none)' }))
}

function activeProfileFile(sandbox: Sandbox): unknown {
  const file = path.join(sandbox.userDataDir, 'active-profile.json')

  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : 'missing'
}

function desktopLog(sandbox: Sandbox): string {
  const file = path.join(sandbox.hermesHome, 'logs', 'desktop.log')

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function launch(sandbox: Sandbox, extra: Record<string, string>): Promise<Launched> {
  const launched = await launchDesktop(buildAppEnv(sandbox, extra))
  const { page } = launched
  const ownKey = page.getByRole('button', { name: '使用自己的密钥' })

  if (
    await ownKey.waitFor({ state: 'visible', timeout: 15_000 }).then(
      () => true,
      () => false
    )
  ) {
    await ownKey.click()
  }

  await waitForAppReady({ ...launched, sandbox, cleanup: async () => {} } as never, 120_000)

  return launched
}

/** The new assistant's first-open questions: take the first option while a card asks (without an APEX account the platform one never comes). */
async function answerFirstOpen(page: Launched['page']): Promise<void> {
  for (let step = 0; step < 3; step += 1) {
    const card = page.locator('section[data-first-open-card]:has([role="group"] button)')

    if (
      !(await card
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(
          () => true,
          () => false
        ))
    ) {
      return
    }

    const asked = await card.first().getAttribute('data-first-open-card')

    await card.first().locator('[role="group"] button').first().click()
    await expect(page.locator(`section[data-first-open-card="${asked}"]:has([role="group"] button)`)).toHaveCount(0, {
      timeout: 60_000
    })
  }
}

async function send(page: Launched['page'], text: string): Promise<void> {
  const composer = page.locator('[data-slot="composer-rich-input"]:visible').first()
  await composer.waitFor({ state: 'visible', timeout: 90_000 })
  await composer.click()
  await composer.type(text, { delay: 10 })
  await page.keyboard.press('Enter')
  await expect
    .poll(() => composer.evaluate(el => ((el as HTMLTextAreaElement).value ?? el.textContent ?? '').trim()), {
      timeout: 30_000
    })
    .toBe('')
}

test.describe('hc-1115 several assistants off: one engine, as APEX', () => {
  test.skip(process.platform === 'win32', 'engines are counted with ps')
  test.setTimeout(600_000)

  test('an assistant made with them on does not become the main engine once they are off', async () => {
    const mock = await startMockServer({ replyForPrompt: () => 'hc1115-reply-ok' })
    const sandbox = createSandbox('hc1115')
    let running: Launched | undefined

    writeMockProviderConfig(sandbox.hermesHome, mock.url, '  language: zh\n')
    writeEnvFile(sandbox.hermesHome)

    try {
      // 1. Several assistants on: make one from the sidebar and talk to it, so its state.db is the busiest.
      running = await launch(sandbox, { ...SINGLE_THREAD, APEXNODES_MULTI_BOT: '1' })
      const { page } = running

      await page.getByRole('button', { name: /新建一个助手|New assistant/ }).click()
      await page.getByPlaceholder(/比如：小红书文案|e\.g\. Captions/).fill('剪辑助手')
      await page.getByRole('button', { name: /^(建好了|Create)$/ }).click()
      await expect.poll(() => engines(running!.app.process().pid!).length, { timeout: 120_000 }).toBe(2)
      await answerFirstOpen(page)

      for (const [index, text] of ['hc1115 第一句', 'hc1115 第二句'].entries()) {
        await send(page, text)
        await page.waitForFunction(
          count => (document.body?.textContent ?? '').split('hc1115-reply-ok').length - 1 > count,
          index,
          { timeout: 120_000 }
        )
      }

      const onEngines = engines(running.app.process().pid!)
      test.info().annotations.push({ type: 'on', description: JSON.stringify(onEngines) })
      expect(onEngines.map(engine => engine.profile).sort()).toEqual(['(none)', 'apex-bot-2'])

      await running.app.close()
      running = undefined

      // A launch shows its engines once boot settles (a pool engine the renderer asks for comes within seconds).
      const settle = async (extra: Record<string, string>) => {
        running = await launch(sandbox, { ...SINGLE_THREAD, ...extra })
        await running.page.waitForTimeout(20_000)

        return engines(running.app.process().pid!)
      }

      const close = async () => {
        await running?.app.close()
        running = undefined
      }

      const note = (type: string, value: unknown) =>
        test.info().annotations.push({ type, description: JSON.stringify(value) })

      // 2. On again: the heuristic now records the busiest assistant, the path several assistants on keep.
      note('on again', { engines: await settle({ APEXNODES_MULTI_BOT: '1' }), file: activeProfileFile(sandbox) })
      expect(activeProfileFile(sandbox)).toEqual({ profile: 'apex-bot-2', _migrated: true })
      await close()

      // 3. Forced off (QA b67's --multi-bot-off): one engine, as APEX; the file is left as it is.
      const heuristicPick = activeProfileFile(sandbox)
      const off = await settle({ APEXNODES_MULTI_BOT: '0' })
      note('off', { engines: off, file: activeProfileFile(sandbox) })
      expect.soft(off).toEqual([expect.objectContaining({ profile: 'default' })])
      expect.soft(activeProfileFile(sandbox)).toEqual(heuristicPick)

      // A pick the renderer remembers (the developer rail, ⌘1–9) is not recorded either.
      await running!.page.evaluate(() =>
        (
          window as unknown as { hermesDesktop: { profile: { remember: (name: string) => Promise<unknown> } } }
        ).hermesDesktop.profile.remember('apex-bot-2')
      )
      expect.soft(activeProfileFile(sandbox)).toEqual(heuristicPick)
      await close()

      // 4. QA b67 set the file back to APEX by hand; the next off launch used to write the assistant back.
      const handEdit = { profile: 'default', _migrated: true }
      fs.writeFileSync(path.join(sandbox.userDataDir, 'active-profile.json'), JSON.stringify(handEdit))
      const offAgain = await settle({ APEXNODES_MULTI_BOT: '0' })
      note('off after the hand edit', { engines: offAgain, file: activeProfileFile(sandbox) })
      expect.soft(offAgain).toEqual([expect.objectContaining({ profile: 'default' })])
      expect.soft(activeProfileFile(sandbox)).toEqual(handEdit)
      await close()

      await expect.poll(() => desktopLog(sandbox)).toContain('[multi-bot] off: the main engine starts as APEX')
      expect.soft(desktopLog(sandbox)).toContain('[multi-bot] off: not recording "apex-bot-2" as the startup profile')

      // 5. On once more: the heuristic re-scores its own pick as it always has.
      note('on once more', { engines: await settle({ APEXNODES_MULTI_BOT: '1' }), file: activeProfileFile(sandbox) })
      expect.soft(activeProfileFile(sandbox)).toEqual({ profile: 'apex-bot-2', _migrated: true })
      await close()
    } finally {
      await running?.app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    }
  })
})
