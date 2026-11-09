// Reverse check for APEX's editor (hc-1188): each part of editor/0001-apex-editor.patch, taken back out of the patched
// source (an exact text that must be found exactly once), and the editor built again, has to turn the named guard
// tests red (apex-editor.test.mjs, apex-editor-browser.test.mjs); the source as patched passes them all (verify-editor
// ran them). The source is put back after each part.
//   APEX_EDITOR=<built editor> APEX_EDITOR_SOURCE=<patched source package> OPENFILM_PACKAGE=<patched package>
//   APEX_CHROME=<chrome> node reverse-verify-editor.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pin = JSON.parse(readFileSync(join(here, '..', 'pin.json'), 'utf8'))
const guards = pin.editor.guards.map(g => join(here, '..', g))
const source = process.env.APEX_EDITOR_SOURCE
const built = process.env.APEX_EDITOR
assert.ok(source && built, 'set APEX_EDITOR_SOURCE and APEX_EDITOR (and OPENFILM_PACKAGE, APEX_CHROME for the browser)')

const UI = 'studio/ui'
const SETTINGS = `${UI}/src/components/settings/SettingsModal.tsx`
/** Each part of the patch taken out, and the guard tests (by a part of their names) that must fail without it. */
export const INJECTIONS = [
  {
    part: "APEX as the editor's host (Studio then leaves out the desktop app's button)",
    file: `${UI}/index.html`,
    find: "  window.openfilmHost = { version: 1, name: 'APEX' };\n",
    replace: '',
    fails: ['no Desktop button', 'APEX its host before the editor runs']
  },
  {
    part: 'the page is called 剪辑',
    file: `${UI}/index.html`,
    find: '<title>剪辑</title>',
    replace: '<title>OpenFilm Studio</title>',
    fails: ['never names OpenFilm', "the page is APEX's"]
  },
  {
    part: 'light first, as APEX is (the page)',
    file: `${UI}/index.html`,
    find: "localStorage.getItem('openfilm.theme') || 'light'",
    replace: "localStorage.getItem('openfilm.theme') || 'dark'",
    fails: ["the page is APEX's", 'light first']
  },
  {
    part: 'light first, as APEX is (what Settings shows)',
    file: `${UI}/src/components/settings/theme.ts`,
    find: "return value === 'dark' || value === 'system' ? value : 'light';",
    replace: "return value === 'light' || value === 'system' ? value : 'dark';",
    fails: ['light chosen']
  },
  {
    part: 'Simplified Chinese until APEX says otherwise',
    file: `${UI}/src/i18n/index.ts`,
    find: "return choice !== 'system' ? choice : 'zh-CN';",
    replace: "return choice !== 'system' ? choice : 'en';",
    fails: ['Simplified Chinese until APEX says otherwise', "the page is APEX's"]
  },
  {
    part: "APEX's words over Studio's",
    file: `${UI}/src/i18n/index.ts`,
    find: '  return find(apexWords[language], path)\n',
    replace: '  return null\n',
    fails: ["APEX's words over Studio's"]
  },
  {
    part: "each language's table without the OpenFilm name, as it is built",
    file: `${UI}/vite.config.ts`,
    find: 'plugins: [apexWords(), react(), tailwind()]',
    replace: 'plugins: [react(), tailwind()]',
    fails: ['never names OpenFilm']
  },
  {
    part: 'English saying "the" before the name reads "the editor", not "the the editor"',
    file: `${UI}/apex/brand.mjs`,
    find: "const said = word === EDITOR.en ? text.replace(/\\b([Tt]he) OpenFilm(['’]s)?/g, (_, the, owned) => `${the} editor${owned ? '’s' : ''}`) : text;",
    replace: 'const said = text;',
    fails: ['withoutBrand in en: Settings (the OpenFilm logo at the top left)']
  },
  {
    part: 'a settings gear, not OpenFilm’s mark',
    file: `${UI}/src/components/BrandLogo.tsx`,
    find: '  return <Settings size={size} strokeWidth={1.75} className="block shrink-0" aria-hidden="true" />;',
    replace: '  return <svg width={size} height={size} role="img" aria-label="OpenFilm"><mask id="openfilm-gap-x" /></svg>;',
    fails: ['never names OpenFilm', 'a settings gear']
  },
  {
    part: 'no Services section',
    file: SETTINGS,
    find: "sections: ['general', ...(studioHost?.agents ? ['agents' as const] : [])] },",
    replace: "sections: ['general', ...(studioHost?.agents ? ['agents' as const] : []), 'models'] },",
    fails: ['Settings: General, Keyboard shortcuts and Advanced only']
  },
  {
    part: 'no Developer section',
    file: SETTINGS,
    find: "{ group: 'help', sections: ['shortcuts', 'advanced'] },",
    replace: "{ group: 'help', sections: ['shortcuts', 'advanced', 'developer'] },",
    fails: ['Settings: General, Keyboard shortcuts and Advanced only']
  },
  {
    part: "no links out to OpenFilm's places",
    file: SETTINGS,
    find: 'const LINKS: Array<{ label: string; href: string }> = [];',
    replace: "const LINKS: Array<{ label: string; href: string }> = [{ label: 'settings.links.site', href: 'https://openfilm.dev' }];",
    fails: ["reaches none of OpenFilm's online places", 'no link out']
  },
  {
    part: 'no language of its own in General (APEX sets it)',
    file: SETTINGS,
    find: "        {/* APEX's editor speaks APEX's language (Desktop sets it): no choice of its own here (hc-1188) */}\n",
    replace: "        <SettingsItem title={t('settings.appearance.language')} description=\"\" control={null} />\n",
    fails: ['no language of its own']
  },
  {
    part: "About is APEX's, with the licenses",
    file: SETTINGS,
    find: '      <ApexAboutGroup />',
    replace: '      <AboutGroup />',
    fails: ['About: APEX 剪辑', 'never names OpenFilm']
  },
  {
    part: 'no examples in the projects window',
    file: `${UI}/src/components/ProjectsLibrary.tsx`,
    find: "items={[{ id: 'projects' as const, label: t('launcher.projects') }]}",
    replace: "items={[{ id: 'projects' as const, label: t('launcher.projects') }, { id: 'examples' as const, label: t('launcher.examples') }]}",
    fails: ['the projects window']
  },
  {
    part: 'no "from GitHub" among the ways to start',
    file: `${UI}/src/components/ProjectsView.tsx`,
    find: "            { id: 'folder', icon: <FolderOpen size={14} />, label: t('projects.openFolder'), onSelect: onOpenFolder },\n",
    replace:
      "            { id: 'folder', icon: <FolderOpen size={14} />, label: t('projects.openFolder'), onSelect: onOpenFolder },\n            { id: 'github', icon: <FolderOpen size={14} />, label: t('projects.getFromGitHub'), onSelect: onOpenFolder },\n",
    fails: ['the projects window']
  },
  {
    part: "the library's categories: what is on this computer",
    file: `${UI}/src/components/library/LibraryDrawer.tsx`,
    find: "export const CATEGORIES: Category[] = ['media', 'template', 'captions', 'text', 'sticker', 'filter', 'effect', 'transition'];",
    replace:
      "export const CATEGORIES: Category[] = ['media', 'skill', 'template', 'captions', 'voice', 'sound', 'music', 'text', 'sticker', 'filter', 'effect', 'transition'];",
    fails: ['the library']
  },
  {
    part: 'APEX violet',
    file: `${UI}/src/globals.css`,
    find: '  --accent: #7e6cef;',
    replace: '  --accent: #0098a3;',
    fails: ["the page is APEX's"]
  },
  {
    part: "the system's type, not Inter",
    file: `${UI}/src/globals.css`,
    find: "  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', ui-sans-serif, system-ui, Roboto,",
    replace: "  --font-sans: 'Inter Variable', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', ui-sans-serif, system-ui, Roboto,",
    fails: ["the page is APEX's"]
  },
  {
    part: 'no OpenFilm name in the project fonts’ alias',
    file: `${UI}/src/lib/font-menu.ts`,
    find: "export const PROJECT_FONT_PREFIX = 'APEX Project ';",
    replace: "export const PROJECT_FONT_PREFIX = 'OpenFilm Project ';",
    fails: ['never names OpenFilm']
  },
  {
    part: 'no OpenFilm name in the text fonts’ alias',
    file: `${UI}/src/components/library/TextStyleSample.tsx`,
    find: "const OWN = 'APEX Text ';",
    replace: "const OWN = 'OpenFilm Text ';",
    fails: ['never names OpenFilm']
  },
  {
    part: 'the default keys are named APEX',
    file: `${UI}/src/components/settings/ShortcutsSection.tsx`,
    find: "{ openfilm: 'APEX', premiere: 'Premiere Pro', fcp: 'Final Cut Pro X' }",
    replace: "{ openfilm: 'OpenFilm', premiere: 'Premiere Pro', fcp: 'Final Cut Pro X' }",
    fails: ['never names OpenFilm', 'no screen names OpenFilm']
  }
]

