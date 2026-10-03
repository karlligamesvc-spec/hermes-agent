import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { AnalysisDocument, AnalysisVideoPlayback } from '../analysis-types'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')

  return { useI18n: () => ({ locale: 'zh', t: zh }) }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const url = 'https://www.iesdouyin.com/share/video/123456'

const source: AnalysisDocument = {
  id: 'local-video',
  filename: 'video.srt',
  kind: 'subtitle',
  status: 'ready',
  storageMode: 'local',
  sourceUrl: url,
  analysis_scope: 'owner',
  analysis_revision: 'a'.repeat(64),
  evidenceOrigin: 'linked_video_audio',
  anchors: [{ id: 'a1', text: 'Actual speech.', location: { start_seconds: 1, end_seconds: 2 } }],
  questions: [],
  notes: []
}

it('carries an imported link into one source conversation and automatically pairs its native playback', async () => {
  const playback = { url: 'hermes-media://analysis/abc.mp4', name: 'video.mp4' }
  const previewVideo = vi.fn().mockResolvedValue({ ok: true, playback })
  const releaseVideo = vi.fn().mockResolvedValue(undefined)
  window.hermesDesktop = {
    analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
      get: vi.fn().mockResolvedValue({ ok: true, item: source }),
      resolveVideoLink: vi
        .fn()
        .mockResolvedValue({ ok: true, resolution: { source_url: url, capability: 'download_candidate' } }),
      transcribeVideoLink: vi.fn().mockResolvedValue({ ok: true, item: source }),
      previewVideo,
      releaseVideo
    }
  } as never
  const rendered = render(<AnalysisView />)
  fireEvent.change(await screen.findByRole('textbox', { name: '粘贴资料链接' }), {
    target: { value: `分享视频 ${url} 复制打开` }
  })
  fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
  const player = await screen.findByLabelText('本地视频: video.mp4')
  expect(player.getAttribute('src')).toBe(playback.url)
  expect(screen.getByText(url, { exact: true })).toBeTruthy()
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('针对这个视频提问…')
  expect(screen.getByRole('log')).toBeTruthy()
  expect(screen.queryByRole('tab', { name: '快速分析' })).toBeNull()
  expect(previewVideo).toHaveBeenCalledWith(source.id, 'owner', source.analysis_revision)
  rendered.unmount()
  expect(releaseVideo).toHaveBeenCalledWith(playback.url)
})

it('discards a late linked video after switching sources and automatically uses a selected upload', async () => {
  let finish!: (value: { ok: boolean; playback: AnalysisVideoPlayback }) => void

  const previewVideo = vi.fn().mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )

  const uploaded: AnalysisDocument = {
    ...source,
    id: 'local-upload',
    filename: 'upload.srt',
    evidenceOrigin: 'uploaded_video_audio',
    sourceUrl: undefined
  }

  const playback = { url: 'hermes-media://analysis/upload.webm', name: 'original.webm' }
  const releaseVideo = vi.fn().mockResolvedValue(undefined)
  window.hermesDesktop = {
    analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [source] }),
      get: vi.fn(async id => ({ ok: true, item: id === source.id ? source : uploaded })),
      uploadVideo: vi.fn().mockResolvedValue({ ok: true, item: uploaded, playback }),
      previewVideo,
      releaseVideo
    }
  } as never
  render(<AnalysisView />)
  fireEvent.click(await screen.findByRole('button', { name: /video.srt/ }))
  await waitFor(() => expect(previewVideo).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '返回资料入口' }))
  fireEvent.click(screen.getByRole('button', { name: '选择本地视频转写' }))
  expect((await screen.findByLabelText('本地视频: original.webm')).getAttribute('src')).toBe(playback.url)
  await act(async () => {
    finish({ ok: true, playback: { url: 'hermes-media://analysis/late.mp4', name: 'late.mp4' } })
  })
  expect(screen.queryByLabelText('本地视频: late.mp4')).toBeNull()
  expect(releaseVideo).toHaveBeenCalledWith('hermes-media://analysis/late.mp4')
})
