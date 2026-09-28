/** Send a bounded user-selected video to the authenticated account ASR endpoint. */

import fs from 'node:fs'
import path from 'node:path'

export const MAX_ANALYSIS_VIDEO_BYTES = 128 * 1024 * 1024
const VIDEO_SUFFIXES = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv'])

export async function uploadAnalysisVideo(
  url: string,
  bearer: string,
  filePath: string,
  storageMode: 'local' | 'cloud',
  fetcher: (input: string, init: RequestInit) => Promise<Response>
): Promise<{ body: any; renewedToken: string | null }> {
  const filename = path.basename(filePath)

  if (!VIDEO_SUFFIXES.has(path.extname(filename).toLowerCase())) {throw new Error('video_file_unsupported')}

  const stat = await fs.promises.stat(filePath)

  if (!stat.isFile() || stat.size === 0) {throw new Error('empty_video_file')}

  if (stat.size > MAX_ANALYSIS_VIDEO_BYTES) {throw new Error('video_file_too_large')}

  const form = new FormData()
  form.append('storage_mode', storageMode)
  form.append('file', await fs.openAsBlob(filePath, { type: 'application/octet-stream' }), filename)
  const response = await fetcher(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(1_850_000)
  })
  const text = await response.text()

  if (!response.ok) {
    const error: Error & { statusCode?: number } = new Error(`${response.status}: ${text.slice(0, 1000)}`)
    error.statusCode = response.status
    throw error
  }

  try {
    return { body: JSON.parse(text), renewedToken: response.headers.get('x-apex-renewed-token') }
  } catch {throw new Error('analysis_invalid_response')}
}
