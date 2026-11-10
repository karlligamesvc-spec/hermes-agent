import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// hc-1204: a release publishes the bytes that were accepted, not a rebuild of them.
//
// desktop-release.yml dispatched with candidate_run_id skips both builds, and each
// platform's publish job downloads that candidate run's installer artifact instead.
// This module is the gate in front of the upload:
//   candidate  the run is a desktop-release.yml dispatch of this exact commit in this
//              repository and it succeeded; the platform's build job and the steps
//              that prove notarization or PE identity passed; its installer artifact
//              is still kept (3 days).
//   bundle     the downloaded directory holds exactly the files the updater feed
//              names, their blockmaps and the feed, and every named file matches the
//              feed's size and sha512.
// Node built-ins only: the publish jobs run it without npm ci.

export const RELEASE_WORKFLOW_PATH = '.github/workflows/desktop-release.yml'

// Job and step names are the ones the jobs API reports for a desktop-release.yml run
// ("<caller job name> / <reusable job name>"). desktop-macos-workflow.test.cjs reads
// them back from the workflow files, so a rename cannot leave this gate behind.
export const PLATFORMS = Object.freeze({
  'mac-arm64': Object.freeze({
    artifact: 'apexnodes-desktop-macos-arm64',
    buildJob: 'Build macOS arm64 / APEX macOS installer (arm64, signed)',
    proofSteps: Object.freeze(['Gatekeeper assessment (fails if not notarized)', 'Upload installer artifact']),
    feed: 'latest-mac.yml',
    feedFiles: version => [`APEX-${version}-mac-arm64.zip`, `APEX-${version}-mac-arm64.dmg`],
    primary: version => `APEX-${version}-mac-arm64.zip`,
    unpublished: () => []
  }),
  'win-x64': Object.freeze({
    artifact: 'apexnodes-desktop-windows',
    buildJob: 'Build Windows x64 / ApexNodes Windows installer (x64, unsigned)',
    proofSteps: Object.freeze(['Assert packaged APEX PE identity', 'Upload installer artifact']),
    feed: 'latest.yml',
    feedFiles: version => [`APEX-${version}-win-x64.exe`],
    primary: version => `APEX-${version}-win-x64.exe`,
    // Built and kept in the artifact for diagnosis; the publish job never uploads it.
    unpublished: version => [`APEX-${version}-win-x64.msi`]
  })
})

const RUN_ID = /^[1-9][0-9]{0,19}$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function platformSpec(platform) {
  assert.ok(Object.hasOwn(PLATFORMS, platform), `unknown release platform: ${platform}`)
  return PLATFORMS[platform]
}

export function verifyCandidateRun({ run, jobs, artifacts, repository, sha, currentRunId, platforms }) {
  assert.ok(platforms.length > 0, 'no release platform to verify')
  const id = run?.id
  assert.equal(run?.path, RELEASE_WORKFLOW_PATH,
    `candidate run ${id} is not a ${RELEASE_WORKFLOW_PATH} run (${run?.path}); a single-platform dispatch is artifact-only`)
  assert.equal(run.repository?.full_name, repository, `candidate run ${id} belongs to ${run.repository?.full_name}`)
  assert.equal(run.head_repository?.full_name, repository, `candidate run ${id} built code from ${run.head_repository?.full_name}`)
  assert.equal(run.event, 'workflow_dispatch', `candidate run ${id} was triggered by ${run.event}`)
  assert.notEqual(String(id), String(currentRunId), 'a release run cannot promote itself')
  assert.equal(run.head_sha, sha,
    `candidate run ${id} built ${run.head_sha}, but this release is at ${sha}; promote only a candidate of this exact commit`)
  assert.equal(run.status, 'completed', `candidate run ${id} is ${run.status}`)
  assert.equal(run.conclusion, 'success', `candidate run ${id} concluded ${run.conclusion}`)

  const verified = []
  for (const platform of platforms) {
    const spec = platformSpec(platform)
    const builds = jobs.filter(job => job.name === spec.buildJob)
    assert.equal(builds.length, 1,
      `candidate run ${id} has ${builds.length} "${spec.buildJob}" job(s)${platform === 'win-x64' ? '; dispatch the candidate with windows=true' : ''}`)
    assert.equal(builds[0].conclusion, 'success', `candidate job "${spec.buildJob}" concluded ${builds[0].conclusion}`)
    for (const name of spec.proofSteps) {
      const steps = (builds[0].steps ?? []).filter(step => step.name === name)
      assert.equal(steps.length, 1, `candidate job "${spec.buildJob}" has ${steps.length} "${name}" step(s)`)
      assert.equal(steps[0].conclusion, 'success', `candidate step "${name}" concluded ${steps[0].conclusion}`)
    }
    const kept = artifacts.filter(artifact => artifact.name === spec.artifact)
    assert.equal(kept.length, 1, `candidate run ${id} has ${kept.length} "${spec.artifact}" artifact(s)`)
    assert.equal(kept[0].expired, false,
      `candidate artifact ${spec.artifact} expired at ${kept[0].expires_at} (kept 3 days); cut a new candidate`)
    assert.equal(kept[0].workflow_run?.head_sha, sha, `candidate artifact ${spec.artifact} was built from ${kept[0].workflow_run?.head_sha}`)
    verified.push({ platform, artifactId: kept[0].id })
  }
  return { sourceSha: run.head_sha, verified }
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28'
    }
  })
  assert.equal(response.status, 200, `GitHub API ${new URL(url).pathname} returned HTTP ${response.status}`)
  return response.json()
}

