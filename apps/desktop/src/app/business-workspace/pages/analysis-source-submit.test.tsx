import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { render } from '../test-render'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')

  return { useI18n: () => ({ locale: 'zh', t: zh }) }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  $connection.set(null)
})

describe('analysis source submission', () => {
  it('waits for explicit Enter, extracts a shared URL, and retains the draft for a timed-evidence retry', async () => {
    const shared = '把7天压缩到了10分钟 # Ski... https://v.douyin.com/fwkul39fT3A/ Jvf:/ 11/06 P@x.sE :4pm'
    const url = 'https://v.douyin.com/fwkul39fT3A/'

    const item = {
      id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'shared-video.srt',
      kind: 'subtitle', status: 'ready', storageMode: 'local', sourceUrl: url, evidenceOrigin: 'video_audio',
      anchors: [{ id: 'a1', location: { start_seconds: 1, end_seconds: 2 }, text: '真实片段' }],
      notes: [], questions: []
    }

    const resolveVideoLink = vi.fn().mockResolvedValue({ ok: true, resolution: {
      platform: 'douyin', status: 'original_site_only', capability: 'download_candidate', source_url: url,
      evidence_status: 'not_read', can_answer: false, can_play_in_app: false
    } })

    const transcribeVideoLink = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'timed_evidence_unavailable' })
      .mockResolvedValueOnce({ ok: true, item })

    const get = vi.fn().mockResolvedValue({ ok: true, item })
    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [] }), get, resolveVideoLink, transcribeVideoLink
    }, openExternal: vi.fn() } as never

    render(<AnalysisView />)
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    expect(screen.getByRole('button', { name: '打开链接' }).hasAttribute('disabled')).toBe(true)
    await screen.findByText('尚无资料。导入文档或 SRT/VTT 字幕开始。')
    fireEvent.change(input, { target: { value: shared } })
    expect(screen.getByText(/已识别到链接/)).toBeTruthy()
    expect(resolveVideoLink).not.toHaveBeenCalled()
    expect(transcribeVideoLink).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true)
    expect(resolveVideoLink).not.toHaveBeenCalled()
    fireEvent.compositionStart(input)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
    expect(resolveVideoLink).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/未返回可靠时间码/))
    expect(resolveVideoLink).toHaveBeenCalledExactlyOnceWith(url)
    expect(transcribeVideoLink).toHaveBeenCalledExactlyOnceWith(url)
    expect((input as HTMLInputElement).value).toBe(shared)
    expect(get).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    await screen.findByRole('textbox', { name: '针对当前资料提问' })
    expect(transcribeVideoLink).toHaveBeenCalledTimes(2)
    expect(transcribeVideoLink).toHaveBeenLastCalledWith(url)
    expect(get).toHaveBeenCalledWith(item.id)
    expect(screen.getByText(url, { exact: true })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '粘贴资料链接' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回资料入口' }))
    expect((screen.getByRole('textbox', { name: '粘贴资料链接' }) as HTMLInputElement).value).toBe('')
  })

  it('routes a shared Feishu document through the same form submit without invoking video tools', async () => {
    const url = 'https://acme.feishu.cn/wiki/abc'
    const importLink = vi.fn().mockResolvedValue({ ok: false, code: 'permission_denied' })
    const resolveVideoLink = vi.fn()
    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [] }), importLink, resolveVideoLink
    } } as never
    render(<AnalysisView />)
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    fireEvent.change(input, { target: { value: `文档地址：${url}。` } })
    expect(screen.getByRole('button', { name: '授权飞书' })).toBeTruthy()
    expect(importLink).not.toHaveBeenCalled()
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(importLink).toHaveBeenCalledExactlyOnceWith(url))
    expect(resolveVideoLink).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe(`文档地址：${url}。`)
  })

  it.each([
    ['不是链接', /未找到有效的 HTTPS 链接/],
    ['http://v.douyin.com/abc/', /未找到有效的 HTTPS 链接/],
    ['https://user:password@v.douyin.com/abc/', /未找到有效的 HTTPS 链接/],
    ['https://v.douyin.com/abc/ https://v.douyin.com/def/', /识别到多个不同链接/]
  ])('keeps invalid or ambiguous input actionable without submitting: %s', (value, hint) => {
    const importLink = vi.fn()
    const resolveVideoLink = vi.fn()
    window.hermesDesktop = { analysisDocuments: {
      policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
      list: vi.fn().mockResolvedValue({ ok: true, items: [] }), importLink, resolveVideoLink
    } } as never
    render(<AnalysisView />)
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    fireEvent.change(input, { target: { value } })
    expect(screen.getByRole('button', { name: '打开链接' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(hint)).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.submit(input.closest('form')!)
    expect(importLink).not.toHaveBeenCalled()
    expect(resolveVideoLink).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe(value)
  })
})
