import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  fetchCandidateRun,
  parseArgs,
  parseUpdaterFeed,
  PLATFORMS,
  RELEASE_WORKFLOW_PATH,
  verifyCandidateRun,
  verifyReleaseBundle
} from './release-candidate-promotion.mjs'

const SCRIPT = fileURLToPath(new URL('./release-candidate-promotion.mjs', import.meta.url))
const REPO = 'karlligamesvc-spec/hermes-agent'
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

function candidate() {
  const run = {
    id: 42570408228,
    path: RELEASE_WORKFLOW_PATH,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    event: 'workflow_dispatch',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success'
  }
  const job = (name, steps) => ({ name, conclusion: 'success', steps: steps.map(step => ({ name: step, conclusion: 'success' })) })
  const jobs = [
    job('Build macOS arm64 / Release preflight (shell↔engine contract)', ['Assert shell↔engine release contract']),
    job(PLATFORMS['mac-arm64'].buildJob, ['Checkout', ...PLATFORMS['mac-arm64'].proofSteps]),
    job(PLATFORMS['win-x64'].buildJob, ['Checkout', ...PLATFORMS['win-x64'].proofSteps]),
    job('Verify same SHA/version and public feeds', ['Checkout'])
  ]
  const artifact = (id, name) => ({ id, name, expired: false, expires_at: '2026-11-12T09:43:26Z', workflow_run: { id: run.id, head_sha: SHA } })
  const artifacts = [
    artifact(1, 'bundled-engine-proof-mac-arm64'),
    artifact(2, PLATFORMS['mac-arm64'].artifact),
    artifact(3, PLATFORMS['win-x64'].artifact)
  ]
  return { run, jobs, artifacts, repository: REPO, sha: SHA, currentRunId: '42605604399', platforms: ['mac-arm64', 'win-x64'] }
}

function stepOf(input, jobName, stepName) {
  return input.jobs.find(job => job.name === jobName).steps.find(step => step.name === stepName)
}

test('a desktop-release.yml candidate of this commit with every requested platform is promotable', () => {
  assert.deepEqual(verifyCandidateRun(candidate()), {
    sourceSha: SHA,
    verified: [{ platform: 'mac-arm64', artifactId: 2 }, { platform: 'win-x64', artifactId: 3 }]
  })
  const macOnly = candidate()
  macOnly.platforms = ['mac-arm64']
  macOnly.jobs = macOnly.jobs.filter(job => job.name !== PLATFORMS['win-x64'].buildJob)
  macOnly.artifacts = macOnly.artifacts.filter(artifact => artifact.name !== PLATFORMS['win-x64'].artifact)
  assert.deepEqual(verifyCandidateRun(macOnly).verified, [{ platform: 'mac-arm64', artifactId: 2 }])
})

