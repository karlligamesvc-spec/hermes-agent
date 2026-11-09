// Guards for APEX's editor (hc-1188): the built editor (APEX_EDITOR, apex-editor/) and the patched source it is built
// from (APEX_EDITOR_SOURCE, the source's packages/openfilm), with no browser: what the editor holds and says. What it
// shows on screen is apex-editor-browser.test.mjs's. reverse-verify-editor.mjs takes each part of the patch out and
// expects one of these, or one of those, to go red.
//   APEX_EDITOR=<apex-editor> APEX_EDITOR_SOURCE=<source>/packages/openfilm node --test editor/apex-editor.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const editor = process.env.APEX_EDITOR
const source = process.env.APEX_EDITOR_SOURCE
assert.ok(editor && source, 'set APEX_EDITOR (the built editor) and APEX_EDITOR_SOURCE (the patched source package)')

const NOTICES = 'assets/apex-notices.txt'
const built = readdirSync(editor, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => relative(editor, join(entry.parentPath, entry.name)).split('\\').join('/'))
const text = file => readFileSync(join(editor, file), 'utf8')
/** the editor's own files: the page, its code and styles (the notices are the licenses, which name OpenFilm) */
const own = built.filter(file => file !== NOTICES && /\.(html|js|css|json|svg|txt)$/.test(file))

describe('the built editor', () => {
  test('holds a page, its code and its styles', () => {
    assert.ok(own.includes('index.html'), 'no index.html')
    assert.ok(own.some(file => /^assets\/index-[\w-]+\.js$/.test(file)), 'no code')
    assert.ok(own.some(file => /^assets\/index-[\w-]+\.css$/.test(file)), 'no styles')
  })

  test('never names OpenFilm, in any language (only the license notices do)', () => {
    assert.deepEqual(
      own.filter(file => text(file).includes('OpenFilm')),
      [],
      'these files name OpenFilm'
    )
  })

  test("reaches none of OpenFilm's online places", () => {
    const places = /openfilm\.dev|github\.com\/openfilm|raw\.githubusercontent\.com|api\.github\.com/
    assert.deepEqual(
      own.filter(file => places.test(text(file))),
      [],
      "these files link to OpenFilm's site, repositories or GitHub's API"
    )
  })

  test('the page: 剪辑, Simplified Chinese, light first, APEX its host before the editor runs, no OpenFilm mark', () => {
    const html = text('index.html')
    assert.match(html, /<html lang="zh-CN">/)
    assert.match(html, /<title>剪辑<\/title>/)
    assert.doesNotMatch(html, /rel="icon"/, 'a page icon (OpenFilm’s mark)')
    const host = html.indexOf("window.openfilmHost = { version: 1, name: 'APEX' };")
    const modules = html.indexOf('<script type="module"')
    assert.ok(host > 0 && modules > host, 'APEX is the host before the editor’s modules run')
    assert.match(html, /localStorage\.getItem\('openfilm\.theme'\) \|\| 'light'/)
  })

  test("carries OpenFilm's MIT notice in full, and the third-party notices", () => {
    const notices = text(NOTICES)
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      assert.ok(notices.includes(readFileSync(join(source, file), 'utf8').trim()), `${file} is not in the notices`)
    }
    assert.match(notices, /^This editor is a modified version of OpenFilm /m)
  })
})

describe("the editor's words", async () => {
  const ui = join(source, 'studio', 'ui')
  const { withoutBrand } = await import(pathToFileURL(join(ui, 'apex', 'brand.mjs')).href)
  const i18n = await import(pathToFileURL(join(ui, 'src', 'i18n', 'index.ts')).href)
  const { apexWords } = await import(pathToFileURL(join(ui, 'src', 'i18n', 'apex.ts')).href)
  const { zhCN } = await import(pathToFileURL(join(ui, 'src', 'i18n', 'zh-CN.ts')).href)

  test('Simplified Chinese until APEX says otherwise, whatever the browser speaks', () => {
    assert.equal(i18n.lookup('launcher.projects'), zhCN.launcher.projects)
  })

  for (const [path, language] of [
    ['connection.goneApp', 'zh-CN'],
    ['connection.goneApp', 'en'],
    ['connection.goneApp', 'ja'],
    ['timeline.subtitlesConnect', 'zh-CN'],
    ['timeline.subtitleTranslateConnect', 'en'],
    ['timeline.record.denied', 'ja'],
    ['canvas.redraw.noModel', 'zh-CN']
  ]) {
    test(`APEX's words over Studio's: ${path} in ${language}`, () => {
      const said = path.split('.').reduce((table, key) => table?.[key], apexWords[language])
      assert.equal(typeof said, 'string', `apex.ts has no ${path} in ${language}`)
      assert.equal(i18n.lookup(path, language), said)
      assert.doesNotMatch(said, /OpenFilm/)
    })
  }

  for (const [language, before, after] of [
    ['en', 'OpenFilm {version} is ready.', 'The editor {version} is ready.'],
    ['en', 'Quit OpenFilm and open it again.', 'Quit the editor and open it again.'],
    ['en', "OpenFilm's own service.", 'The editor’s own service.'],
    ['en', 'Settings (the OpenFilm logo at the top left)', 'Settings (the editor logo at the top left)'],
    ['zh-CN', '请重启 OpenFilm 后再试。', '请重启编辑器后再试。'],
    ['zh-CN', 'OpenFilm 0.3.0', '编辑器 0.3.0'],
    ['zh-CN', '或用 OpenFilm 的 GPT Image。', '或用编辑器的 GPT Image。'],
    ['ja', 'OpenFilm を再起動してください。', 'エディターを再起動してください。'],
    ['es', 'OpenFilm está listo.', 'El editor está listo.']
  ]) {
    test(`withoutBrand in ${language}: ${before}`, () => {
      assert.equal(withoutBrand(before, language), after)
    })
  }

  test('no language’s table keeps the name once the build has rewritten it', () => {
    for (const code of ['en', 'zh-CN', 'ja', 'ko', 'es']) {
      const table = readFileSync(join(ui, 'src', 'i18n', `${code}.ts`), 'utf8')
      assert.ok(table.includes('OpenFilm'), `${code}.ts no longer names OpenFilm upstream: drop this check`)
      assert.doesNotMatch(withoutBrand(table, code), /OpenFilm/, `${code}.ts`)
    }
  })
})
