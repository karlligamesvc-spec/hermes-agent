import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { render } from '../test-render'
import type * as VideoFrameEvidenceModule from '../video-frame-evidence'
import { sampleVideoFrames } from '../video-frame-evidence'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')

  return { useI18n: () => ({ locale: 'zh', t: zh }) }
})
vi.mock('../video-frame-evidence', async importOriginal => {
  const actual = await importOriginal<typeof VideoFrameEvidenceModule>()

  return { ...actual, sampleVideoFrames: vi.fn(actual.sampleVideoFrames) }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  $connection.set(null)
})

describe('document analysis evidence', () => {
  it('retains old model answers as escaped text without linking them into new evidence', async () => {
    const item = { id: 'local-a', filename: 'facts.txt', kind: 'text', status: 'ready', storageMode: 'local',
      analysis_revision: 'b'.repeat(64), anchors: [{ id: 'a1', text: 'New text', location: { paragraph: 1 } }], notes: [],
      questions: [{ id: 'q1', question: 'Old question?', answer: '<img src=x onerror=alert(1)>', answer_type: 'semantic_answer',
        source_revision: 'a'.repeat(64), citations: [{ anchor_id: 'a1', location: { paragraph: 1 } }] }] }

    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [item] }), get: vi.fn().mockResolvedValue({ ok: true, item })
    } } as never
    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /facts.txt/ }))
    expect(await screen.findByText('此回答基于旧版资料，引用已停用。')).toBeTruthy()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(document.querySelector('article img')).toBeNull()
    expect(screen.queryByRole('button', { name: /查看出处/ })).toBeNull()
  })

  it('opens the owned PDF preview at the cited page and revokes it after leaving', async () => {
    const createObjectURL = vi.fn(() => 'blob:owned-pdf')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    })
    Element.prototype.scrollIntoView = vi.fn()

    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'report.pdf', kind: 'pdf',
      status: 'ready', storageMode: 'local',
      anchors: [{ id: 'a1', location: { page: 2 }, text: 'Revenue 423 units' }],
      notes: [], questions: [{ id: 'q1', question: 'Revenue?', answer: 'Revenue 423 units',
        answer_type: 'source_excerpts', citations: [{ anchor_id: 'a1', location: { page: 2 } }] }]
    }

    const previewPdf = vi.fn().mockResolvedValue({ ok: true, data_url: `data:application/pdf;base64,${btoa('%PDF-1.4\noriginal')}` })
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item }), previewPdf
      }
    } as never

    const rendered = render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /report.pdf/ }))
    const frame = await screen.findByTitle('PDF 原件')
    expect(frame.getAttribute('src')).toBe('blob:owned-pdf#page=1')
    fireEvent.click(screen.getByRole('button', { name: '查看出处 · 第 2 页' }))
    await waitFor(() => expect(screen.getByTitle('PDF 原件').getAttribute('src')).toBe('blob:owned-pdf#page=2'))
    expect(previewPdf).toHaveBeenCalledWith(item.id)
    rendered.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:owned-pdf')
  })

  it('keeps the original-file action when PDF preview cannot be loaded', async () => {
    const item = { id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'report.pdf', kind: 'pdf', status: 'ready', storageMode: 'local', anchors: [], notes: [], questions: [] }
    const openSource = vi.fn().mockResolvedValue({ ok: true })
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item }),
        previewPdf: vi.fn().mockResolvedValue({ ok: false, code: 'preview_unavailable' }), openSource
      }
    } as never

    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /report.pdf/ }))
    expect(await screen.findByText('PDF 预览暂不可用，可打开原件。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开原文件' }))
    await waitFor(() => expect(openSource).toHaveBeenCalledWith(item.id))
  })

  it('labels subtitle-only evidence and jumps a timestamp citation to the original cue', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll

    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
      status: 'ready', storageMode: 'local',
      anchors: [{ id: 'a1', location: { start_seconds: 62.5, end_seconds: 65 }, text: 'Revenue rose 20 percent' }],
      notes: [], questions: [{ id: 'q1', question: 'Revenue?', answer: 'Revenue rose 20 percent',
        answer_type: 'source_excerpts', citations: [{ anchor_id: 'a1', location: { start_seconds: 2, end_seconds: 3 } }] }]
    }

    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item })
      }
    } as never

    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /clip.srt/ }))
    expect(await screen.findByText(/仅依据导入的字幕原文/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看出处 · 1:02 起' }))
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(screen.getAllByText('Revenue rose 20 percent').length).toBeGreaterThan(0)
  })

  it('keeps one video conversation and moves deep preparation behind more analysis', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll

    const video = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'video-transcript.srt', kind: 'subtitle',
      status: 'ready', storageMode: 'cloud', parse_version: 1, evidence_origin: 'uploaded_video_audio',
      anchors: [
        { id: 'a5', location: { start_seconds: 80, end_seconds: 84 }, text: '结束原文' },
        { id: 'a3', location: { start_seconds: 40, end_seconds: 43 }, text: '中段原文' },
        { id: 'bad', location: { start_seconds: 50, end_seconds: 49 }, text: '无效时间码' },
        { id: 'a1', location: { start_seconds: 5, end_seconds: 8 }, text: '开场原文' },
        { id: 'a4', location: { start_seconds: 60, end_seconds: 64 }, text: '后段原文' },
        { id: 'a2', location: { start_seconds: 20, end_seconds: 24 }, text: '前段原文' }
      ], notes: [], questions: []
    }

    const captions = { ...video, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', filename: 'captions.srt', evidence_origin: undefined, anchors: [video.anchors[0]] }
    const ask = vi.fn()
    const onDeepBreakdown = vi.fn()
    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'cloud', cloud_storage_configured: true } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [video, captions] }),
      get: vi.fn(async (id: string) => ({ ok: true, item: id === video.id ? video : captions })), ask
    } } as never

    render(<AnalysisView onDeepBreakdown={onDeepBreakdown} />)
    expect(screen.queryByRole('region', { name: '视频声音速览' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /video-transcript.srt/ }))
    await screen.findByRole('log')
    expect(screen.getAllByRole('textbox', { name: '针对当前资料提问' })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: '视频声音速览' })).toBeNull()
    expect(onDeepBreakdown).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('更多分析', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '准备深度拆解' }))
    expect(onDeepBreakdown).toHaveBeenCalledOnce()
    expect(onDeepBreakdown.mock.calls[0][0]).toEqual(video)
    expect(onDeepBreakdown.mock.calls[0][1]).toBe('zh')
    expect(onDeepBreakdown.mock.calls[0][2]).toEqual([])
    fireEvent.click(screen.getAllByRole('button', { name: '记到此处' })[0].closest('article')!.querySelector('button')!)
    expect(screen.getByRole('tab', { name: '研究笔记' }).getAttribute('data-state')).toBe('active')
    expect(ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /captions.srt/ }))
    await screen.findByRole('heading', { name: 'captions.srt' })
    expect(screen.queryByRole('region', { name: '视频声音速览' })).toBeNull()
  })

  it('keeps a remote connection from presenting a local Hypit breakdown as runnable', async () => {
    $connection.set({ mode: 'remote' } as never)

    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
      status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
      anchors: [{ id: 'a1', location: { start_seconds: 1, end_seconds: 3 }, text: '真实口播' }],
      notes: [], questions: []
    }

    const onDeepBreakdown = vi.fn()
    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [item] }),
      get: vi.fn().mockResolvedValue({ ok: true, item })
    } } as never

    render(<AnalysisView onDeepBreakdown={onDeepBreakdown} />)
    fireEvent.click(await screen.findByRole('button', { name: /clip.srt/ }))
    fireEvent.click(await screen.findByText('更多分析', { selector: 'summary' }))
    const action = await screen.findByRole('button', { name: '准备深度拆解' })
    expect(action.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('深度拆解需要连接本机助手。')).toBeTruthy()
    fireEvent.click(action)
    expect(onDeepBreakdown).not.toHaveBeenCalled()
  })

  it('seeks a manually paired local video from a real subtitle citation and releases it on source switch', async () => {
    const createObjectURL = vi.fn(() => 'blob:chosen-video')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    })
    Element.prototype.scrollIntoView = vi.fn()

    const subtitle = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
      status: 'ready', storageMode: 'local',
      anchors: [{ id: 'a1', location: { start_seconds: 62.5, end_seconds: 65 }, text: 'Revenue rose 20 percent' }],
      notes: [], questions: [{ id: 'q1', question: 'Revenue?', answer: 'Revenue rose 20 percent',
        answer_type: 'source_excerpts', citations: [{ anchor_id: 'a1', location: { start_seconds: 2, end_seconds: 3 } }] }]
    }

    const document = { id: 'local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', filename: 'report.txt', kind: 'text',
      status: 'ready', storageMode: 'local', anchors: [{ id: 'a1', location: { paragraph: 1 }, text: 'Report' }], notes: [], questions: [] }

    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [subtitle, document] }),
        get: vi.fn().mockImplementation(async (id: string) => ({ ok: true, item: id === subtitle.id ? subtitle : document }))
      }
    } as never

    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /clip.srt/ }))
    expect(screen.queryByRole('video')).toBeNull()
    expect(await screen.findByText(/视频仅在本次查看期间留在这台设备/)).toBeTruthy()

    const videoFile = new File(['real video bytes'], 'clip.mp4', { type: 'video/mp4' })
    fireEvent.change(screen.getByLabelText('选择本地视频播放'), { target: { files: [videoFile] } })
    const player = screen.getByLabelText('本地视频: clip.mp4') as HTMLVideoElement
    Object.defineProperty(player, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_METADATA })
    Object.defineProperty(player, 'duration', { configurable: true, value: 120 })
    expect(player.src).toContain('blob:chosen-video')
    expect(createObjectURL).toHaveBeenCalledWith(videoFile)
    fireEvent.click(screen.getByRole('button', { name: '查看出处 · 1:02 起' }))
    expect(player.currentTime).toBe(62.5)

    fireEvent.click(screen.getByRole('button', { name: /report.txt/ }))
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:chosen-video'))
    expect(screen.queryByLabelText('本地视频: clip.mp4')).toBeNull()
  })

  it('captures only decoded local frames with actual player time and clears them on source switch', async () => {
    const createObjectURL = vi.fn(() => 'blob:chosen-video')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn() })
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,ZmFrZQ==')

    const video = { id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
      status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
      anchors: [{ id: 'a1', location: { start_seconds: 12, end_seconds: 15 }, text: 'spoken words' }], notes: [], questions: [] }

    const other = { ...video, id: 'local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', filename: 'other.srt' }
    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [video, other] }),
      get: vi.fn(async (id: string) => ({ ok: true, item: id === video.id ? video : other }))
    } } as never

    const onDeepBreakdown = vi.fn()

    render(<AnalysisView onDeepBreakdown={onDeepBreakdown} />)
    fireEvent.click(await screen.findByRole('button', { name: /clip.srt/ }))
    await screen.findByRole('heading', { name: 'clip.srt' })
    fireEvent.change(screen.getByLabelText('选择本地视频播放'), { target: { files: [new File(['video'], 'clip.mp4', { type: 'video/mp4' })] } })
    const player = screen.getByLabelText('本地视频: clip.mp4') as HTMLVideoElement
    const capture = screen.getByRole('button', { name: '截取当前画面' })
    Object.defineProperties(player, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
      currentTime: { configurable: true, value: 12.5, writable: true }
    })

    fireEvent.click(capture)
    expect(encode).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('当前画面无法截取')

    Object.defineProperties(player, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA }
    })

    for (let index = 0; index < 4; index++) {
      player.currentTime = 12.5 + index
      fireEvent.click(capture)
    }

    const frames = within(screen.getByRole('region', { name: '本次查看的画面截图' })).getAllByRole('img')
    expect(frames).toHaveLength(3)
    expect(frames[0].getAttribute('alt')).toContain('0:13.5')
    expect(frames[2].getAttribute('alt')).toContain('0:15.5')
    expect(frames[0].getAttribute('src')).toBe('data:image/jpeg;base64,ZmFrZQ==')
    expect(drawImage).toHaveBeenCalledWith(player, 0, 0, 640, 360)
    expect(screen.getByText(/尚未经过模型分析/)).toBeTruthy()
    expect(screen.getByText(/已截取的画面会写入此设备的聊天附件目录/)).toBeTruthy()
    fireEvent.click(screen.getByText('更多分析', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '准备深度拆解' }))
    expect(onDeepBreakdown).toHaveBeenCalledOnce()
    expect(onDeepBreakdown.mock.calls[0][2].map((frame: { seconds: number }) => frame.seconds)).toEqual([13.5, 14.5, 15.5])
    fireEvent.change(screen.getByLabelText('选择本地视频播放'), { target: { files: [new File(['replacement'], 'new.webm', { type: 'video/webm' })] } })
    expect(screen.queryByRole('region', { name: '本次查看的画面截图' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /other.srt/ }))
    await screen.findByRole('heading', { name: 'other.srt' })
    expect(screen.queryByRole('region', { name: '本次查看的画面截图' })).toBeNull()
  })

  it('samples paired video frames when deep breakdown is requested, then sends only decoded evidence to the draft', async () => {
    const createObjectURL = vi.fn().mockReturnValueOnce('blob:chosen-video').mockReturnValueOnce('blob:other-video')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn() })

    const video = { id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
      status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
      anchors: [
        { id: 'a1', location: { start_seconds: 1, end_seconds: 3 }, text: 'opening speech' },
        { id: 'a2', location: { start_seconds: 5, end_seconds: 7 }, text: 'middle speech' },
        { id: 'a3', location: { start_seconds: 9, end_seconds: 11 }, text: 'closing speech' }
      ], notes: [], questions: [] }

    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [video] }),
      get: vi.fn().mockResolvedValue({ ok: true, item: video })
    } } as never
    vi.mocked(sampleVideoFrames).mockResolvedValueOnce([
      { seconds: 1.25, dataUrl: 'data:image/jpeg;base64,YQ==' },
      { seconds: 5.25, dataUrl: 'data:image/jpeg;base64,Yg==' }
    ])
    const onDeepBreakdown = vi.fn()

    render(<AnalysisView onDeepBreakdown={onDeepBreakdown} />)
    fireEvent.click(await screen.findByRole('button', { name: /clip.srt/ }))
    await screen.findByRole('heading', { name: 'clip.srt' })
    fireEvent.change(screen.getByLabelText('选择本地视频播放'), { target: { files: [new File(['video'], 'clip.mp4', { type: 'video/mp4' })] } })
    expect(screen.getByText(/将从手动配对的本地视频抽取最多 3 张画面/)).toBeTruthy()
    fireEvent.click(screen.getByText('更多分析', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '准备深度拆解' }))

    await waitFor(() => expect(onDeepBreakdown).toHaveBeenCalledOnce())
    expect(sampleVideoFrames).toHaveBeenCalledWith('blob:chosen-video', [1.25, 5.25, 9.25])
    expect(onDeepBreakdown.mock.calls[0][2].map((frame: { seconds: number }) => frame.seconds)).toEqual([1.25, 5.25])
    expect(within(screen.getByRole('region', { name: '本次查看的画面截图' })).getAllByRole('img')).toHaveLength(2)

    fireEvent.change(screen.getByLabelText('选择本地视频播放'), { target: { files: [new File(['bad'], 'other.mp4', { type: 'video/mp4' })] } })
    vi.mocked(sampleVideoFrames).mockResolvedValueOnce([])
    fireEvent.click(screen.getByText('更多分析', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '准备深度拆解' }))
    await waitFor(() => expect(onDeepBreakdown).toHaveBeenCalledTimes(2))
    expect(sampleVideoFrames).toHaveBeenLastCalledWith('blob:other-video', [1.25, 5.25, 9.25])
    expect(onDeepBreakdown.mock.calls[1][2]).toEqual([])
    expect(screen.getByRole('alert').textContent).toContain('当前画面无法截取')
  })

  it('does not seek past the selected video duration or turn an invalid file into a player', async () => {
    vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:chosen-video'); static revokeObjectURL = vi.fn() })
    Element.prototype.scrollIntoView = vi.fn()

    const item = { id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle', status: 'ready', storageMode: 'local',
      anchors: [{ id: 'a1', location: { start_seconds: 62.5, end_seconds: 65 }, text: 'Revenue rose' }], notes: [],
      questions: [{ id: 'q1', question: 'Revenue?', answer: 'Revenue rose', answer_type: 'source_excerpts',
        citations: [{ anchor_id: 'a1', location: { start_seconds: 62.5, end_seconds: 65 } }] }] }

    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [item] }), get: vi.fn().mockResolvedValue({ ok: true, item })
    } } as never

    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /clip.srt/ }))
    fireEvent.change(await screen.findByLabelText('选择本地视频播放'), { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    expect(screen.getByRole('alert').textContent).toContain('请选择视频文件')
    expect(screen.queryByLabelText(/本地视频: /)).toBeNull()
    fireEvent.change(screen.getByLabelText('选择本地视频播放'), { target: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] } })
    const player = screen.getByLabelText('本地视频: clip.mp4') as HTMLVideoElement
    Object.defineProperty(player, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_METADATA })
    Object.defineProperty(player, 'duration', { configurable: true, value: 20 })
    fireEvent.click(screen.getByRole('button', { name: '查看出处 · 1:02 起' }))
    expect(player.currentTime).toBe(0)
    expect(screen.getByRole('alert').textContent).toContain('字幕时间码超出所选视频时长')
  })

  it('jumps from a cited answer to the original page excerpt', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll

    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      filename: 'source.pdf', kind: 'pdf', status: 'ready', storageMode: 'local',
      anchors: [{ id: 'a1', location: { page: 2 }, text: 'Revenue 423 units' }],
      notes: [],
      questions: [{ id: 'q1', question: 'Revenue?', answer: 'Revenue 423 units', answer_type: 'source_excerpts', citations: [{ anchor_id: 'a1', location: { page: 2 } }] }]
    }

    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item })
      }
    } as never

    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /source.pdf/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /查看出处 · 第 2 页/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /查看出处 · 第 2 页/ }))
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
  })

  it('does not show question input while the body is still processing', async () => {
    const item = { id: 'cloud-id', filename: 'source.pdf', kind: 'pdf', status: 'processing', storageMode: 'cloud' }
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'cloud', cloud_storage_configured: true } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item })
      }
    } as never
    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /source.pdf/ }))
    await waitFor(() => expect(screen.getAllByText('正在解析原文…').length).toBeGreaterThan(0))
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
  })

  it('retries a failed local source from its saved record without asking for a new file', async () => {
    const failed = { id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'scan.pdf', kind: 'pdf', status: 'failed', storageMode: 'local', error_code: 'parse_interrupted' }
    const processing = { ...failed, status: 'processing', error_code: null }
    const retry = vi.fn().mockResolvedValue({ ok: true, item: processing })
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [failed] }),
        get: vi.fn().mockResolvedValueOnce({ ok: true, item: failed }).mockResolvedValue({ ok: true, item: processing }),
        retry
      }
    } as never

    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /scan.pdf/ }))
    fireEvent.click(await screen.findByRole('button', { name: '重试解析' }))
    await waitFor(() => expect(screen.getAllByText('正在解析原文…').length).toBeGreaterThan(0))
    expect(retry).toHaveBeenCalledWith(failed.id)
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
  })

  it('keeps links unanswerable and distinguishes Feishu permission from unchecked URLs', async () => {
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] })
      },
      openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    fireEvent.change(input, { target: { value: 'https://acme.feishu.cn/wiki/abc' } })
    expect(screen.getByText(/需要本人授权及读取权限/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开链接' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '授权飞书' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除平台保存的飞书授权' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()

    fireEvent.change(input, { target: { value: 'https://example.com/report.pdf' } })
    expect(screen.getByText(/已识别到链接/)).toBeTruthy()
    expect(screen.queryByText(/需要本人授权及读取权限/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在原站打开' }))
    expect(window.hermesDesktop.openExternal).toHaveBeenCalledWith('https://example.com/report.pdf')
  })

  it('shows a server-checked video link as unread evidence and keeps the original-site fallback', async () => {
    const resolveVideoLink = vi.fn().mockResolvedValue({
      ok: true,
      resolution: {
        platform: 'youtube', status: 'original_site_only', capability: 'captions_candidate',
        source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', evidence_status: 'not_read',
        can_answer: false, can_play_in_app: false
      }
    })

    const transcribeVideoLink = vi.fn()
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        resolveVideoLink, transcribeVideoLink
      },
      openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByText(/尚未读取媒体或字幕/)).toBeTruthy())
    expect(resolveVideoLink).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ')
    expect(transcribeVideoLink).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在原站打开' }))
    expect(window.hermesDesktop.openExternal).toHaveBeenCalledWith('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  })

  it('distinguishes upload-required video from an unreadable link', async () => {
    const resolveVideoLink = vi.fn()
      .mockResolvedValueOnce({ ok: true, resolution: { platform: 'tiktok', status: 'upload_required', capability: 'upload_required', source_url: 'https://vm.tiktok.com/Z12345abc', evidence_status: 'not_read', can_answer: false, can_play_in_app: false } })
      .mockResolvedValueOnce({ ok: true, resolution: { platform: null, status: 'unreadable', capability: null, source_url: null, evidence_status: 'not_read', can_answer: false, can_play_in_app: false } })

    const transcribeVideoLink = vi.fn()
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        resolveVideoLink, transcribeVideoLink
      },
      openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    fireEvent.change(input, { target: { value: 'https://vm.tiktok.com/Z12345abc' } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByText(/需要上传视频或字幕/)).toBeTruthy())
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()

    fireEvent.change(input, { target: { value: 'https://example.com/video' } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByText(/无法确认可读取的视频链接/)).toBeTruthy())
    expect(transcribeVideoLink).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
  })

  it('automatically transcribes a supported video, without enabling Q&A before timed evidence is ready', async () => {
    const url = 'https://www.iesdouyin.com/share/video/123456'

    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'douyin-transcript.srt', kind: 'subtitle',
      status: 'ready', storageMode: 'local', sourceUrl: url, evidenceOrigin: 'linked_video_audio',
      anchors: [{ id: 'a1', location: { start_seconds: 1, end_seconds: 2 }, text: '真实片段' }],
      notes: [], questions: []
    }

    const resolveVideoLink = vi.fn().mockResolvedValue({
      ok: true, resolution: { platform: 'douyin', status: 'original_site_only', capability: 'download_candidate',
        source_url: url, evidence_status: 'not_read', can_answer: false, can_play_in_app: false }
    })

    let finishTranscription!: (value: { ok: boolean; item: typeof item }) => void
    const transcribeVideoLink = vi.fn().mockReturnValue(new Promise(resolve => {finishTranscription = resolve}))
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValueOnce({ ok: true, items: [] }).mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item }), resolveVideoLink, transcribeVideoLink
      }, openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(transcribeVideoLink).toHaveBeenCalledWith(url))
    expect(resolveVideoLink).toHaveBeenCalledTimes(1)
    expect(transcribeVideoLink).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /正在获取媒体和转写/ })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '粘贴资料链接' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
    expect(screen.queryByRole('region', { name: '视频声音速览' })).toBeNull()
    finishTranscription({ ok: true, item })
    await waitFor(() => expect(screen.getByText(/仅依据真实视频声音转写及时间码/)).toBeTruthy())
    expect(screen.getByRole('log')).toBeTruthy()
    expect(screen.getByText(url, { exact: true })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '粘贴资料链接' })).toBeNull()
    expect(transcribeVideoLink).toHaveBeenCalledWith(url)
    expect(screen.getByRole('textbox', { name: '针对当前资料提问' })).toBeTruthy()
    expect(screen.getByText('0:01 起')).toBeTruthy()
  })

  it('keeps a failed untimed ASR result out of source history and Q&A', async () => {
    const url = 'https://www.iesdouyin.com/share/video/123456'
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        resolveVideoLink: vi.fn().mockResolvedValue({ ok: true, resolution: {
          platform: 'douyin', status: 'original_site_only', capability: 'download_candidate', source_url: url,
          evidence_status: 'not_read', can_answer: false, can_play_in_app: false
        } }),
        transcribeVideoLink: vi.fn().mockResolvedValue({ ok: false, code: 'timed_evidence_unavailable' })
      }, openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/未返回可靠时间码/))
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
    expect(screen.getByText(/尚无资料/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '转写视频声音' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '在原站打开' })).toBeTruthy()
  })

  it('rejects a bridge success without timed evidence', async () => {
    const url = 'https://www.iesdouyin.com/share/video/123456'
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        get: vi.fn(),
        resolveVideoLink: vi.fn().mockResolvedValue({ ok: true, resolution: {
          platform: 'douyin', status: 'original_site_only', capability: 'download_candidate', source_url: url,
          evidence_status: 'not_read', can_answer: false, can_play_in_app: false
        } }),
        transcribeVideoLink: vi.fn().mockResolvedValue({ ok: true, item: {
          id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'bad.srt', kind: 'subtitle',
          status: 'ready', anchors: [], notes: [], questions: []
        } })
      }, openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/未返回可靠时间码/))
    expect(window.hermesDesktop.analysisDocuments?.get).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
  })

  it('does not auto-transcribe while account cloud storage is unavailable', async () => {
    const url = 'https://www.iesdouyin.com/share/video/123456'
    const transcribeVideoLink = vi.fn()
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'cloud', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        resolveVideoLink: vi.fn().mockResolvedValue({ ok: true, resolution: {
          platform: 'douyin', status: 'original_site_only', capability: 'download_candidate', source_url: url,
          evidence_status: 'not_read', can_answer: false, can_play_in_app: false
        } }),
        transcribeVideoLink
      }, openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByText(/尚未读取媒体或字幕/)).toBeTruthy())
    expect(transcribeVideoLink).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '转写视频声音' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '选择本地视频转写' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
  })

  it('opens uploaded-video audio evidence only after a timed transcript is returned', async () => {
    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip-audio-transcript.srt',
      kind: 'subtitle', status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
      anchors: [{ id: 'a1', location: { start_seconds: 1, end_seconds: 2 }, text: '真实片段' }],
      notes: [], questions: []
    }

    let finishUpload!: (value: { ok: boolean; item: typeof item }) => void
    const uploadVideo = vi.fn().mockReturnValue(new Promise(resolve => {finishUpload = resolve}))
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValueOnce({ ok: true, items: [] }).mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item }), uploadVideo
      }
    } as never

    render(<AnalysisView />)
    expect(screen.getByText(/本地视频将临时上传到 APEX/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: '选择本地视频转写' }))
    expect(uploadVideo).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
    expect(screen.getByRole('button', { name: /正在上传并转写视频/ })).toBeTruthy()
    finishUpload({ ok: true, item })
    await waitFor(() => expect(screen.getByText(/仅依据真实视频声音转写及时间码/)).toBeTruthy())
    expect(screen.getByRole('textbox', { name: '针对当前资料提问' })).toBeTruthy()
    expect(screen.getByText('0:01 起')).toBeTruthy()
  })

  it('only makes a Feishu link answerable after authorized body import', async () => {
    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'Quarterly report', kind: 'feishu',
      status: 'ready', storageMode: 'local', anchors: [{ id: 'block12345', location: { block: 'block12345', paragraph: 1 }, text: 'Revenue grew' }],
      notes: [], questions: []
    }

    const importLink = vi.fn().mockResolvedValueOnce({ ok: false, code: 'feishu_authorization_required' }).mockResolvedValueOnce({ ok: true, item })
    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [item] }),
        get: vi.fn().mockResolvedValue({ ok: true, item }),
        importLink,
        authorizeFeishu: vi.fn().mockResolvedValue({ ok: true, flow_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', interval: 0 }),
        pollFeishu: vi.fn().mockResolvedValue({ ok: true, status: 'authorized' })
      }
    } as never

    render(<AnalysisView />)
    fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), { target: { value: 'https://team.feishu.cn/docx/docxtoken123' } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/正文尚未获授权读取/))
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '授权飞书' }))
    await waitFor(() => expect(screen.getByText('已授权，可读取链接')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '针对当前资料提问' })).toBeTruthy())
    expect(importLink).toHaveBeenCalledTimes(2)
  })
})
