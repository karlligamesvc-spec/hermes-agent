import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { verifyBundle } from '../../../scripts/build-runtime-bundle.mjs'

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

test('bounded verifier hashes complete files across buffer boundaries and rejects corruption, absence and index tampering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-verify-'))
  try {
    fs.mkdirSync(path.join(root, '.runtime'))
    const files = new Map<string, Buffer>([
      ['empty', Buffer.alloc(0)], ['small', Buffer.from('original')],
      ['large', Buffer.alloc(768 * 1024 + 37, 0xab)], ['mutable', Buffer.from('build path')]
    ])
    for (const [name, bytes] of files) {fs.writeFileSync(path.join(root, name), bytes)}
    const index = [...files].map(([name, bytes]) => `${name}\tfile\t${bytes.length}\t${sha(bytes)}`).join('\n') + '\n'
    fs.writeFileSync(path.join(root, '.runtime/files.tsv'), index)
    fs.writeFileSync(path.join(root, '.bundle-manifest.json'), JSON.stringify({ fixup: { mutates: ['mutable'] }, files_index: { sha256: sha(index) } }))
    fs.writeFileSync(path.join(root, 'mutable'), 'relocated path')
    assert.equal((await verifyBundle(root)).checked, 3)
    const corrupted = Buffer.from(files.get('large')!)
    corrupted[corrupted.length - 1] ^= 1
    fs.writeFileSync(path.join(root, 'large'), corrupted)
    fs.rmSync(path.join(root, 'small'))
    await assert.rejects(verifyBundle(root), /2 of 3 entries mismatched: large, small/)
    fs.appendFileSync(path.join(root, '.runtime/files.tsv'), 'forged\tfile\t0\t0\n')
    await assert.rejects(verifyBundle(root), /files.tsv does not match/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
