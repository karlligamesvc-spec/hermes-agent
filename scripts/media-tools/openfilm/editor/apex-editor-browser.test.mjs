// The identity of APEX's editor (hc-1188), on screen: the patched Studio (OPENFILM_PACKAGE) serves the built editor
// (APEX_EDITOR) as Desktop has it serve it, offline as Desktop runs it, and a real Chrome or Chromium (APEX_CHROME,
// through the toolkit's own playwright-core) opens a new project in it in English, as a browser on an English system
// would. Every screen APEX's editor changed is checked: the page, the top bar, Settings, About, the projects window
// and the library's categories, and that nothing leaves this computer. A build that passes every other check but
// looks like OpenFilm's own editor fails here.
//   APEX_EDITOR=<apex-editor> OPENFILM_PACKAGE=<patched package> APEX_CHROME=<chrome> node --test <this file>
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const editor = process.env.APEX_EDITOR
const pkg = process.env.OPENFILM_PACKAGE
const chrome = process.env.APEX_CHROME
assert.ok(editor && pkg, 'set APEX_EDITOR (the built editor) and OPENFILM_PACKAGE (the patched openfilm package)')
assert.ok(chrome, 'set APEX_CHROME to a Chrome or Chromium: the editor is checked on screen')

/** Studio's folders in a scratch home, and OpenFilm's online sources off, as Desktop sets them (openfilm-studio.ts). */
const home = mkdtempSync(join(tmpdir(), 'apex-editor-browser-'))
mkdirSync(join(home, 'offline'), { recursive: true })
writeFileSync(join(home, 'offline', 'examples.json'), '{"examples":[]}\n')
writeFileSync(join(home, 'offline', 'skills.json'), '{"version":1,"skills":[]}\n')
Object.assign(process.env, {
  OPENFILM_HOME: join(home, 'home'),
  OPENFILM_LIBRARY: join(home, 'projects'),
  OPENFILM_SAVED: join(home, 'saved'),
  OPENFILM_SKILLS: join(home, 'skills'),
  OPENFILM_EXPORTS: join(home, 'exports'),
  OPENFILM_EXAMPLES_INDEX: join(home, 'offline', 'examples.json'),
  OPENFILM_SKILLS_INDEX: join(home, 'offline', 'skills.json'),
  OPENFILM_LIBRARY_URL: 'http://127.0.0.1:9',
  OPENFILM_API_URL: 'http://127.0.0.1:9',
  OPENFILM_NO_BROWSER: '1',
  OPENFILM_NO_UPDATE_CHECK: '1'
})

const local = url => /^(data|blob|about):/.test(url) || ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)

