import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { workflowDomainChanged } from '../api/read-revision'

import { AnalysisView } from './analysis-page'

vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')

  return { useI18n: () => ({ locale: 'zh', t: zh }) }
})

const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); $connection.set(null)

  if (scrollDescriptor) {Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor)}
  else {Reflect.deleteProperty(Element.prototype, 'scrollIntoView')}
})

const base = { id: 'local-a', filename: 'actual.xlsx', kind: 'excel', status: 'ready', storageMode: 'local', notes: [], questions: [] }

function bridge(item: object) {
  const get = vi.fn().mockResolvedValue({ ok: true, item })
  const addNote = vi.fn().mockResolvedValue({ ok: true })
  window.hermesDesktop = { analysisDocuments: {
    policy: vi.fn().mockResolvedValue({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } }),
    list: vi.fn().mockResolvedValue({ ok: true, items: [item] }), get, addNote
  } } as never

  return { get, addNote }
}

describe('prototype analysis navigation with actual sources', () => {
  it('shows sparse worksheet cells and saves a note against the selected actual cell', async () => {
    const { addNote } = bridge({ ...base, anchors: [
      { id: 'actual-a1', location: { sheet: 'Sales', cell: 'A1' }, text: 'Recorded product' },
      { id: 'actual-c3', location: { sheet: 'Sales', cell: 'C3' }, text: '423' }
    ] })

    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /actual.xlsx/ }))
    const sheet = await screen.findByRole('table', { name: /Sales/ })
    expect(within(sheet).getAllByRole('row')).toHaveLength(3)
    expect(within(sheet).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['行', 'A', 'C'])
    fireEvent.click(within(sheet).getByRole('button', { name: /C3: 423/ }))
    const note = screen.getByRole('textbox', { name: '记录你的发现' })
    fireEvent.change(note, { target: { value: 'Check this recorded value' } })
    fireEvent.click(screen.getByRole('button', { name: '保存笔记' }))
    await waitFor(() => expect(addNote).toHaveBeenCalledExactlyOnceWith('local-a', 'Check this recorded value', 'actual-c3'))
  })

  it('reveals the existing video before seeking a citation from notes and keeps the unsaved note', async () => {
    const scroll = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:paired-actual'); static revokeObjectURL = vi.fn() })
    bridge({ ...base, filename: 'actual.srt', kind: 'subtitle', evidenceOrigin: 'uploaded_video_audio',
      anchors: [{ id: 'speech-12', location: { start_seconds: 12, end_seconds: 15 }, text: 'Recorded speech' }],
      questions: [{ id: 'q1', question: 'What was said?', answer: 'Recorded speech', answer_type: 'literal',
        citations: [{ anchor_id: 'speech-12', location: { start_seconds: 12 } }] }] })
    const onDeepBreakdown = vi.fn()
    render(<AnalysisView onDeepBreakdown={onDeepBreakdown} />)
    fireEvent.click(await screen.findByRole('button', { name: /actual.srt/ }))
    fireEvent.change(await screen.findByLabelText('选择本地视频播放'), { target: { files: [new File(['video'], 'actual.mp4', { type: 'video/mp4' })] } })
    const player = screen.getByLabelText('本地视频: actual.mp4') as HTMLVideoElement
    fireEvent.mouseDown(screen.getByRole('tab', { name: '研究笔记' }), { button: 0, ctrlKey: false })
    const note = screen.getByRole('textbox', { name: '记录你的发现' })
    fireEvent.change(note, { target: { value: 'Keep my unsaved note' } })
    expect(player.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '查看出处 · 0:12 起' }))
    expect(player.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByLabelText('本地视频: actual.mp4')).toBe(player)
    expect(player.currentTime).toBe(12)
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    fireEvent.mouseDown(screen.getByRole('tab', { name: '研究笔记' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('textbox', { name: '记录你的发现' })).toBe(note)
    expect((note as HTMLTextAreaElement).value).toBe('Keep my unsaved note')
    fireEvent.mouseDown(screen.getByRole('tab', { name: '深度拆解' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('button', { name: '准备深度拆解' })).toBeTruthy()
    expect(onDeepBreakdown).not.toHaveBeenCalled()
  })

  it('keeps a background source refresh from returning the reader after going back to the source hub', async () => {
    vi.spyOn(globalThis.document, 'hasFocus').mockReturnValue(true)
    const { get } = bridge({ ...base, anchors: [] })
    render(<AnalysisView />)
    fireEvent.click(await screen.findByRole('button', { name: /actual.xlsx/ }))
    await screen.findByRole('heading', { name: 'actual.xlsx' })
    fireEvent.click(screen.getByRole('button', { name: '返回资料入口' }))
    expect(screen.getByRole('heading', { name: '选择资料来源' })).toBeTruthy()
    act(() => workflowDomainChanged())
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: '阅读伙伴' })).toBeNull()
  })
})