test('a candidate that is not this release commit, not a release run, or not finished is refused', () => {
  const mac = PLATFORMS['mac-arm64']
  const win = PLATFORMS['win-x64']
  for (const [label, mutate, message] of [
    ['a direct desktop-macos.yml dispatch', input => { input.run.path = '.github/workflows/desktop-macos.yml' }, /single-platform dispatch is artifact-only/],
    ['another repository', input => { input.run.repository.full_name = 'someone/hermes-agent' }, /belongs to someone\/hermes-agent/],
    ['code from a fork', input => { input.run.head_repository.full_name = 'someone/hermes-agent' }, /built code from someone\/hermes-agent/],
    ['a push-triggered run', input => { input.run.event = 'push' }, /triggered by push/],
    ['the release run itself', input => { input.currentRunId = String(input.run.id) }, /cannot promote itself/],
    ['another commit', input => { input.run.head_sha = OTHER_SHA }, /only a candidate of this exact commit/],
    ['a run still going', input => { input.run.status = 'in_progress' }, /is in_progress/],
    ['a failed run', input => { input.run.conclusion = 'failure' }, /concluded failure/],
    ['a Mac-only candidate for a Windows release', input => { input.jobs = input.jobs.filter(job => job.name !== win.buildJob) }, /0 "Build Windows x64 .*windows=true/],
    ['a failed Mac build job', input => { input.jobs.find(job => job.name === mac.buildJob).conclusion = 'failure' }, /concluded failure/],
    ['a skipped Gatekeeper assessment', input => { stepOf(input, mac.buildJob, mac.proofSteps[0]).conclusion = 'skipped' }, /Gatekeeper assessment .* concluded skipped/],
    ['no PE identity proof', input => {
      const job = input.jobs.find(item => item.name === win.buildJob)
      job.steps = job.steps.filter(step => step.name !== 'Assert packaged APEX PE identity')
    }, /0 "Assert packaged APEX PE identity" step/],
    ['no Mac installer artifact', input => { input.artifacts = input.artifacts.filter(item => item.name !== mac.artifact) }, /0 "apexnodes-desktop-macos-arm64" artifact/],
    ['two Mac installer artifacts', input => { input.artifacts.push({ ...input.artifacts[1], id: 9 }) }, /2 "apexnodes-desktop-macos-arm64" artifact/],
    ['an expired artifact', input => { input.artifacts[2].expired = true }, /expired at .*cut a new candidate/],
    ['an artifact of another commit', input => { input.artifacts[1].workflow_run.head_sha = OTHER_SHA }, /was built from b{40}/],
    ['an unknown platform', input => { input.platforms = ['mac-x64'] }, /unknown release platform: mac-x64/],
    ['no platform', input => { input.platforms = [] }, /no release platform/]
  ]) {
    const input = candidate()
    mutate(input)
    assert.throws(() => verifyCandidateRun(input), message, label)
  }
})

test('the candidate is read from the run, its latest jobs and its artifacts with the workflow token', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.authorization])
    const body = url.includes('/jobs') ? { jobs: [{ name: 'j' }] } : url.includes('/artifacts') ? { artifacts: [{ name: 'a' }] } : { id: 7 }
    return { status: 200, json: async () => body }
  }
  const fetched = await fetchCandidateRun({ api: 'https://api.example', token: 'tkn', repository: REPO, runId: '42570408228', fetchImpl })
  assert.deepEqual(fetched, { run: { id: 7 }, jobs: [{ name: 'j' }], artifacts: [{ name: 'a' }] })
  assert.deepEqual(seen.map(([url]) => url).sort(), [
    `https://api.example/repos/${REPO}/actions/runs/42570408228`,
    `https://api.example/repos/${REPO}/actions/runs/42570408228/artifacts?per_page=100`,
    `https://api.example/repos/${REPO}/actions/runs/42570408228/jobs?filter=latest&per_page=100`
  ])
  assert.ok(seen.every(([, auth]) => auth === 'Bearer tkn'))

  for (const runId of ['', '0', '0123', '12 34', '1;id', '12345678901234567890123']) {
    await assert.rejects(fetchCandidateRun({ api: 'https://api.example', token: 'tkn', repository: REPO, runId, fetchImpl }), /invalid candidate run id/)
  }
  await assert.rejects(fetchCandidateRun({ api: 'https://api.example', token: '', repository: REPO, runId: '1', fetchImpl }), /GITHUB_TOKEN/)
  const notFound = async () => ({ status: 404, json: async () => ({}) })
  await assert.rejects(fetchCandidateRun({ api: 'https://api.example', token: 'tkn', repository: REPO, runId: '1', fetchImpl: notFound }), /HTTP 404/)
})

