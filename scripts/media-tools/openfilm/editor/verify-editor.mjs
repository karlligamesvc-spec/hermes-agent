// APEX's editor (hc-1188): Studio's editor (studio/ui), built from the pinned openfilm source with editor/*.patch, as
// `apex-editor/` beside the toolkit's node_modules. Desktop has Studio serve it (startStudio's `editorDir`) when the
// toolkit carries it. In APEX Desktop the editor is APEX's: no OpenFilm name or mark (OpenFilm's trademark terms: a
// modified version needs its own), none of OpenFilm's online places, APEX's look, Simplified Chinese first.
//   1. installs the editor's build tools as upstream pins them: pnpm (pinned with its integrity) installs from the
//      source's pnpm-lock.yaml, frozen, into a store under the work folder;
//   2. builds the editor unpatched and checks it is byte for byte the one the npm package ships (studio/ui/dist): the
//      build here is upstream's own, so all that differs in APEX's is what the patches change;
//   3. applies editor/*.patch to the source, typechecks the editor and runs upstream's own editor tests on it;
//   4. builds APEX's editor into <work>/editor/apex-editor, with assets/apex-notices.txt (OpenFilm's MIT license and
//      third-party notices, shown under Settings › About);
//   5. runs the guards (pin.json editor.guards, a browser among them: APEX_CHROME) and the reverse check
//      (reverse-verify-editor.mjs: each part of the patch taken out turns a guard red).
// Called by verify.mjs once its own checks pass.
//   node editor/verify-editor.mjs <work folder> <patched npm package> <patched source package>
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { npmPackage, run, sha256 } from '../pinned.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pin = JSON.parse(readFileSync(join(here, '..', 'pin.json'), 'utf8'))
const [work, pkg, source] = process.argv.slice(2).map(p => resolve(p))
assert.ok(work && pkg && source, 'usage: node verify-editor.mjs <work> <npm package> <source package>')
const out = join(work, 'editor')
mkdirSync(out, { recursive: true })
const checkout = resolve(source, relative(pin.source.packageDir, '.'))
assert.ok(existsSync(join(checkout, 'pnpm-lock.yaml')), `${checkout} has no pnpm-lock.yaml`)

/* 1. upstream's build tools, as its lock pins them */
const pnpm = join(await npmPackage(pin.editor.pnpm, join(out, 'pnpm')), 'bin', 'pnpm.cjs')
const registry = process.env.APEX_NPM_REGISTRY ? ['--registry', process.env.APEX_NPM_REGISTRY] : []
run(
  process.execPath,
  [pnpm, 'install', '--frozen-lockfile', '--filter', 'openfilm', '--ignore-scripts', '--reporter=append-only',
    '--store-dir', join(out, 'pnpm-store'), ...registry],
  { cwd: checkout, env: { ...process.env, npm_config_update_notifier: 'false', CI: '1' } }
)
const vite = join(source, 'node_modules', 'vite', 'bin', 'vite.js')
const build = into =>
  run(process.execPath, [vite, 'build', '--config', 'studio/ui/vite.config.ts', '--outDir', into, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: source
  })

/** Every file under `dir` with its SHA-256, by its path there. */
const files = dir =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .sort()
      .map(f => [f, sha256(join(dir, f))])
  )

/* 2. upstream's editor, built here, is the one the npm package ships */
build(join(out, 'stock'))
assert.deepEqual(
  files(join(out, 'stock')),
  files(join(pkg, 'studio', 'ui', 'dist')),
  `the editor built from ${pin.source.tag} is not the one openfilm ${pin.package.version} ships`
)
console.log(`the editor built from ${pin.source.tag} is byte for byte the npm package's`)

/* 3. APEX's patches, upstream's typecheck and its own editor tests */
const patches = pin.editor.patches.map(p => join(here, '..', p))
for (const patch of patches) {
  run('patch', ['-p1', '--forward', '--batch', '--dry-run', '-d', source, '-i', patch], { stdio: ['ignore', 'ignore', 'inherit'] })
  run('patch', ['-p1', '--forward', '--batch', '-d', source, '-i', patch], { stdio: ['ignore', 'ignore', 'inherit'] })
}
const leftovers = readdirSync(join(source, 'studio', 'ui'), { recursive: true }).filter(f => /\.(rej|orig)$/.test(String(f)))
assert.deepEqual(leftovers, [], 'an editor patch left rejects or backups')
run(process.execPath, [join(source, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'studio/ui', '--noEmit'], { cwd: source })
run(process.execPath, ['--test', '--test-concurrency=1', ...pin.editor.upstreamTests], { cwd: source })

/* 4. APEX's editor, with the licenses of what it is made from */
const editor = join(out, 'apex-editor')
build(editor)
const notices = [
  'APEX editor (hc-1188)',
  '',
  `This editor is a modified version of OpenFilm ${pin.package.version} (${pin.source.repository.replace(/\.git$/, '')}, tag ${pin.source.tag}), used under the MIT License below. It is not the OpenFilm product. ApexNodes' changes are in scripts/media-tools/openfilm of https://github.com/karlligamesvc-spec/hermes-agent.`,
  '',
  `本编辑器基于 OpenFilm ${pin.package.version} 修改，按下列 MIT 许可使用，并非 OpenFilm 官方产品。`,
  '',
  readFileSync(join(source, 'LICENSE'), 'utf8').trim(),
  '',
  readFileSync(join(source, 'THIRD_PARTY_NOTICES.md'), 'utf8').trim(),
  ''
].join('\n')
writeFileSync(join(editor, 'assets', 'apex-notices.txt'), notices)
console.log(`APEX's editor built: ${Object.keys(files(editor)).length} files in ${editor}`)

/* 5. the guards, and each part of the patch taken out turning one red */
const env = { ...process.env, APEX_EDITOR: editor, APEX_EDITOR_SOURCE: source, OPENFILM_PACKAGE: pkg }
run(process.execPath, ['--test', '--test-concurrency=1', ...pin.editor.guards.map(g => join(here, '..', g))], { env })
run(process.execPath, [join(here, 'reverse-verify-editor.mjs')], { env })
console.log("APEX's editor is verified")
