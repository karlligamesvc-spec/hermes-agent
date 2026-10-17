import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

import { runBundledTool } from './apex-bundle-tool'

const verifier = fileURLToPath(new URL('../../../scripts/build-runtime-bundle.mjs', import.meta.url))
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

// A bundle of empty named pipes. The verifier's open() of each blocks until a
// writer appears, so the pipes found waiting are the opens it has in flight.
function pipeBundle(count: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-verify-pipes-'))
  fs.mkdirSync(path.join(root, '.runtime'))
  const pipes = Array.from({ length: count }, (_, i) => path.join(root, `pipe-${String(i).padStart(3, '0')}`))
  execFileSync('mkfifo', pipes)
  const index = pipes.map(pipe => `${path.basename(pipe)}\tfile\t0\t${sha('')}`).join('\n') + '\n'
  fs.writeFileSync(path.join(root, '.runtime/files.tsv'), index)
  fs.writeFileSync(path.join(root, '.bundle-manifest.json'), JSON.stringify({ fixup: { mutates: [] }, files_index: { sha256: sha(index) } }))

  return { root, pipes }
}

// Opening a pipe for writing without blocking succeeds only while a reader has it
// open, and lets a waiting open return; closing the writer later gives the read
// EOF. Each round releases the last round's readers, lets the tool block on its
// next opens, then counts the pipes opened for the first time, sweeping from the
// last pipe back: an open the tool starts mid-sweep targets a later pipe, so it
// is counted in the next round, not this one.
async function maxOpensInFlight(pipes: string[], run: Promise<void>) {
  let settled = false
  const outcome = run.then(() => null, (error: unknown) => error).finally(() => { settled = true })
  const writers: number[] = []

  const holdWriter = (pipe: string) => {
    try {
      writers.push(fs.openSync(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK))

      return true
    } catch (error: any) {
      if (error.code === 'ENXIO') {return false}
      throw error
    }
  }

  let waiting = pipes
  let max = 0

  while (!settled) {
    for (const fd of writers.splice(0)) {fs.closeSync(fd)}
    await new Promise(resolve => setTimeout(resolve, 50))

    const found = [...waiting].reverse().filter(holdWriter)
    max = Math.max(max, found.length)
    // Also release, uncounted, any reader back on a pipe already counted (an
    // open restarted after a signal, say), so no reader can be left waiting.
    pipes.filter(pipe => !waiting.includes(pipe)).forEach(holdWriter)
    waiting = waiting.filter(pipe => !found.includes(pipe))
  }

  for (const fd of writers) {fs.closeSync(fd)}
  const error = await outcome

  if (error) {throw error}

  return max
}

test('Desktop runs the bundled verifier with 16 opens in flight', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const { root, pipes } = pipeBundle(96)

  try {
    const inFlight = await maxOpensInFlight(pipes, runBundledTool(process.execPath, [verifier, 'verify', '--root', root], 'verify'))

    // Windows first-boot verify time is the per-open antivirus wait divided by
    // this number (hc-923: 87 s at the default 4, 26 s at 16 on win-5090).
    assert.equal(inFlight, 16)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
