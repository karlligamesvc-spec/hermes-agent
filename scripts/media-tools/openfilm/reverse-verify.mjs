// Reverse check for the OpenFilm patches: each part of the fix, taken back out of a copy of the patched
// package (an exact text that must be found exactly once), has to turn track-fields.test.mjs red, and the copy as
// patched has to pass it.
//   OPENFILM_PACKAGE=<patched openfilm package> node reverse-verify.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pin = JSON.parse(readFileSync(join(here, 'pin.json'), 'utf8'))
const guards = pin.guards.map(g => join(here, g))
const source = process.env.OPENFILM_PACKAGE
if (!source) throw new Error('Set OPENFILM_PACKAGE to the patched openfilm package folder.')

const MERGE = 'studio/server/person-merge.mjs'
/** Each part of the fix taken out, and the guard tests (by a part of their names) that must fail without it. */
export const INJECTIONS = [
  {
    part: 'merge3 keeps caption tracks (tracks with no clips)',
    file: MERGE,
    find: 'tracks.filter((t) => t.clips.length || named.has(t))',
    replace: 'tracks.filter((t) => t.clips.length)',
    fails: ['captions: kept when the agent writes over']
  },
  {
    part: 'a kept version carries the track fields',
    file: MERGE,
    find: 'const values = valuesOf(t);',
    replace: 'const values = NONE;',
    fails: [
      "attrs: kept in the person's film when the merge fails",
      "captions: kept in the person's film when the merge fails"
    ]
  },
  {
    part: 'a version kept beside the one before matches a caption track by its file and fields',
    file: MERGE,
    find: 'was.flags === flags && was.values === values && was.lane === lane && ',
    replace: 'was.flags === flags && ',
    fails: ["each caption track's own <track>"]
  },
  {
    part: 'track fields other than flags merged three ways',
    file: MERGE,
    find: 'for (const f of VALUES) {\n      const got = pick(',
    replace: 'for (const f of /** @type {string[]} */ ([])) {\n      const got = pick(',
    fails: ["attrs: the person's change stands", "captions: the person's change stands"]
  },
  {
    part: 'a caption track only one side has stays as that side has it',
    file: MERGE,
    find: '    if (name && !(LO.has(name) && LW.has(name))) continue;\n',
    replace: '',
    fails: ['captions: a caption track the person changed stays whole']
  },
  {
    part: 'compare sees a caption track only one version has',
    file: MERGE,
    find: 'if (!lanes.has(name) || !theirLanes.has(name)) lone.add(name);',
    replace: 'if (false) lone.add(name);',
    fails: ['a caption track the agent adds or removes', 'compare as their units do: add a caption track']
  },
  {
    part: 'compare sees track fields other than flags',
    file: MERGE,
    find: '  if (a.values !== b.values) {',
    replace: '  if (false) {',
    fails: [
      "attrs: the person's change stands",
      "captions: the person's change stands",
      'compare as their units do: rename a caption track'
    ]
  },
  {
    part: "compare sees a caption track's fields",
    file: MERGE,
    find: '    const fields = fieldsApart(w.tracks[at], tv, tv.lane);',
    replace: '    const fields = /** @type {string[]} */ ([]);',
    fails: ["stays whole when the agent's write drops it", 'compare as their units do: hide a caption track']
  },
  {
    part: "a version's hash covers its track fields (versions are told apart by it)",
    file: MERGE,
    find: "${t.values === NONE ? '' : `${t.values}\\n`}",
    replace: '',
    fails: [
      "attrs: the person's edit of it alone is a version of its own",
      "captions: the person's edit of it alone is a version of its own"
    ]
  },
  {
    part: 'a caption track has units (what notes and distance name)',
    file: MERGE,
    find: '    if (lanes[i]) { out.set(`clip\\0${lanes[i]}`, true); fields(track, lanes[i]); }\n',
    replace: '',
    fails: ['compare as their units do: add a caption track', 'compare as their units do: hide a caption track']
  },
  {
    part: 'caption tracks ranked by their file when the tracks are ordered',
    file: MERGE,
    find: 'const i = name ? lanes.get(name)?.t ?? Infinity :',
    replace: 'const i = name ? Infinity :',
    fails: ['two caption tracks keep their order']
  },
  {
    part: 'the note to the agent names a caption track by its file',
    file: 'studio/server/person-edits.mjs',
    find: "case 'clip': return lane || `clip ${id}`;",
    replace: "case 'clip': return `clip ${id}`;",
    fails: ["stays whole when the agent's write drops it"]
  },
  {
    part: 'headless launches start the Chromium OPENFILM_CHROMIUM names (patch 0002)',
    file: 'src/host.mjs',
    find: ': own ? { executablePath: own } : {}',
    replace: ': {}',
    fails: ['every headless launch starts the Chromium', 'nothing is downloaded in its place']
  },
  {
    part: 'with OPENFILM_HOSTED=1 the CLI never starts, restarts or replaces a Studio (patch 0003)',
    file: 'studio/client.mjs',
    find: "if (process.env.OPENFILM_HOSTED === '1') {",
    replace: 'if (false) {',
    fails: ['starts none and carries on without it', 'never replaced, even when asked for a fresh one']
  }
]

