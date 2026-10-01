import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')

  return { useI18n: () => ({ locale: 'zh', t: zh }) }
})

const initialAuth = $authState.get()

const source = { id: 'owned-a', kind: 'subtitle', filename: 'actual.srt', status: 'ready', storageMode: 'local',
  anchors: [{ id: 'a1', location: { start_seconds: 1, end_seconds: 2 }, text: 'Actual speech' }], notes: [], questions: [] }

const resolution = { source_url: 'https://v.douyin.com/account-a/', platform: 'douyin', capability: 'download_candidate', status: 'original_site_only' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })

  return { promise, resolve }
}

function account(id: string) {
  $authState.set({ ...initialAuth, enabled: true, status: 'signed-in', accountId: id,
    account: { email: `${id}@example.com`, name: id, plan: '' } })
}

function sourceBridge(extra: object = {}) {
  const policy = vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } })
  const list = vi.fn().mockResolvedValue({ ok: true, items: [] })
  const get = vi.fn().mockResolvedValue({ ok: true, item: source })
  const resolveVideoLink = vi.fn().mockResolvedValue({ ok: true, resolution })
  const transcribeVideoLink = vi.fn().mockResolvedValue({ ok: true, item: source })
  const importLink = vi.fn().mockResolvedValue({ ok: true, item: source })
  const importFile = vi.fn().mockResolvedValue({ ok: true, item: source })
  const api = { policy, list, get, resolveVideoLink, transcribeVideoLink, importLink, importFile, ...extra }
  window.hermesDesktop = { analysisDocuments: api } as never

  return api
}

beforeEach(() => account('account-a'))
afterEach(() => { cleanup(); $authState.set(initialAuth); vi.restoreAllMocks() })

describe('source actions keep their originating account across async stages', () => {
  it('discards account A resolution before a write can be initiated for account B', async () => {
    const pending = deferred<{ ok: boolean; resolution: typeof resolution }>()
    const resolveVideoLink = vi.fn().mockReturnValueOnce(pending.promise)
    const api = sourceBridge({ resolveVideoLink })
    render(<AnalysisView />)
    await screen.findByText('尚无资料。导入文档或 SRT/VTT 字幕开始。')
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    fireEvent.change(input, { target: { value: resolution.source_url } })
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    expect(resolveVideoLink).toHaveBeenCalledOnce()
    act(() => account('account-b'))
    await waitFor(() => expect(screen.getByRole('button', { name: '导入文档或字幕' }).hasAttribute('disabled')).toBe(false))
    fireEvent.change(input, { target: { value: 'https://v.douyin.com/account-b/' } })
    await act(async () => pending.resolve({ ok: true, resolution }))
    expect(api.transcribeVideoLink).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('https://v.douyin.com/account-b/')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '打开链接' }).hasAttribute('disabled')).toBe(false)
  })

  it.each(['video', 'feishu', 'file'])('does not open account A source after its %s list refresh finishes for account B', async kind => {
    const pending = deferred<{ ok: boolean; items: typeof source[] }>()
    let reads = 0

    const list = vi.fn(() => {
      reads += 1

      return reads > 1 && $authState.get().accountId === 'account-a' ? pending.promise : Promise.resolve({ ok: true, items: [] })
    })

    const api = sourceBridge({ list })
    render(<AnalysisView />)
    await screen.findByText('尚无资料。导入文档或 SRT/VTT 字幕开始。')

    if (kind === 'file') {fireEvent.click(screen.getByRole('button', { name: '导入文档或字幕' }))}
    else {
      fireEvent.change(screen.getByRole('textbox', { name: '粘贴资料链接' }), {
        target: { value: kind === 'feishu' ? 'https://acme.feishu.cn/docx/account-a' : resolution.source_url }
      })
      fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    }

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2))
    act(() => account('account-b'))
    await waitFor(() => expect(screen.getByRole('button', { name: '导入文档或字幕' }).hasAttribute('disabled')).toBe(false))
    const input = screen.getByRole('textbox', { name: '粘贴资料链接' })
    fireEvent.change(input, { target: { value: 'https://v.douyin.com/account-b/' } })
    await act(async () => pending.resolve({ ok: true, items: [source] }))
    expect(api.get).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'actual.srt' })).toBeNull()
    expect((input as HTMLInputElement).value).toBe('https://v.douyin.com/account-b/')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