// Verbatim from desktop/mac-arm64/latest-mac.yml (0.17.75) and desktop/win-x64/latest.yml (0.17.73).
const MAC_FEED_0_17_75 = `version: 0.17.75
files:
  - url: APEX-0.17.75-mac-arm64.zip
    sha512: zq5LCW73IHtedGTRzqRTX8AF20Z4b2yKKoFJu1Y+yN2XJOPrOE5UOYyOi+F3SnvzvfPtXaTpLsJFGrqsvkS7jA==
    size: 516468330
  - url: APEX-0.17.75-mac-arm64.dmg
    sha512: IEHQoFJMjoMUWBVdlP+ERl3Hx/Dukqwj6dQWhNLXSHfZbrE4rVlzQiF5EqBYRQIpsUlG8bwmv5ERfzNjmHE+tw==
    size: 518633778
path: APEX-0.17.75-mac-arm64.zip
sha512: zq5LCW73IHtedGTRzqRTX8AF20Z4b2yKKoFJu1Y+yN2XJOPrOE5UOYyOi+F3SnvzvfPtXaTpLsJFGrqsvkS7jA==
releaseDate: '2026-11-09T11:32:47.240Z'
`
const WIN_FEED_0_17_73 = `version: 0.17.73
files:
  - url: APEX-0.17.73-win-x64.exe
    sha512: bizmE8GDgoJA32rRjmDGqBipG0XLMvKZR/J2kOUPQQTv13CrSnzrn9jRXxWDwSU9n1LQvo+ty2Ml2lSzrsl2Qw==
    size: 634228268
path: APEX-0.17.73-win-x64.exe
sha512: bizmE8GDgoJA32rRjmDGqBipG0XLMvKZR/J2kOUPQQTv13CrSnzrn9jRXxWDwSU9n1LQvo+ty2Ml2lSzrsl2Qw==
releaseDate: '2026-11-08T13:05:00.079Z'
`

test('parseUpdaterFeed reads the feeds electron-builder actually published', () => {
  assert.deepEqual(parseUpdaterFeed(MAC_FEED_0_17_75), {
    version: '0.17.75',
    path: 'APEX-0.17.75-mac-arm64.zip',
    sha512: 'zq5LCW73IHtedGTRzqRTX8AF20Z4b2yKKoFJu1Y+yN2XJOPrOE5UOYyOi+F3SnvzvfPtXaTpLsJFGrqsvkS7jA==',
    files: [
      { url: 'APEX-0.17.75-mac-arm64.zip', sha512: 'zq5LCW73IHtedGTRzqRTX8AF20Z4b2yKKoFJu1Y+yN2XJOPrOE5UOYyOi+F3SnvzvfPtXaTpLsJFGrqsvkS7jA==', size: 516468330 },
      { url: 'APEX-0.17.75-mac-arm64.dmg', sha512: 'IEHQoFJMjoMUWBVdlP+ERl3Hx/Dukqwj6dQWhNLXSHfZbrE4rVlzQiF5EqBYRQIpsUlG8bwmv5ERfzNjmHE+tw==', size: 518633778 }
    ]
  })
  assert.equal(parseUpdaterFeed(WIN_FEED_0_17_73.replaceAll('\n', '\r\n')).files[0].size, 634228268)
})

test('parseUpdaterFeed refuses a feed it cannot read exactly', () => {
  for (const [label, text, message] of [
    ['no version', MAC_FEED_0_17_75.replace(/^version: .*\n/m, ''), /no version/],
    ['no path', MAC_FEED_0_17_75.replace(/^path: .*\n/m, ''), /no path/],
    ['no top-level sha512', MAC_FEED_0_17_75.replace(/^sha512: .*\n/m, ''), /no sha512/],
    ['no files', 'version: 1.0.0\npath: a.zip\nsha512: x\n', /lists no files/],
    ['a repeated key', `${MAC_FEED_0_17_75}version: 0.17.74\n`, /repeats version/],
    ['a file without size', MAC_FEED_0_17_75.replace('    size: 516468330\n', ''), /has no size/],
    ['a repeated file key', MAC_FEED_0_17_75.replace('    size: 516468330\n', '    size: 516468330\n    size: 1\n'), /file repeats size/],
    ['a nested path', MAC_FEED_0_17_75.replace('  - url: APEX-0.17.75-mac-arm64.dmg', '  - url: ../APEX-0.17.75-mac-arm64.dmg'), /unsafe updater file url/],
    ['a tab-indented line', MAC_FEED_0_17_75.replace('    size: 518633778', '\tsize: 518633778'), /unexpected updater feed line/],
    ['a deeper key', MAC_FEED_0_17_75.replace('    size: 518633778', '    size: 518633778\n      extra: 1'), /unexpected updater feed line/],
    ['an item outside files', `${WIN_FEED_0_17_73}  - url: other.exe\n`, /unexpected updater feed line/]
  ]) {
    assert.throws(() => parseUpdaterFeed(text), message, label)
  }
})

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

