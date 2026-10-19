import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { BUNDLE_EXCLUDED_PATHS, excludedAgentBrowserBinaries, pruneUnusedRuntimePaths } from '../../../scripts/build-runtime-bundle.mjs'

// hc-951: the engine bundle drops paths no installed engine reads. These tests pin what goes, and
// derive what must stay from the consumers themselves, so widening the list past a reader turns red.
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const AGENT_BROWSER_BUILDS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-musl-arm64', 'linux-musl-x64', 'linux-x64', 'win32-x64.exe']
  .map(build => `agent-browser-${build}`)

const isExcluded = rel => BUNDLE_EXCLUDED_PATHS.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))

function writeTree(root, files) {
  for (const rel of files) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, rel)
  }
}

function listTree(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

// Kept on purpose, each for a named reader (see BUNDLE_EXCLUDED_PATHS).
const KEPT = [
  'website/static/api/model-catalog.json',
  'website/docs/user-guide/features/hooks.md',
  'apps/desktop/package.json',
  'apps/desktop/src/main.tsx',
  'apps/shared/package.json',
  'ui-tui/package.json',
  '.runtime/media/ffmpeg/ffmpeg.source.tar.xz',
  'hermes_cli/main.py',
]
const SOURCE_EXCLUDED = [
  'tests/hermes_cli/test_main.py',
  'contributors/emails/someone@example.com',
  'website/static/img/hermes-agent-banner.png',
  'apps/desktop/docs/qa/hc-820/shot.png',
  'apps/desktop/pr-assets/session-source-folders.png',
]

for (const { os: target, nodeDir, include, ownBuilds } of [
  { os: 'mac', nodeDir: '.runtime/node/lib/node_modules', include: ['.runtime/node/include/node/node.h'], ownBuilds: ['agent-browser-darwin-arm64', 'agent-browser-darwin-x64'] },
  { os: 'win', nodeDir: '.runtime/node/node_modules', include: [], ownBuilds: ['agent-browser-win32-x64.exe'] },
]) {
  test(`a ${target} engine stage loses exactly the audited unused paths`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-bundle-slim-${target}-`))
    const agentBrowser = `${nodeDir}/agent-browser/bin`
    try {
      writeTree(root, [...KEPT, ...SOURCE_EXCLUDED, ...include, `${agentBrowser}/agent-browser.js`,
        ...AGENT_BROWSER_BUILDS.map(build => `${agentBrowser}/${build}`)])

      const removed = pruneUnusedRuntimePaths(root, target)

      const foreign = AGENT_BROWSER_BUILDS.filter(build => !ownBuilds.includes(build)).map(build => `${agentBrowser}/${build}`)
      assert.deepEqual(removed.sort(), [...BUNDLE_EXCLUDED_PATHS.filter(rel => target === 'mac' || !rel.startsWith('.runtime/node/include')), ...foreign].sort())
      assert.deepEqual(listTree(root), [...KEPT, `${agentBrowser}/agent-browser.js`, ...ownBuilds.map(build => `${agentBrowser}/${build}`)].sort())
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('agent-browser keeps every build its launcher can select on the target', () => {
  const names = ['agent-browser.js', '.install-method', ...AGENT_BROWSER_BUILDS]
  assert.deepEqual(names.filter(name => !excludedAgentBrowserBinaries(names, 'mac').includes(name)),
    ['agent-browser.js', '.install-method', 'agent-browser-darwin-arm64', 'agent-browser-darwin-x64'])
  assert.deepEqual(names.filter(name => !excludedAgentBrowserBinaries(names, 'win').includes(name)),
    ['agent-browser.js', '.install-method', 'agent-browser-win32-x64.exe'])
})

test('pruning refuses to ship a link into a pruned tree', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-bundle-slim-link-'))
  try {
    writeTree(root, ['tests/fixtures/sample.json', 'hermes_cli/main.py'])
    fs.symlinkSync('../tests/fixtures', path.join(root, 'hermes_cli', 'fixtures'))
    assert.throws(() => pruneUnusedRuntimePaths(root, 'mac'), /dangling links: hermes_cli\/fixtures/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('every excluded source path still exists, so no entry is dead', () => {
  for (const rel of BUNDLE_EXCLUDED_PATHS.filter(rel => !rel.startsWith('.runtime/'))) {
    assert.ok(fs.existsSync(path.join(repoRoot, ...rel.split('/'))), `${rel} no longer exists; drop it from BUNDLE_EXCLUDED_PATHS`)
  }
})

test('the model catalog seed that hermes reads from the install root stays in the bundle', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'hermes_cli/model_catalog.py'), 'utf8')
  const seeds = [...source.matchAll(/Path\(project_root\)((?:\s*\/\s*"[^"]+")+)/g)]
    .map(match => [...match[1].matchAll(/"([^"]+)"/g)].map(part => part[1]).join('/'))
  assert.ok(seeds.length >= 1, 'model_catalog.py no longer seeds from the install root; update this twin')
  for (const rel of seeds) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), rel)
    assert.ok(!isExcluded(rel), `${rel} is read at runtime but excluded from the bundle`)
  }
})

test('every npm workspace manifest stays, because frontend builds reach their installed-engine refusal through them', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
  const workspaces = Object.values(lock.packages).filter(entry => entry.link).map(entry => entry.resolved)
  assert.ok(workspaces.includes('ui-tui') && workspaces.includes('apps/shared'), 'the lock no longer links the TUI workspaces')
  for (const rel of [...workspaces.map(dir => `${dir}/package.json`), 'package.json', 'package-lock.json']) {
    assert.ok(!isExcluded(rel), `${rel} is excluded, but frontend builds reach their installed-engine refusal through the workspace manifests`)
  }
})

test('documentation that bundled skills cite stays in the bundle', () => {
  const cited = new Set()
  for (const dir of ['skills', 'optional-skills']) {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const text = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
      for (const match of text.matchAll(/\bwebsite\/docs\/[\w./-]*\w/g)) cited.add(match[0])
    }
  }
  assert.ok(cited.size >= 1, 'no skill cites website/docs any more; update this twin')
  for (const rel of cited) assert.ok(!isExcluded(rel), `${rel} is cited by a bundled skill but excluded`)
})

test('no runtime Python package lives under an excluded path', () => {
  const pyproject = fs.readFileSync(path.join(repoRoot, 'pyproject.toml'), 'utf8')
  const find = /\[tool\.setuptools\.packages\.find\]\s*include\s*=\s*\[([^\]]*)\]/.exec(pyproject)
  assert.ok(find, 'pyproject.toml no longer lists its packages; update this twin')
  const packages = [...find[1].matchAll(/"([^"]+)"/g)].map(match => match[1].split('.')[0])
  assert.ok(packages.includes('hermes_cli'))
  for (const name of packages) assert.ok(!isExcluded(name), `${name} is an installed package but excluded`)
})

test('the bundle build installs npm packages only under .runtime prefixes, then prunes before signing', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/build-runtime-bundle.mjs'), 'utf8')
  const start = source.indexOf('async function cmdBuild(args) {')
  const build = source.slice(start, source.indexOf('\n}\n', start)).replace(/^\s*\/\/.*$/gm, '')
  const installs = [...build.matchAll(/\bnpm\(\[([^\]]*)\]/g)].map(match => match[1])
  assert.ok(installs.length >= 2, 'cmdBuild no longer installs agent-browser and Hypit through npm(); update this guard')
  for (const install of installs) assert.match(install, /'--prefix'/, `an npm install into the source tree is back: npm([${install}])`)
  const prune = build.indexOf('pruneUnusedRuntimePaths(stage, target.os)')
  assert.ok(prune > 0, 'cmdBuild no longer prunes unused runtime paths')
  for (const later of ['signMacRuntimePayload(stage', 'writeFilesIndex(stage)']) {
    assert.ok(prune < build.indexOf(later), `pruning must run before ${later}`)
  }
})
