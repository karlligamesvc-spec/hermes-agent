import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { createAnalysisPlaybackStore, downloadAnalysisPlayback } from './apex-analysis-playback'
import { createMediaProtocolHandler } from './media-protocol'

it('serves real downloaded bytes through opaque range leases and releases only the owning window', async () => {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(200, 7)])
  const server = http.createServer((_request, response) => response.end(bytes))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let owner = 'account-a'
  const store = createAnalysisPlaybackStore(() => owner)

  try {
    const playback = await store.linked(owner, 12, () =>
      downloadAnalysisPlayback(
        'https://v.douyin.com/abc/',
        async source => {
          expect(source).toBe('https://v.douyin.com/abc/')

          return { platform: 'douyin', download_url: 'https://media.example/clip.mp4' }
        },
        async url => {
          expect(url).toBe('https://media.example/clip.mp4')

          return Buffer.from(await (await fetch(endpoint)).arrayBuffer())
        }
      )
    )

    expect(playback.url).toMatch(/^hermes-media:\/\/analysis\/[a-f0-9-]+\.mp4$/)

    const fail = async (): Promise<never> => {
      throw new Error('Unexpected remote or file-path access')
    }

    const handler = createMediaProtocolHandler({
      fetchAnalysis: store.fetch,
      ensureRemoteBearer: fail,
      fetchLocal: fail,
      fetchRemote: fail,
      fetchRemoteWithCookies: fail,
      resolveLocalFile: fail,
      resolveRemoteConnection: fail
    })

    const read = (range = '') =>
      handler({ url: playback.url, method: 'GET', headers: new Headers(range ? { range } : {}) })

    const response = await read('bytes=8-19')
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 8-19/${bytes.length}`)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(8, 20))
    await store.release(playback.url, 99)
    expect((await read()).status).toBe(200)
    await store.releaseWindow(12)
    expect((await read()).status).toBe(404)
    const next = await store.linked(owner, 12, async () => bytes)
    owner = 'account-b'
    expect((await handler({ url: next.url, method: 'GET', headers: new Headers() })).status).toBe(404)
    await expect(
      store.linked('account-b', 12, async () => {
        owner = 'account-c'

        return bytes
      })
    ).rejects.toThrow('analysis_account_changed')
  } finally {
    await store.releaseWindow(12)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('never deletes the original selected video, and rejects unsupported linked media before fetching bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-original-'))
  const file = path.join(directory, 'original.webm')
  const bytes = Buffer.from('original selected file')
  await fs.writeFile(file, bytes)
  const store = createAnalysisPlaybackStore(() => 'owner')

  try {
    const playback = await store.local('owner', 1, file)
    const response = await store.fetch(new URL(playback.url).pathname.slice(1), new Headers(), 'GET')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    await store.releaseWindow(1)
    expect(await fs.readFile(file)).toEqual(bytes)

    for (const result of [
      { platform: 'bilibili', download_url: 'https://media.example/audio.m4a' },
      { platform: 'douyin', download_url: 'http://media.example/video.mp4' }
    ]) {
      await expect(
        downloadAnalysisPlayback(
          'https://v.douyin.com/abc/',
          async () => result,
          async () => {
            throw new Error('CDN must not be called')
          }
        )
      ).rejects.toThrow('video_playback_unavailable')
    }
  } finally {
    await store.releaseWindow(1)
    await fs.rm(directory, { recursive: true, force: true })
  }
})