/** Run the guard on `pkg`: the names of the tests that failed, and whether all ran. */
function runGuard(pkg) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...guards], {
    env: { ...process.env, OPENFILM_PACKAGE: pkg },
    encoding: 'utf8',
    timeout: 300_000
  })
  const failed = [...run.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1])
  const total = Number(/^# tests (\d+)$/m.exec(run.stdout)?.[1] ?? 0)
  return { failed, total, code: run.status }
}

/** A copy of the package's code (src/, studio/server/, package.json) to change. */
/* (the package's dependencies, found as it finds them, are linked beside each copy) */
const dependencies = Object.keys(pin.dependencies).map(name => [
  name,
  dirname(createRequire(join(resolve(source), 'package.json')).resolve(`${name}/package.json`))
])
function copy() {
  const root = mkdtempSync(join(tmpdir(), 'apex-openfilm-reverse-'))
  const dir = join(root, 'node_modules', 'openfilm')
  for (const part of ['package.json', 'bin', 'src', 'studio/server', 'studio/client.mjs'])
    if (existsSync(join(resolve(source), part)))
      cpSync(join(resolve(source), part), join(dir, part), { recursive: true })
  for (const [name, at] of dependencies) symlinkSync(at, join(root, 'node_modules', name), 'junction')
  mkdirSync(join(dir, 'library'), { recursive: true })
  return dir
}

const clean = copy()
const baseline = runGuard(clean)
rmSync(join(clean, '..', '..'), { recursive: true, force: true })
assert.equal(baseline.failed.length, 0, `the patched package fails the guard: ${baseline.failed.join(' | ')}`)
assert.ok(baseline.total > 0 && baseline.code === 0, 'the guard ran no tests')
console.log(`patched: all ${baseline.total} guard tests pass`)

let bad = 0
for (const { part, file, find, replace, fails } of INJECTIONS) {
  const dir = copy()
  try {
    const path = join(dir, file)
    const text = readFileSync(path, 'utf8')
    const hits = text.split(find).length - 1
    assert.equal(hits, 1, `"${part}": the text to take out is found ${hits} times in ${file}, not once`)
    writeFileSync(path, text.replace(find, replace))
    const { failed } = runGuard(dir)
    const missing = fails.filter(name => !failed.some(f => f.includes(name)))
    const ok = failed.length > 0 && missing.length === 0
    if (!ok) bad++
    console.log(
      `${ok ? 'red as expected' : 'NOT RED'}: without ${part} -> ${failed.length} fail${failed.length ? `: ${failed.join(' | ')}` : ''}${missing.length ? ` (expected also: ${missing.join(' | ')})` : ''}`
    )
  } finally {
    rmSync(join(dir, '..', '..'), { recursive: true, force: true })
  }
}
assert.equal(bad, 0, `${bad} part(s) of the fix are not guarded`)
console.log(`all ${INJECTIONS.length} parts of the fix are guarded`)
