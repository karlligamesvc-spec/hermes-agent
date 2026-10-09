import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { stageCosFfmpeg } from '../../../scripts/media-tools/bundle.mjs'

test('bundling verifies COS bytes before extraction and ships both tools with corresponding sources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-media-bundle-'))
  const payload = Buffer.from('trusted archive fixture')
  let extracts = 0
  const options = {
    stage: root, tools: root, target: { os: 'mac', arch: 'arm64', exe: '' },
    lock: { ffmpeg: { 'mac-arm64': { version: 'test', bytes: payload.length,
      url: 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com/media-tools/test.zip',
      sha256: createHash('sha256').update(payload).digest('hex') } } },
    download: async (_url: string, file: string) => { fs.writeFileSync(file, payload) },
    extract: async (_archive: string, destination: string) => {
      extracts++
      for (const name of ['ffmpeg', 'ffprobe', 'LICENSE-FFmpeg.txt', 'ffmpeg.source.tar.xz']) {
        fs.writeFileSync(path.join(destination, name), name)
      }
    }
  }
  try {
    const result = await stageCosFfmpeg(options)
    for (const tool of ['ffmpeg', 'ffprobe']) {
      assert.equal(fs.readFileSync(path.join(root, result.path, tool), 'utf8'), tool)
    }
    assert.ok(fs.existsSync(path.join(root, result.licensesAndSource, 'ffmpeg.source.tar.xz')))
    await assert.rejects(stageCosFfmpeg({ ...options,
      download: async (_url: string, file: string) => { fs.writeFileSync(file, Buffer.alloc(payload.length)) }
    }), /checksum mismatch/)
    assert.equal(extracts, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
