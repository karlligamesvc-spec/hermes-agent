import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'zh' }) }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('document analysis evidence', () => {
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
    expect(screen.getByRole('button', { name: '取消飞书授权' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()

    fireEvent.change(input, { target: { value: 'https://example.com/report.pdf' } })
    expect(screen.getByText(/暂不支持直接读取此链接/)).toBeTruthy()
    expect(screen.queryByText(/需要本人授权及读取权限/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在原站打开' }))
    expect(window.hermesDesktop.openExternal).toHaveBeenCalledWith('https://example.com/report.pdf')
  })
})