function writeBundle(platform, version, { feedFiles, extra = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-bundle-'))
  const spec = PLATFORMS[platform]
  const names = feedFiles ?? spec.feedFiles(version)
  const entries = names.map(name => {
    const bytes = randomBytes(4096 + names.indexOf(name))
    fs.writeFileSync(path.join(dir, name), bytes)
    fs.writeFileSync(path.join(dir, `${name}.blockmap`), randomBytes(64))
    return { name, sha512: sha512(bytes), size: bytes.length }
  })
  const primary = entries.find(entry => entry.name === spec.primary(version)) ?? entries[0]
  const feed = [`version: ${version}`, 'files:']
  for (const entry of entries) feed.push(`  - url: ${entry.name}`, `    sha512: ${entry.sha512}`, `    size: ${entry.size}`)
  feed.push(`path: ${primary.name}`, `sha512: ${primary.sha512}`, "releaseDate: '2026-11-09T11:32:47.240Z'", '')
  fs.writeFileSync(path.join(dir, spec.feed), feed.join('\n'))
  for (const name of extra) fs.writeFileSync(path.join(dir, name), 'diagnostic copy')
  return dir
}

test('a bundle that is exactly its feed, blockmaps included, verifies on both platforms', async t => {
  const mac = writeBundle('mac-arm64', '0.17.76')
  const win = writeBundle('win-x64', '0.17.76', { extra: ['APEX-0.17.76-win-x64.msi'] })
  t.after(() => { for (const dir of [mac, win]) fs.rmSync(dir, { recursive: true, force: true }) })

  assert.deepEqual(await verifyReleaseBundle({ dir: mac, platform: 'mac-arm64', expectedVersion: '0.17.76' }), {
    version: '0.17.76',
    files: [
      'APEX-0.17.76-mac-arm64.dmg',
      'APEX-0.17.76-mac-arm64.dmg.blockmap',
      'APEX-0.17.76-mac-arm64.zip',
      'APEX-0.17.76-mac-arm64.zip.blockmap',
      'latest-mac.yml'
    ]
  })
  assert.deepEqual((await verifyReleaseBundle({ dir: win, platform: 'win-x64', expectedVersion: '0.17.76' })).files, [
    'APEX-0.17.76-win-x64.exe',
    'APEX-0.17.76-win-x64.exe.blockmap',
    'APEX-0.17.76-win-x64.msi',
    'latest.yml'
  ])
  // Only the primary file's blockmap is required; the updater never reads the DMG's.
  fs.rmSync(path.join(mac, 'APEX-0.17.76-mac-arm64.dmg.blockmap'))
  await verifyReleaseBundle({ dir: mac, platform: 'mac-arm64', expectedVersion: '0.17.76' })
})

test('a bundle that differs from its feed in any way is refused before upload', async () => {
  const feedPath = dir => path.join(dir, 'latest-mac.yml')
  const rewriteFeed = (dir, from, to) => {
    const text = fs.readFileSync(feedPath(dir), 'utf8')
    assert.equal(text.split(from).length, 2, `fixture anchor must match once: ${from}`)
    fs.writeFileSync(feedPath(dir), text.replace(from, to))
  }
  const zip = 'APEX-0.17.76-mac-arm64.zip'
  for (const [label, mutate, message, expectedVersion = '0.17.76'] of [
    ['another version than the package', () => {}, /latest-mac.yml is 0.17.76, expected 0.17.77/, '0.17.77'],
    ['no feed', dir => fs.rmSync(feedPath(dir)), /ENOENT/],
    ['no primary blockmap', dir => fs.rmSync(path.join(dir, `${zip}.blockmap`)), /missing APEX-0.17.76-mac-arm64.zip.blockmap/],
    ['no DMG', dir => fs.rmSync(path.join(dir, 'APEX-0.17.76-mac-arm64.dmg')), /missing APEX-0.17.76-mac-arm64.dmg/],
    ['a stale installer next to the new one', dir => fs.writeFileSync(path.join(dir, 'APEX-0.17.75-mac-arm64.zip'), 'old'), /does not name: APEX-0.17.75-mac-arm64.zip/],
    ['an unpublished Windows MSI in a Mac bundle', dir => fs.writeFileSync(path.join(dir, 'APEX-0.17.76-win-x64.msi'), 'x'), /does not name: APEX-0.17.76-win-x64.msi/],
    ['an empty blockmap', dir => fs.writeFileSync(path.join(dir, `${zip}.blockmap`), ''), /zip.blockmap is not a non-empty regular file/],
    ['a symlinked installer', dir => {
      fs.renameSync(path.join(dir, zip), path.join(os.tmpdir(), `${path.basename(dir)}-zip`))
      fs.symlinkSync(path.join(os.tmpdir(), `${path.basename(dir)}-zip`), path.join(dir, zip))
    }, /APEX-0.17.76-mac-arm64.zip is not a non-empty regular file/],
    ['a truncated installer', dir => fs.truncateSync(path.join(dir, zip), 100), /is 100 bytes, latest-mac.yml says/],
    ['a same-size installer with other bytes', dir => {
      const bytes = fs.readFileSync(path.join(dir, zip))
      bytes[0] ^= 0xff
      fs.writeFileSync(path.join(dir, zip), bytes)
    }, /zip does not match its sha512/],
    ['the updater pointed at the DMG', dir => rewriteFeed(dir, `path: ${zip}`, 'path: APEX-0.17.76-mac-arm64.dmg'), /points the updater at APEX-0.17.76-mac-arm64.dmg/],
    ['a top-level sha512 of another file', dir => {
      const text = fs.readFileSync(feedPath(dir), 'utf8')
      fs.writeFileSync(feedPath(dir), text.replace(/^sha512: .*$/m, 'sha512: AAAA'))
    }, /top-level sha512 is not/]
  ]) {
    const dir = writeBundle('mac-arm64', '0.17.76')
    try {
      mutate(dir)
      await assert.rejects(verifyReleaseBundle({ dir, platform: 'mac-arm64', expectedVersion }), message, label)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(path.join(os.tmpdir(), `${path.basename(dir)}-zip`), { force: true })
    }
  }

  const extraFeedFile = writeBundle('mac-arm64', '0.17.76', { feedFiles: ['APEX-0.17.76-mac-arm64.zip', 'APEX-0.17.76-mac-arm64.dmg', 'APEX-0.17.76-mac-arm64.pkg'] })
  try {
    await assert.rejects(verifyReleaseBundle({ dir: extraFeedFile, platform: 'mac-arm64', expectedVersion: '0.17.76' }), /latest-mac.yml names .*\.pkg/)
  } finally { fs.rmSync(extraFeedFile, { recursive: true, force: true }) }

  const winWithoutBlockmap = writeBundle('win-x64', '0.17.76')
  try {
    fs.rmSync(path.join(winWithoutBlockmap, 'APEX-0.17.76-win-x64.exe.blockmap'))
    await assert.rejects(verifyReleaseBundle({ dir: winWithoutBlockmap, platform: 'win-x64', expectedVersion: '0.17.76' }), /missing APEX-0.17.76-win-x64.exe.blockmap/)
  } finally { fs.rmSync(winWithoutBlockmap, { recursive: true, force: true }) }
})

test('parseArgs is strict about commands, flags and platforms', () => {
  assert.deepEqual(parseArgs(['candidate', '--run-id', '42', '--platform', 'mac-arm64', '--platform', 'win-x64']), {
    command: 'candidate', runId: '42', platforms: ['mac-arm64', 'win-x64']
  })
  assert.deepEqual(parseArgs(['bundle', '--dir', 'release', '--platform', 'win-x64', '--expected-version', '0.17.76']), {
    command: 'bundle', platforms: [], dir: 'release', platform: 'win-x64', expectedVersion: '0.17.76'
  })
  for (const [argv, message] of [
    [['promote'], /usage/],
    [['candidate', '--run-id', '42'], /missing --platform/],
    [['candidate', '--platform', 'mac-arm64'], /missing --run-id/],
    [['candidate', '--run-id', '42', '--platform', 'mac-arm64', '--platform', 'mac-arm64'], /repeated --platform mac-arm64/],
    [['candidate', '--run-id', '42', '--platfrom', 'mac-arm64'], /unknown argument: --platfrom/],
    [['candidate', '--run-id', '42', '--platform', 'mac-x64'], /unknown release platform/],
    [['candidate', '--run-id'], /missing value for --run-id/],
    [['bundle', '--dir', 'release', '--platform', 'mac-arm64'], /missing --expected-version/],
    [['bundle', '--dir', 'a', '--dir', 'b', '--platform', 'mac-arm64', '--expected-version', '1.0.0'], /repeated argument: --dir/]
  ]) {
    assert.throws(() => parseArgs(argv), message, argv.join(' '))
  }
})

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, NO_PROXY: '127.0.0.1,localhost', ...env } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', status => resolve({ status, output }))
  })
}