export async function fetchCandidateRun({ api, token, repository, runId, fetchImpl = fetch }) {
  assert.match(String(runId), RUN_ID, `invalid candidate run id: ${JSON.stringify(runId)}`)
  assert.ok(token, 'GITHUB_TOKEN is required to read the candidate run')
  const base = `${api}/repos/${repository}/actions/runs/${runId}`
  // filter=latest: a "rerun failed jobs" attempt reports the jobs it carried over too.
  const [run, jobs, artifacts] = await Promise.all([
    githubJson(base, token, fetchImpl),
    githubJson(`${base}/jobs?filter=latest&per_page=100`, token, fetchImpl),
    githubJson(`${base}/artifacts?per_page=100`, token, fetchImpl)
  ])
  return { run, jobs: jobs.jobs ?? [], artifacts: artifacts.artifacts ?? [] }
}

const TOP_KEY = /^([A-Za-z]\w*):(?: +(.*))?$/
const LIST_ITEM = /^ {2}- ([A-Za-z]\w*):(?: +(.*))?$/
const ITEM_KEY = /^ {4}([A-Za-z]\w*):(?: +(.*))?$/

function scalar(value = '') {
  const text = value.trim()
  const quoted = /^'(.*)'$/.exec(text) ?? /^"(.*)"$/.exec(text)
  return quoted ? quoted[1] : text
}

// electron-builder's feed (latest-mac.yml / latest.yml): top-level scalars plus one
// `files:` list of url/sha512/size maps. Anything else is refused, not skipped.
export function parseUpdaterFeed(text) {
  const top = new Map()
  const files = []
  let inFiles = false
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') continue
    let match = TOP_KEY.exec(line)
    if (match) {
      assert.ok(!top.has(match[1]), `updater feed repeats ${match[1]}`)
      top.set(match[1], scalar(match[2]))
      inFiles = match[1] === 'files' && scalar(match[2]) === ''
      continue
    }
    match = inFiles ? LIST_ITEM.exec(line) : null
    if (match) {
      files.push({ [match[1]]: scalar(match[2]) })
      continue
    }
    match = inFiles && files.length > 0 ? ITEM_KEY.exec(line) : null
    if (match) {
      assert.ok(!Object.hasOwn(files.at(-1), match[1]), `updater feed file repeats ${match[1]}`)
      files.at(-1)[match[1]] = scalar(match[2])
      continue
    }
    throw new Error(`unexpected updater feed line: ${JSON.stringify(line)}`)
  }
  for (const key of ['version', 'path', 'sha512']) assert.ok(top.get(key), `updater feed has no ${key}`)
  assert.ok(files.length > 0, 'updater feed lists no files')
  return {
    version: top.get('version'),
    path: top.get('path'),
    sha512: top.get('sha512'),
    files: files.map(file => {
      assert.ok(file.url && !/[\\/]/.test(file.url) && file.url !== '..', `unsafe updater file url: ${file.url}`)
      assert.ok(file.sha512, `updater feed file ${file.url} has no sha512`)
      assert.match(file.size ?? '', /^[1-9][0-9]*$/, `updater feed file ${file.url} has no size`)
      return { url: file.url, sha512: file.sha512, size: Number(file.size) }
    })
  }
}

