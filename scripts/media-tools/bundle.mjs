import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const lockPath = fileURLToPath(new URL('./desktop-lock.json', import.meta.url))

// This runs at bundle build time. First boot neither installs nor downloads
// FFmpeg; terminal, transcript and render callers share the bundled PATH.
export async function stageCosFfmpeg({ stage, tools, target, download, extract, lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) }) {
  const spec = lock.ffmpeg[`${target.os}-${target.arch}`]
  if (!spec) throw new Error('No verified FFmpeg package for this target')
  const url = new URL(spec.url)
  if (url.protocol !== 'https:' || url.hostname !== 'apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com') {
    throw new Error('FFmpeg package must come from the APEX COS mirror')
  }
  const archive = path.join(tools, `ffmpeg-${target.os}-${target.arch}.zip`)
  await download(spec.url, archive)
  const bytes = fs.readFileSync(archive)
  if (bytes.length !== spec.bytes || createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
    throw new Error('FFmpeg COS package checksum mismatch')
  }
  const licenses = path.join(stage, '.runtime', 'media', 'ffmpeg')
  fs.mkdirSync(licenses, { recursive: true })
  await extract(archive, licenses)
  const bin = path.join(stage, '.runtime', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of ['ffmpeg', 'ffprobe']) {
    const filename = name + target.exe
    const source = path.join(licenses, filename)
    if (!fs.statSync(source).isFile()) throw new Error(`FFmpeg package missing ${filename}`)
    fs.renameSync(source, path.join(bin, filename))
    fs.chmodSync(path.join(bin, filename), 0o755)
  }
  return { version: spec.version, source: spec.url, sha256: spec.sha256,
    path: '.runtime/bin', licensesAndSource: '.runtime/media/ffmpeg' }
}