test('the CLI verifies a candidate through the GitHub API and records it for the job', async t => {
  const input = candidate()
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push([request.url, request.headers.authorization])
    const url = new URL(request.url, 'http://127.0.0.1')
    const body = url.pathname.endsWith('/jobs') ? { jobs: input.jobs }
      : url.pathname.endsWith('/artifacts') ? { artifacts: input.artifacts }
        : input.run
    response.writeHead(url.pathname.includes(`/runs/${input.run.id}`) ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-cli-')), 'github_output')
  t.after(() => { server.close(); fs.rmSync(path.dirname(output), { recursive: true, force: true }) })
  const env = {
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_TOKEN: 'fixture-token',
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: SHA,
    GITHUB_RUN_ID: '42605604399',
    GITHUB_OUTPUT: output
  }

  const ok = await runCli(['candidate', '--run-id', String(input.run.id), '--platform', 'mac-arm64', '--platform', 'win-x64'], env)
  assert.equal(ok.status, 0, ok.output)
  assert.match(ok.output, /candidate run 42570408228 OK for win-x64/)
  assert.equal(fs.readFileSync(output, 'utf8'), `verified=true\nsource_sha=${SHA}\n`)
  assert.ok(requests.every(([, auth]) => auth === 'Bearer fixture-token'))

  fs.rmSync(output)
  const otherCommit = await runCli(['candidate', '--run-id', String(input.run.id), '--platform', 'mac-arm64'], { ...env, GITHUB_SHA: OTHER_SHA })
  assert.notEqual(otherCommit.status, 0)
  assert.match(otherCommit.output, /only a candidate of this exact commit/)
  assert.equal(fs.existsSync(output), false, 'a refused candidate must not report itself verified')

  const noToken = await runCli(['candidate', '--run-id', String(input.run.id), '--platform', 'mac-arm64'], { ...env, GITHUB_TOKEN: '' })
  assert.notEqual(noToken.status, 0)
  assert.match(noToken.output, /GITHUB_TOKEN is not set/)
})

test('the CLI verifies a downloaded bundle and fails on a mismatch', async t => {
  const dir = writeBundle('mac-arm64', '0.17.76')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ok = await runCli(['bundle', '--dir', dir, '--platform', 'mac-arm64', '--expected-version', '0.17.76'], {})
  assert.equal(ok.status, 0, ok.output)
  assert.match(ok.output, /release bundle OK \(mac-arm64 0\.17\.76\)/)
  const wrongVersion = await runCli(['bundle', '--dir', dir, '--platform', 'mac-arm64', '--expected-version', '0.17.75'], {})
  assert.notEqual(wrongVersion.status, 0)
  assert.match(wrongVersion.output, /expected 0\.17\.75/)
})
