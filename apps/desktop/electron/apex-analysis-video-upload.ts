/** Send a bounded user-selected video to the authenticated account ASR endpoint. */

import fs from 'node:fs'
import path from 'node:path'

import { type AnalysisJobResult, type AnalysisJobTiming, runAnalysisAsrJob } from './apex-analysis-asr-job'

export const MAX_ANALYSIS_VIDEO_BYTES = 128 * 1024 * 1024
const VIDEO_SUFFIXES = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv'])

export async function uploadAnalysisVideo(
  url: string,
  bearer: string,
  filePath: string,
  storageMode: 'local' | 'cloud',
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
  timing?: Partial<AnalysisJobTiming>
): Promise<AnalysisJobResult> {
  const filename = path.basename(filePath)

  if (!VIDEO_SUFFIXES.has(path.extname(filename).toLowerCase())) {throw new Error('video_file_unsupported')}

  const stat = await fs.promises.stat(filePath)

  if (!stat.isFile() || stat.size === 0) {throw new Error('empty_video_file')}

  if (stat.size > MAX_ANALYSIS_VIDEO_BYTES) {throw new Error('video_file_too_large')}

  const form = new FormData()
  form.append('storage_mode', storageMode)
  form.append('file', await fs.openAsBlob(filePath, { type: 'application/octet-stream' }), filename)

  // hc-1029: a current server stages the upload, answers 202 and transcribes in a job
  // we poll; the upload itself is the only long request, and it is never silent.
  return runAnalysisAsrJob({ submitUrl: url, bearer, body: form, redirect: 'error', fetcher, timing })
}
