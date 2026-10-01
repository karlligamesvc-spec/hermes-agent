import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')

  return { useI18n: () => ({ locale: 'zh', t: zh }) }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const source = (id: string) => ({
  anchors: [], filename: `${id}.txt`, id, kind: 'text', notes: [], questions: [], status: 'ready', storageMode: 'local'
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })

  return { promise, resolve }
}

function setBridge(get: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  window.hermesDesktop = { analysisDocuments: {
    get,
    list: vi.fn().mockResolvedValue({ ok: true, items: [source('a'), source('b')] }),
    policy: vi.fn().mockResolvedValue({ ok: true, policy: { cloud_storage_configured: false, mode: 'local' } }),
    ...extra
  } } as never
}

describe('analysis source selection', () => {
  it('keeps a failed history read distinct from a real empty history and retries', async () => {
    setBridge(vi.fn(), {
      list: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, items: [] })
    })
    render(<AnalysisView />)

    expect(await screen.findByText('资料记录读取失败。')).toBeTruthy()
    expect(screen.queryByText('尚无资料。导入文档或 SRT/VTT 字幕开始。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
    expect(await screen.findByText('尚无资料。导入文档或 SRT/VTT 字幕开始。')).toBeTruthy()
  })

  it('does not replace a newer source list with an older response', async () => {
    const first = deferred<{ items: ReturnType<typeof source>[]; ok: true }>()
    const list = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true, items: [source('b')] })
    setBridge(vi.fn(async (id: string) => ({ ok: true, item: source(id) })), {
      importFile: vi.fn().mockResolvedValue({ ok: true, item: source('b') }),
      list
    })
    render(<AnalysisView />)

    const importButton = screen.getByRole('button', { name: '导入文档或字幕' })
    await waitFor(() => expect(importButton.hasAttribute('disabled')).toBe(false))
    fireEvent.click(importButton)
    expect(await screen.findByRole('heading', { name: 'b.txt' })).toBeTruthy()

    await act(async () => first.resolve({ ok: true, items: [source('a')] }))
    expect(screen.queryByRole('button', { name: /a.txt/ })).toBeNull()
    expect(screen.getByRole('button', { name: /b.txt/ })).toBeTruthy()
  })

  it('shows loading for the selected source and discards an older source response', async () => {
    const first = deferred<{ item: ReturnType<typeof source>; ok: true }>()
    const second = deferred<{ item: ReturnType<typeof source>; ok: true }>()
    setBridge(vi.fn((id: string) => id === 'a' ? first.promise : second.promise))
    render(<AnalysisView />)

    fireEvent.click(await screen.findByRole('button', { name: /a.txt/ }))
    expect(screen.getByText('正在打开资料…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /b.txt/ }))

    await act(async () => first.resolve({ ok: true, item: source('a') }))
    expect(screen.queryByRole('heading', { name: 'a.txt' })).toBeNull()
    expect(screen.getByText('正在打开资料…')).toBeTruthy()

    await act(async () => second.resolve({ ok: true, item: source('b') }))
    expect(screen.getByRole('heading', { name: 'b.txt' })).toBeTruthy()
  })

  it('removes the previous source and its note draft immediately on selection', async () => {
    const second = deferred<{ item: ReturnType<typeof source>; ok: true }>()
    setBridge(vi.fn((id: string) => id === 'a' ? Promise.resolve({ ok: true, item: source('a') }) : second.promise))
    render(<AnalysisView />)

    fireEvent.click(await screen.findByRole('button', { name: /a.txt/ }))
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '研究笔记' }), { button: 0, ctrlKey: false })
    fireEvent.change(await screen.findByLabelText('记录你的发现'), { target: { value: 'A 的私有笔记' } })
    fireEvent.click(screen.getByRole('button', { name: /a.txt/ }))
    expect(screen.getByLabelText('记录你的发现')).toHaveProperty('value', 'A 的私有笔记')
    fireEvent.click(screen.getByRole('button', { name: /b.txt/ }))

    expect(screen.queryByRole('heading', { name: 'a.txt' })).toBeNull()
    expect(screen.queryByDisplayValue('A 的私有笔记')).toBeNull()
    expect(screen.getByText('正在打开资料…')).toBeTruthy()

    await act(async () => second.resolve({ ok: true, item: source('b') }))
    expect(screen.getByLabelText('记录你的发现')).toHaveProperty('value', '')
  })

  it('does not clear the next source draft when a previous note save completes', async () => {
    const saved = deferred<{ ok: true }>()
    setBridge(vi.fn(async (id: string) => ({ ok: true, item: source(id) })), {
      addNote: vi.fn(() => saved.promise)
    })
    render(<AnalysisView />)

    fireEvent.click(await screen.findByRole('button', { name: /a.txt/ }))
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '研究笔记' }), { button: 0, ctrlKey: false })
    fireEvent.change(await screen.findByLabelText('记录你的发现'), { target: { value: 'A note' } })
    fireEvent.click(screen.getByRole('button', { name: '保存笔记' }))
    fireEvent.click(screen.getByRole('button', { name: /b.txt/ }))
    await screen.findByRole('heading', { name: 'b.txt' })
    fireEvent.mouseDown(screen.getByRole('tab', { name: '研究笔记' }), { button: 0, ctrlKey: false })
    fireEvent.change(screen.getByLabelText('记录你的发现'), { target: { value: 'B draft' } })

    await act(async () => saved.resolve({ ok: true }))
    await waitFor(() => expect(screen.getByLabelText('记录你的发现')).toHaveProperty('value', 'B draft'))
    expect(screen.getByRole('heading', { name: 'b.txt' })).toBeTruthy()
  })

  it('does not restore a deleted source when its pending detail refresh completes', async () => {
    const refresh = deferred<{ item: ReturnType<typeof source>; ok: true }>()

    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, item: source('b') })
      .mockReturnValueOnce(refresh.promise)

    setBridge(get, {
      delete: vi.fn().mockResolvedValue({ ok: true }),
      list: vi.fn().mockResolvedValueOnce({ ok: true, items: [source('b')] }).mockResolvedValue({ ok: true, items: [] })
    })
    render(<AnalysisView />)

    fireEvent.click(await screen.findByRole('button', { name: /b.txt/ }))
    await screen.findByRole('heading', { name: 'b.txt' })
    fireEvent.click(screen.getByRole('button', { name: /b.txt/ }))
    fireEvent.click(screen.getByRole('button', { name: '删除资料' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'b.txt' })).toBeNull())

    await act(async () => refresh.resolve({ ok: true, item: source('b') }))
    expect(screen.queryByRole('heading', { name: 'b.txt' })).toBeNull()
  })
})
