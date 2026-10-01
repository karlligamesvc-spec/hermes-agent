import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { MAX_ANALYSIS_VIDEO_BYTES, uploadAnalysisVideo } from './apex-analysis-video-upload'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {fs.rmSync(directory, { recursive: true, force: true })}
})

it('sends the selected video and storage mode through one authenticated multipart request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-upload-'))
  directories.push(directory)
  const filePath = path.join(directory, 'clip.mp4')
  fs.writeFileSync(filePath, Buffer.from('actual selected video bytes'))
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ Authorization: 'Bearer account-jwt', Accept: 'application/json' })
    const form = init.body as FormData
    expect(form.get('storage_mode')).toBe('local')
    const file = form.get('file') as File
    expect(file.name).toBe('clip.mp4')
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('actual selected video bytes')
    return new Response(JSON.stringify({ parsed: { evidence_origin: 'uploaded_video_audio' } }), {
      status: 200, headers: { 'x-apex-renewed-token': 'renewed-jwt' }
    })
  })

  const result = await uploadAnalysisVideo('https://api.apex-nodes.com/api/v1/account/analysis/video-links/upload-transcribe',
    'account-jwt', filePath, 'local', fetcher)
  expect(result).toEqual({ body: { parsed: { evidence_origin: 'uploaded_video_audio' } }, renewedToken: 'renewed-jwt' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('rejects unsupported and oversized files before network upload', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-upload-limit-'))
  directories.push(directory)
  const fetcher = vi.fn()
  const unsupported = path.join(directory, 'image.png')
  fs.writeFileSync(unsupported, 'not a video')
  await expect(uploadAnalysisVideo('https://example.com', 'jwt', unsupported, 'local', fetcher)).rejects.toThrow('video_file_unsupported')
  const oversized = path.join(directory, 'large.mp4')
  fs.writeFileSync(oversized, '')
  fs.truncateSync(oversized, MAX_ANALYSIS_VIDEO_BYTES + 1)
  await expect(uploadAnalysisVideo('https://example.com', 'jwt', oversized, 'cloud', fetcher)).rejects.toThrow('video_file_too_large')
  expect(fetcher).not.toHaveBeenCalled()
})
