import assert from 'node:assert/strict'
import test from 'node:test'
import { machOFileType } from '../../../scripts/mac-runtime-payload.mjs'

test('native payload signing distinguishes Mach-O executables, libraries and fat binaries from Java classes', () => {
  const executable = Buffer.alloc(32)
  executable.writeUInt32BE(0xcffaedfe, 0)
  executable.writeUInt32LE(2, 12)
  const library = Buffer.from(executable)
  library.writeUInt32LE(6, 12)
  const fat = Buffer.alloc(96)
  fat.writeUInt32BE(0xcafebabe, 0)
  fat.writeUInt32BE(1, 4)
  fat.writeUInt32BE(64, 16)
  executable.copy(fat, 64)
  assert.equal(machOFileType(executable), 2)
  assert.equal(machOFileType(library), 6)
  assert.equal(machOFileType(fat), 2)
  const java = Buffer.alloc(32)
  java.writeUInt32BE(0xcafebabe, 0)
  java.writeUInt32BE(61, 4)
  for (const bytes of [java, Buffer.alloc(0), Buffer.alloc(16), Buffer.from('plain source')]) {
    assert.equal(machOFileType(bytes), null)
  }
})
