import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'

import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'
import { loadVideoSemanticOverview } from '../video-semantic-overview'

import { VideoSemanticOverviewPanel } from './video-semantic-overview'

vi.mock('../video-semantic-overview', () => ({ loadVideoSemanticOverview: vi.fn() }))
const source: AnalysisDocument = {
  id: 'local-a', analysis_scope: 'owner-a', analysis_revision: 'revision-a', filename: 'video.srt',
  kind: 'subtitle', status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
  anchors: [{ id: 'a1', text: 'Sales grew', location: { start_seconds: 1, end_seconds: 3 } }]
}
const item = { schema: 1 as const, revision: 'revision-a', locale: 'zh' as const, points: [{ text: '销售增长。', anchor_ids: ['a1'] }] }
const bridge = { overviewContext: vi.fn() } as unknown as AnalysisDocumentsBridge
const label = () => '0:01 起'
afterEach(() => { cleanup(); $gateway.set(null); vi.resetAllMocks() })

it('shows a saved summary offline and links its original evidence', async () => {
  const jump = vi.fn()
  render(<VideoSemanticOverviewPanel bridge={bridge} jump={jump} label={label} locale="zh" source={{ ...source, video_overviews: { zh: item } }} />)
  expect(await screen.findByText('销售增长。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看出处 · 0:01 起' }))
  expect(jump).toHaveBeenCalledWith('a1')
  expect(loadVideoSemanticOverview).not.toHaveBeenCalled()
})

it('keeps failure explicit, retries on click, and ignores a late result after source switch', async () => {
  $gateway.set({} as never)
  vi.mocked(loadVideoSemanticOverview).mockRejectedValueOnce(new Error('provider raw secret'))
  const rendered = render(<VideoSemanticOverviewPanel bridge={bridge} jump={vi.fn()} key="a" label={label} locale="zh" source={source} />)
  expect(await screen.findByText('摘要生成或保存失败，原文仍可查看。')).toBeTruthy()
  expect(screen.queryByText('provider raw secret')).toBeNull()
  let finish!: (value: typeof item) => void
  vi.mocked(loadVideoSemanticOverview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: '重试摘要' }))
  expect(await screen.findByText('正在概括转写内容…')).toBeTruthy()
  vi.mocked(loadVideoSemanticOverview).mockResolvedValueOnce({ ...item, points: [{ text: '新资料摘要。', anchor_ids: ['a1'] }] })
  rendered.rerender(<VideoSemanticOverviewPanel bridge={bridge} jump={vi.fn()} key="b" label={label} locale="zh" source={{ ...source, id: 'local-b' }} />)
  expect(await screen.findByText('新资料摘要。')).toBeTruthy()
  finish(item)
  await Promise.resolve()
  expect(screen.queryByText('销售增长。')).toBeNull()
})