/** Build the editor from the source as it stands into a scratch folder, with the notices of the verified build. */
function build() {
  const out = mkdtempSync(join(tmpdir(), 'apex-editor-reverse-'))
  const vite = join(source, 'node_modules', 'vite', 'bin', 'vite.js')
  const made = spawnSync(process.execPath, [vite, 'build', '--config', `${UI}/vite.config.ts`, '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: source,
    encoding: 'utf8',
    timeout: 300_000
  })
  assert.equal(made.status, 0, `the editor did not build: ${made.stderr}`)
  copyFileSync(join(built, 'assets', 'apex-notices.txt'), join(out, 'assets', 'apex-notices.txt'))
  return out
}

/** Run the guards on an editor built from the source: the names of the tests that failed, and how many ran. */
function runGuards(editor) {
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...guards], {
    env: { ...process.env, APEX_EDITOR: editor, APEX_EDITOR_SOURCE: source },
    encoding: 'utf8',
    timeout: 600_000
  })
  const failed = [...run.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1])
  const total = Number(/^# tests (\d+)$/m.exec(run.stdout)?.[1] ?? 0)
  return { failed, total, code: run.status }
}

let bad = 0
for (const { part, file, find, replace, fails } of INJECTIONS) {
  const path = join(source, file)
  const text = readFileSync(path, 'utf8')
  const hits = text.split(find).length - 1
  assert.equal(hits, 1, `"${part}": the text to take out is found ${hits} times in ${file}, not once`)
  let editor = ''
  try {
    writeFileSync(path, text.replace(find, replace))
    editor = build()
    const { failed } = runGuards(editor)
    const missing = fails.filter(name => !failed.some(f => f.includes(name)))
    const ok = failed.length > 0 && missing.length === 0
    if (!ok) bad++
    console.log(
      `${ok ? 'red as expected' : 'NOT RED'}: without ${part} -> ${failed.length} fail${failed.length ? `: ${failed.join(' | ')}` : ''}${missing.length ? ` (expected also: ${missing.join(' | ')})` : ''}`
    )
  } finally {
    writeFileSync(path, text)
    if (editor) rmSync(editor, { recursive: true, force: true })
  }
}
assert.equal(bad, 0, `${bad} part(s) of APEX's editor are not guarded`)
console.log(`all ${INJECTIONS.length} parts of APEX's editor are guarded`)
