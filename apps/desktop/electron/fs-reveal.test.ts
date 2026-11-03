import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { revealInFileManager } from './fs-reveal'

const identity = (value: string) => value

test('reveals a file that exists, and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-reveal-'))
  const file = path.join(dir, '成片.mp4')
  fs.writeFileSync(file, 'x')
  const shown: string[] = []

  try {
    assert.equal(await revealInFileManager(file, identity, target => shown.push(target)), true)
    assert.deepEqual(shown, [file])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file opens nothing and returns false', async () => {
  const shown: string[] = []

  assert.equal(await revealInFileManager('/no/such/成片.mp4', identity, target => shown.push(target)), false)
  assert.deepEqual(shown, [])
})

test('a ~/ path reaches the file manager expanded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-reveal-'))
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'x')
  const shown: string[] = []

  try {
    assert.equal(
      await revealInFileManager(
        '~/a.txt',
        () => file,
        target => shown.push(target)
      ),
      true
    )
    assert.deepEqual(shown, [file])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty path is refused without touching the disk', async () => {
  assert.equal(await revealInFileManager('  ', identity, () => assert.fail('nothing to show')), false)
  assert.equal(await revealInFileManager(undefined, identity, () => assert.fail('nothing to show')), false)
})
