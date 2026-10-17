#!/usr/bin/env node
// bundle-verify-bench.mjs — measure where APEX Desktop's first-boot engine verify
// spends its time (hc-923). Measurement only: it never changes antivirus settings.
//
// Each trial reproduces the packaged first boot on a FRESH directory: extract with
// the same tar Desktop uses (System32 tar.exe on Windows), run the fresh tree's own
// node + tool `fixup`, then time one pass over the still-cold tree and the same
// pass again warm. The trial tree is deleted afterwards.
//
//   node bundle-verify-bench.mjs --archive runtime-bundle-<key>-win-x64.tar.gz --work D:\bench
//     [--threads default,8,16]   libuv pool for the pass (UV_THREADPOOL_SIZE; default = unset)
//     [--pass verify|open|stat|read|hash]   default verify
//     [--verifier path/to/build-runtime-bundle.mjs]   run this verifier instead of the tree's own
//     [--repeat N] [--out results.jsonl]
//
// Passes: verify = the real verifier (`<tool> verify --root`); hash = the same loop
// in this file; read = open + read, no hashing; open = open + close only; stat =
// attribute query only. On Windows each pass also records Microsoft Defender's own
// CPU time (MsMpEng.exe, read-only).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const flags = argv => Object.fromEntries(argv.flatMap((a, i) => a.startsWith('--') ? [[a.slice(2), argv[i + 1]]] : []))

// One pass over `root` in the verifier's loop shape: `inFlight` async loops over
// the files index. Prints a JSON summary with the open() latency distribution.
async function pass({ root, mode, inFlight }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.bundle-manifest.json'), 'utf8'))
  const skip = new Set([...manifest.fixup.mutates, '.runtime/files.tsv', '.bundle-manifest.json'])
  const entries = fs.readFileSync(path.join(root, '.runtime/files.tsv'), 'utf8').split('\n').filter(Boolean)
    .map(line => line.split('\t')).filter(([rel, type]) => type === 'file' && !skip.has(rel))
  const opens = []
  let cursor = 0
  let bad = 0
  const started = performance.now()
  await Promise.all(Array.from({ length: inFlight }, async () => {
    const buffer = Buffer.allocUnsafe(256 * 1024)
    while (cursor < entries.length) {
      const [rel, , size, digest] = entries[cursor++]
      const file = path.join(root, ...rel.split('/'))
      const t0 = performance.now()
      if (mode === 'stat') {
        if ((await fs.promises.stat(file)).size !== Number(size)) bad++
        opens.push(performance.now() - t0)
        continue
      }
      const handle = await fs.promises.open(file, 'r')
      opens.push(performance.now() - t0)
      try {
        const hash = mode === 'hash' ? createHash('sha256') : null
        let bytesRead = mode === 'open' ? 0 : 1
        while (bytesRead) {
          ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null))
          hash?.update(buffer.subarray(0, bytesRead))
        }
        if (hash && hash.digest('hex') !== digest) bad++
      } finally { await handle.close() }
    }
  }))
  opens.sort((a, b) => a - b)
  const ms = q => +opens[Math.floor(q * (opens.length - 1))].toFixed(2)
  console.log(JSON.stringify({ mode, inFlight, files: entries.length, bad, seconds: +((performance.now() - started) / 1000).toFixed(2), openMs: { p50: ms(0.5), p90: ms(0.9), p99: ms(0.99) } }))
  if (bad) process.exitCode = 2
}

function defenderCpuSeconds() {
  if (process.platform !== 'win32') return null
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process MsMpEng -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds'], { encoding: 'utf8' })
  const value = Number(String(r.stdout).trim().replace(',', '.'))
  return Number.isFinite(value) && String(r.stdout).trim() ? value : null
}

function timed(label, exe, argv, env = process.env) {
  const cpu0 = defenderCpuSeconds()
  const t0 = performance.now()
  const r = spawnSync(exe, argv, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const seconds = +((performance.now() - t0) / 1000).toFixed(2)
  const cpu1 = defenderCpuSeconds()
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/)
  if (r.status !== 0) throw new Error(`${label} exited ${r.status}: ${output.slice(-3).join(' | ')}`)
  return { label, seconds, defenderCpuS: cpu0 === null || cpu1 === null ? null : +(cpu1 - cpu0).toFixed(2), last: output.at(-1).slice(0, 300) }
}

function trial({ archive, work, threads, passName, verifier }) {
  // Build output names it <archive base>.manifest.json; an installed app's resources name it manifest.json.
  const sibling = archive.replace(/\.tar\.gz$/, '.manifest.json')
  const manifest = JSON.parse(fs.readFileSync(fs.existsSync(sibling) ? sibling : path.join(path.dirname(archive), 'manifest.json'), 'utf8'))
  const trialRoot = fs.mkdtempSync(path.join(work, 'trial-'))
  const stage = path.join(trialRoot, `${manifest.key}.tmp`)
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const node = path.join(stage, '.runtime', 'node', ...(manifest.os === 'win' ? ['node.exe'] : ['bin', 'node']))
  const tool = path.join(stage, ...manifest.fixup.script.split('/'))
  // Unset means libuv's default pool (4). An EMPTY value would mean 1 thread.
  const env = { ...process.env }
  if (threads === 'default') delete env.UV_THREADPOOL_SIZE
  else env.UV_THREADPOOL_SIZE = threads
  const argv = passName === 'verify'
    ? [verifier || tool, 'verify', '--root', stage]
    : [self, 'pass', '--root', stage, '--mode', passName, '--in-flight', threads === 'default' ? '8' : threads]
  const result = { at: new Date().toISOString(), key: manifest.key, threads, pass: passName, verifier: verifier ? 'external' : 'bundled', steps: [] }
  try {
    fs.mkdirSync(stage)
    result.steps.push(timed('extract', tar, ['-xzf', archive, '-C', stage]))
    result.steps.push(timed('fixup', node, [tool, 'fixup', '--root', stage]))
    result.steps.push(timed(`${passName} cold`, node, argv, env))
    result.steps.push(timed(`${passName} warm`, node, argv, env))
  } finally {
    fs.rmSync(trialRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  return result
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'pass') {
  const f = flags(rest)
  await pass({ root: path.resolve(f.root), mode: f.mode, inFlight: Number(f['in-flight']) })
} else {
  const f = flags(process.argv.slice(2))
  if (!f.archive || !f.work) {
    console.error('usage: node bundle-verify-bench.mjs --archive <runtime-bundle-*.tar.gz> --work <dir> [--threads default,16] [--pass verify|open|stat|read|hash] [--verifier <build-runtime-bundle.mjs>] [--repeat N] [--out <jsonl>]')
    process.exit(64)
  }
  fs.mkdirSync(f.work, { recursive: true })
  for (let i = 0; i < Number(f.repeat || 1); i++) {
    for (const threads of (f.threads || 'default').split(',')) {
      const result = trial({ archive: path.resolve(f.archive), work: path.resolve(f.work), threads, passName: f.pass || 'verify', verifier: f.verifier && path.resolve(f.verifier) })
      const line = JSON.stringify(result)
      console.log(line)
      if (f.out) fs.appendFileSync(f.out, line + '\n')
    }
  }
}