async function sha512Base64(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

export async function verifyReleaseBundle({ dir, platform, expectedVersion }) {
  const spec = platformSpec(platform)
  assert.match(expectedVersion, VERSION, `invalid expected version: ${expectedVersion}`)
  const feed = parseUpdaterFeed(readFileSync(path.join(dir, spec.feed), 'utf8'))
  assert.equal(feed.version, expectedVersion, `${spec.feed} is ${feed.version}, expected ${expectedVersion}`)
  const named = feed.files.map(file => file.url)
  assert.deepEqual([...named].sort(), [...spec.feedFiles(expectedVersion)].sort(), `${spec.feed} names ${named.join(', ')}`)
  assert.equal(feed.path, spec.primary(expectedVersion), `${spec.feed} points the updater at ${feed.path}`)
  assert.equal(feed.sha512, feed.files.find(file => file.url === feed.path).sha512, `${spec.feed} top-level sha512 is not ${feed.path}'s`)

  // The updater downloads the primary file by changed blocks (hc-1058), so its
  // blockmap is required; electron-builder writes one for every feed file.
  const present = readdirSync(dir).sort()
  const required = [spec.feed, ...named, `${feed.path}.blockmap`]
  const allowed = new Set([...required, ...named.map(name => `${name}.blockmap`), ...spec.unpublished(expectedVersion)])
  const missing = required.filter(name => !present.includes(name))
  assert.deepEqual(missing, [], `release bundle is missing ${missing.join(', ')}`)
  const unexpected = present.filter(name => !allowed.has(name))
  assert.deepEqual(unexpected, [], `release bundle holds files its feed does not name: ${unexpected.join(', ')}`)
  for (const name of present) {
    const stat = lstatSync(path.join(dir, name))
    assert.ok(stat.isFile() && stat.size > 0, `release bundle entry ${name} is not a non-empty regular file`)
  }
  for (const file of feed.files) {
    const local = path.join(dir, file.url)
    assert.equal(lstatSync(local).size, file.size, `${file.url} is ${lstatSync(local).size} bytes, ${spec.feed} says ${file.size}`)
    assert.equal(await sha512Base64(local), file.sha512, `${file.url} does not match its sha512 in ${spec.feed}`)
  }
  return { version: feed.version, files: present }
}

const COMMANDS = {
  candidate: { values: ['--run-id'], repeated: ['--platform'] },
  bundle: { values: ['--dir', '--platform', '--expected-version'], repeated: [] }
}

function optionKey(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

// Strict, like verify-cross-platform-release.mjs: a misspelt flag fails the release.
export function parseArgs(argv) {
  const [command, ...rest] = argv
  assert.ok(Object.hasOwn(COMMANDS, command), `usage: release-candidate-promotion.mjs candidate|bundle ... (got ${command})`)
  const { values, repeated } = COMMANDS[command]
  const options = { command, platforms: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (!values.includes(flag) && !repeated.includes(flag)) throw new Error(`unknown argument: ${flag}`)
    if (index + 1 >= rest.length) throw new Error(`missing value for ${flag}`)
    const value = String(rest[++index]).trim()
    if (repeated.includes(flag)) {
      if (options.platforms.includes(value)) throw new Error(`repeated ${flag} ${value}`)
      options.platforms.push(value)
    } else {
      if (Object.hasOwn(options, optionKey(flag))) throw new Error(`repeated argument: ${flag}`)
      options[optionKey(flag)] = value
    }
  }
  for (const flag of values) if (!options[optionKey(flag)]) throw new Error(`missing ${flag}`)
  if (command === 'candidate') {
    if (options.platforms.length === 0) throw new Error('missing --platform')
    options.platforms.forEach(platformSpec)
  } else {
    platformSpec(options.platform)
  }
  return options
}

function requiredEnv(name) {
  const value = process.env[name]
  assert.ok(value, `${name} is not set`)
  return value
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'candidate') {
    const repository = requiredEnv('GITHUB_REPOSITORY')
    const fetched = await fetchCandidateRun({
      api: process.env.GITHUB_API_URL || 'https://api.github.com',
      token: requiredEnv('GITHUB_TOKEN'),
      repository,
      runId: options.runId
    })
    const result = verifyCandidateRun({
      ...fetched,
      repository,
      sha: requiredEnv('GITHUB_SHA'),
      currentRunId: requiredEnv('GITHUB_RUN_ID'),
      platforms: options.platforms
    })
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verified=true\nsource_sha=${result.sourceSha}\n`)
    for (const { platform, artifactId } of result.verified) {
      console.log(`candidate run ${options.runId} OK for ${platform}: ${result.sourceSha}, artifact ${artifactId}`)
    }
  } else {
    const result = await verifyReleaseBundle({ dir: options.dir, platform: options.platform, expectedVersion: options.expectedVersion })
    console.log(`release bundle OK (${options.platform} ${result.version}): ${result.files.join(', ')}`)
  }
}