describe("APEX's editor on screen", () => {
  let studio
  let browser
  let page
  const requests = []
  const seen = []
  /** the words on screen now, kept for the check that none of them names OpenFilm */
  const words = async () => {
    const text = await page.evaluate(() => `${document.title}\n${document.body.innerText}`)
    seen.push(text)
    return text
  }
  const settings = async section => {
    if (!(await page.locator('[role=dialog] nav').count())) await page.locator('button[aria-label="设置"]').first().click()
    await page.locator('[role=dialog] nav button', { hasText: section }).click()
    await page.locator('#settings-title', { hasText: section }).waitFor()
  }

  before(async () => {
    const { startStudio } = await import(pathToFileURL(join(pkg, 'studio', 'server', 'server.mjs')).href)
    studio = await startStudio({ port: 0, stays: true, editorDir: editor, openBrowser: () => {} })
    const made = await fetch(`${studio.origin}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-studio-key': studio.key },
      body: JSON.stringify({ name: 'apex-guard' })
    }).then(res => res.json())
    assert.ok(made?.project?.id, `Studio made no project: ${JSON.stringify(made)}`)
    const { chromium } = createRequire(join(pkg, 'package.json'))('playwright-core')
    browser = await chromium.launch({ executablePath: chrome, headless: true })
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    page.on('request', request => requests.push(request.url()))
    await page.goto(`${studio.origin}/open?key=${studio.key}&to=${encodeURIComponent(`/projects/${made.project.id}`)}`)
    await page.locator('button[aria-label="设置"]').first().waitFor({ timeout: 60_000 })
  })

  after(async () => {
    await browser?.close()
    await studio?.close()
    rmSync(home, { recursive: true, force: true })
  })

  test("the page is APEX's: 剪辑, Simplified Chinese in an English browser, light, APEX violet, the system's type", async () => {
    /* each screen's words are read first, so a check that fails here still leaves them for "no screen names OpenFilm" */
    await words()
    const look = await page.evaluate(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      font: getComputedStyle(document.body).fontFamily
    }))
    assert.deepEqual(
      { title: look.title, lang: look.lang, theme: look.theme, accent: look.accent },
      { title: '剪辑', lang: 'zh-CN', theme: 'light', accent: '#7e6cef' }
    )
    assert.doesNotMatch(look.font, /Inter/, 'the editor sets Inter, not the system’s type')
  })

  test("no Desktop button, and a settings gear where OpenFilm's mark was", async () => {
    assert.equal(await page.locator('.lucide-monitor-down').count(), 0, 'the desktop app is introduced')
    assert.equal(await page.locator('mask[id^="openfilm-gap"]').count(), 0, "OpenFilm's mark is drawn")
    assert.equal(await page.locator('button[aria-label="设置"] svg.lucide-settings').count() > 0, true, 'no settings gear')
  })

  test('Settings: General, Keyboard shortcuts and Advanced only; no language of its own, light chosen, no link out', async () => {
    await settings('通用')
    const general = await words()
    const nav = await page.locator('[role=dialog] nav button').allTextContents()
    assert.deepEqual(nav.map(s => s.trim()), ['通用', '键盘快捷键', '高级'])
    assert.equal(await page.locator('[role=dialog] a[href^="http"]').count(), 0, 'Settings links out')
    assert.doesNotMatch(general, /\n语言\n/, 'General offers a language of its own')
    assert.equal((await page.locator('[role=dialog] [role=radio][aria-checked=true]').allTextContents()).join().trim(), '浅色')
  })

  test("About: APEX 剪辑, and OpenFilm's license when asked for", async () => {
    await settings('通用')
    assert.match(await words(), /APEX 剪辑/)
    await page.locator('[role=dialog] button', { hasText: '查看开源许可' }).click()
    /* read from assets/apex-notices.txt once asked for: wait for it, not for the "reading" line */
    await page.locator('pre[data-apex-notices]', { hasText: 'MIT License' }).waitFor({ timeout: 10_000 })
    const notices = await page.locator('pre[data-apex-notices]').textContent()
    assert.match(notices, /MIT License/)
    assert.match(notices, /Copyright \(c\)/)
  })

  test('the library: what is on this computer, none of what OpenFilm’s service hands out', async () => {
    await settings('高级')
    await words()
    const categories = await page.locator('[data-library-category]').evaluateAll(rows => rows.map(r => r.dataset.libraryCategory))
    assert.deepEqual(categories, ['media', 'template', 'captions', 'text', 'sticker', 'filter', 'effect', 'transition'])
    await settings('键盘快捷键')
    await words()
    await page.keyboard.press('Escape')
  })

  test("the projects window: the person's own (no examples), started from a folder (not from GitHub)", async () => {
    await page.locator('button[aria-label="全部项目…"]').first().click()
    await page.locator('text=导入自').first().waitFor()
    const screen = await words()
    assert.doesNotMatch(screen, /示例/, 'the examples are offered')
    await page.locator('button', { hasText: '导入自' }).first().click()
    const items = await page.locator('[role=menu] [role=menuitem]').allTextContents()
    assert.deepEqual(items.map(s => s.trim()), ['打开文件夹…'])
    await page.keyboard.press('Escape')
  })

  test('no screen names OpenFilm', () => {
    assert.ok(seen.length >= 5, 'too few screens were read')
    assert.deepEqual(seen.filter(text => text.includes('OpenFilm')), [])
  })

  test('nothing leaves this computer', () => {
    assert.ok(requests.length > 0, 'no request was seen')
    assert.deepEqual(requests.filter(url => !local(url)), [])
  })
})
