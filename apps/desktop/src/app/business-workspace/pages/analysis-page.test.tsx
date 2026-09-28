import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'zh' }) }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('document analysis evidence', () => {
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
        answer_type: 'source_excerpts', citations: [{ anchor_id: 'a1', location: { start_seconds: 62.5, end_seconds: 65 } }] }]
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

  it('keeps links unanswerable and distinguishes Feishu permission from unsupported URLs', async () => {
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
    expect(screen.getByRole('button', { name: '读取链接' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '授权飞书' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除平台保存的飞书授权' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()

    fireEvent.change(input, { target: { value: 'https://example.com/report.pdf' } })
    expect(screen.getByText(/暂不支持直接读取此链接/)).toBeTruthy()
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

    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        resolveVideoLink
      },
      openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } })
    fireEvent.click(screen.getByRole('button', { name: '检查视频链接' }))
    await waitFor(() => expect(screen.getByText(/尚未读取媒体或字幕/)).toBeTruthy())
    expect(resolveVideoLink).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ')
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在原站打开' }))
    expect(window.hermesDesktop.openExternal).toHaveBeenCalledWith('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  })

  it('distinguishes upload-required video from an unreadable link', async () => {
    const resolveVideoLink = vi.fn()
      .mockResolvedValueOnce({ ok: true, resolution: { platform: 'tiktok', status: 'upload_required', capability: 'upload_required', source_url: 'https://vm.tiktok.com/Z12345abc', evidence_status: 'not_read', can_answer: false, can_play_in_app: false } })
      .mockResolvedValueOnce({ ok: true, resolution: { platform: null, status: 'unreadable', capability: null, source_url: null, evidence_status: 'not_read', can_answer: false, can_play_in_app: false } })

    window.hermesDesktop = {
      analysisDocuments: {
        policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
        list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        resolveVideoLink
      },
      openExternal: vi.fn()
    } as never

    render(<AnalysisView />)
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    fireEvent.change(input, { target: { value: 'https://vm.tiktok.com/Z12345abc' } })
    fireEvent.click(screen.getByRole('button', { name: '检查视频链接' }))
    await waitFor(() => expect(screen.getByText(/需要上传视频或字幕/)).toBeTruthy())
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()

    fireEvent.change(input, { target: { value: 'https://example.com/video' } })
    fireEvent.click(screen.getByRole('button', { name: '检查视频链接' }))
    await waitFor(() => expect(screen.getByText(/无法确认可读取的视频链接/)).toBeTruthy())
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: '读取链接' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/正文尚未获授权读取/))
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '授权飞书' }))
    await waitFor(() => expect(screen.getByText('已授权，可读取链接')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '读取链接' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '针对当前资料提问' })).toBeTruthy())
    expect(importLink).toHaveBeenCalledTimes(2)
  })
})
