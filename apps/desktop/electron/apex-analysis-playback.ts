/** View-scoped media leases. Only opaque URLs cross the preload boundary. */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { MAX_ANALYSIS_VIDEO_BYTES } from './apex-analysis-video-upload'
import { buildLocalMediaResponse } from './media-range'

export interface AnalysisPlayback {
  url: string
  name: string
}

interface Lease {
  owner: string
  windowId: number
  file: string
  directory?: string
}

export function createAnalysisPlaybackStore(currentOwner: () => string | null) {
  const leases = new Map<string, Lease>()

  const remove = async (token: string) => {
    const lease = leases.get(token)
    leases.delete(token)

    if (lease?.directory) {
      await fs.rm(lease.directory, { recursive: true, force: true })
    }
  }

  const register = (owner: string, windowId: number, file: string, directory?: string): AnalysisPlayback => {
    if (currentOwner() !== owner) {
      throw new Error('analysis_account_changed')
    }

    const token = `${crypto.randomUUID()}${path.extname(file).toLowerCase()}`
    leases.set(token, { owner, windowId, file, directory })

    return { url: `hermes-media://analysis/${token}`, name: path.basename(file) }
  }

  return {
    async local(owner: string, windowId: number, file: string): Promise<AnalysisPlayback> {
      const stat = await fs.stat(file)

      if (!stat.isFile() || !stat.size || stat.size > MAX_ANALYSIS_VIDEO_BYTES) {
        throw new Error('video_file_unsupported')
      }

      if (!/\.(mp4|mov|m4v|webm|mkv|avi|flv)$/i.test(file)) {
        throw new Error('video_file_unsupported')
      }

      return register(owner, windowId, file)
    },
    async linked(owner: string, windowId: number, download: () => Promise<Buffer>): Promise<AnalysisPlayback> {
      if (currentOwner() !== owner) {
        throw new Error('analysis_account_changed')
      }

      const bytes = await download()

      if (currentOwner() !== owner) {
        throw new Error('analysis_account_changed')
      }

      if (!bytes.length || bytes.length > MAX_ANALYSIS_VIDEO_BYTES || bytes.subarray(4, 8).toString() !== 'ftyp') {
        throw new Error('video_playback_unavailable')
      }

      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-analysis-playback-'))

      try {
        const file = path.join(directory, 'video.mp4')
        await fs.writeFile(file, bytes, { mode: 0o600 })

        return register(owner, windowId, file, directory)
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true })
        throw error
      }
    },
    async fetch(token: string, headers: Headers, method: 'GET' | 'HEAD'): Promise<Response> {
      const lease = leases.get(token)

      if (!lease) {
        return new Response(null, { status: 404 })
      }

      if (lease.owner !== currentOwner()) {
        await remove(token)

        return new Response(null, { status: 404 })
      }

      const response = await buildLocalMediaResponse(lease.file, { method, rangeHeader: headers.get('range') })

      if (lease.owner !== currentOwner() || leases.get(token) !== lease) {
        await response.body?.cancel()

        return new Response(null, { status: 404 })
      }

      response.headers.set('Access-Control-Allow-Origin', '*')

      return response
    },
    async release(url: string, windowId: number): Promise<void> {
      let target: URL

      try {
        target = new URL(url)
      } catch {
        return
      }

      if (target.protocol !== 'hermes-media:' || target.hostname !== 'analysis') {
        return
      }

      const token = target.pathname.slice(1)

      if (leases.get(token)?.windowId === windowId) {
        await remove(token)
      }
    },
    async releaseWindow(windowId: number): Promise<void> {
      await Promise.all([...leases].filter(([, lease]) => lease.windowId === windowId).map(([token]) => remove(token)))
    }
  }
}

/** Never send the managed key to the resolved CDN. The account fence owns both legs. */
export async function downloadAnalysisPlayback(
  sourceUrl: string,
  socialDownload: (url: string) => Promise<{ platform?: string; download_url?: string }>,
  downloadBytes: (url: string) => Promise<Buffer>
): Promise<Buffer> {
  const source = new URL(sourceUrl)

  const allowed = [
    'v.douyin.com',
    'www.douyin.com',
    'www.iesdouyin.com',
    'xhslink.com',
    'xhslink.cn',
    'www.xiaohongshu.com'
  ]

  if (
    source.protocol !== 'https:' ||
    source.username ||
    source.password ||
    source.port ||
    !allowed.includes(source.hostname)
  ) {
    throw new Error('video_playback_unavailable')
  }

  const resolved = await socialDownload(source.href)

  if (!['douyin', 'xiaohongshu'].includes(resolved.platform ?? '') || !resolved.download_url) {
    throw new Error('video_playback_unavailable')
  }

  const media = new URL(resolved.download_url)

  if (media.protocol !== 'https:' || media.username || media.password) {
    throw new Error('video_playback_unavailable')
  }

  return downloadBytes(media.href)
}
