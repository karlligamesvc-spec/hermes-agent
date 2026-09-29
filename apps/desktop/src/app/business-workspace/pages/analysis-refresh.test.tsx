import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $authState } from '@/store/auth'
import { setDocumentHidden } from '@/test/window-state'

import type { AnalysisDocument } from '../analysis-types'
import { WORKFLOW_DOMAIN_POLL_INTERVAL_MS } from '../api/read-revision'

import { AnalysisView } from './analysis-page'

class WindowChannel extends EventTarget {
  static all = new Set<WindowChannel>()
  constructor(public name: string) {super(); WindowChannel.all.add(this)}
  postMessage(value: unknown) {
    for (const channel of WindowChannel.all) {
      if (channel !== this && channel.name === this.name) {channel.dispatchEvent(new MessageEvent('message', { data: value }))}
    }
  }
}

let focused = true
const initialAuth = $authState.get()

const source = (name = 'Original'): AnalysisDocument => ({
  id: 'source-a', filename: `${name}.txt`, kind: 'text', status: 'ready', storageMode: 'cloud',
  analysis_scope: 'A', analysis_revision: 'revision', anchors: [], questions: [],
  notes: [{ id: 'note', body: `${name} note`, anchor_id: null }],
  deep_reports: [{ id: 'report', filename: 'ANALYSIS.md', body: `${name} report`, revision: 'revision',
    sha256: 'a'.repeat(64), provenance: 'selected_file', created_at: '2026-09-29T01:00:00Z' }]
})

function account(id: string) {$authState.set({ ...$authState.get(), enabled: true, status: 'signed-in', accountId: id })}

async function flush() {await act(async () => {await Promise.resolve(); await Promise.resolve(); await Promise.resolve()})}

function mount() {return render(<MemoryRouter><I18nProvider configClient={null} initialLocale="zh"><AnalysisView /></I18nProvider></MemoryRouter>)}

function bridge(methods: Record<string, unknown>) {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { analysisDocuments: {
    policy: vi.fn(async () => ({ ok: true, policy: { mode: 'cloud', cloud_storage_configured: true } })), ...methods
  } } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('BroadcastChannel', WindowChannel)
  focused = true
  setDocumentHidden(false)
  vi.spyOn(globalThis.document, 'hasFocus').mockImplementation(() => focused)
  account('A')
})
afterEach(async () => {
  cleanup()
  await act(async () => vi.advanceTimersByTimeAsync(1001))
  $authState.set(initialAuth)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setDocumentHidden(false)
})

describe('Analysis reconciles account-owned source snapshots', () => {
  it('refreshes ready cloud sources, notes and reports for peer writes, polling and focus; retains drafts and failed-read facts', async () => {
    let current = source()
    let missing = false
    const list = vi.fn(async () => ({ ok: true, items: missing ? [] : [structuredClone(current)] }))
    const get = vi.fn(async () => missing ? { ok: false, code: 'source_not_found' } : { ok: true, item: structuredClone(current) })
    bridge({ list, get, reviewDeepReport: vi.fn() })
    mount(); await flush()
    act(() => fireEvent.click(screen.getByRole('button', { name: /Original.txt/ }))); await flush()
    expect(screen.getByText('Original note')).toBeTruthy()
    act(() => {
      fireEvent.change(screen.getByRole('textbox', { name: '记录你的发现' }), { target: { value: 'Unsaved note' } })
      fireEvent.change(screen.getByRole('textbox', { name: '针对当前资料提问' }), { target: { value: 'Unsaved question' } })
      fireEvent.change(screen.getByLabelText('验收备注'), { target: { value: 'Unsaved review' } })
    })

    current = source('Other device')
    current.deep_reports![0].review = { decision: 'changes_requested', note: 'Other device verdict', reviewed_at: '2026-09-29T02:00:00Z' }
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_DOMAIN_POLL_INTERVAL_MS))
    expect(screen.getByRole('heading', { name: 'Other device.txt' })).toBeTruthy()
    expect(screen.getByText('Other device note')).toBeTruthy()
    expect(screen.getByText('Other device report')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '记录你的发现' })).toHaveProperty('value', 'Unsaved note')
    expect(screen.getByRole('textbox', { name: '针对当前资料提问' })).toHaveProperty('value', 'Unsaved question')
    expect(screen.getByLabelText('验收备注')).toHaveProperty('value', 'Unsaved review')
    expect(screen.getByText('你已要求修改', { exact: false })).toBeTruthy()

    const peer = new WindowChannel('apex:workflow-domain')
    current = source('Other window')
    await act(async () => peer.postMessage(1)); await flush()
    expect(screen.getByText('Other window report')).toBeTruthy()
    list.mockResolvedValueOnce({ ok: true, items: [], cloudUnavailable: true } as never)
    get.mockResolvedValueOnce({ ok: false, code: 'connection_failed' } as never)
    await act(async () => peer.postMessage(1)); await flush()
    expect(screen.getByRole('button', { name: /Other window.txt/ })).toBeTruthy()
    expect(screen.getByText('Other window note')).toBeTruthy()
    expect(screen.getByText('暂时无法刷新最新状态，请检查连接后重试。')).toBeTruthy()
    current = source('Recovered')
    act(() => fireEvent.click(screen.getByRole('button', { name: '重试刷新' }))); await flush()
    expect(screen.getByText('Recovered report')).toBeTruthy()
    expect(screen.queryByText('暂时无法刷新最新状态，请检查连接后重试。')).toBeNull()

    focused = false; setDocumentHidden(true)
    act(() => {window.dispatchEvent(new Event('blur')); globalThis.document.dispatchEvent(new Event('visibilitychange'))})
    const calls = get.mock.calls.length
    current = source('While away')
    await act(async () => peer.postMessage(1))
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_DOMAIN_POLL_INTERVAL_MS * 2))
    expect(get).toHaveBeenCalledTimes(calls)
    focused = true; setDocumentHidden(false)
    act(() => {window.dispatchEvent(new Event('focus')); globalThis.document.dispatchEvent(new Event('visibilitychange'))}); await flush()
    expect(get).toHaveBeenCalledTimes(calls + 1)
    expect(screen.getByText('While away note')).toBeTruthy()

    missing = true
    await act(async () => peer.postMessage(1)); await flush()
    expect(screen.queryByRole('heading', { name: 'While away.txt' })).toBeNull()
    expect(screen.queryByText('While away report')).toBeNull()
    expect(screen.getByText('尚无资料。导入文档或 SRT/VTT 字幕开始。')).toBeTruthy()
  })

  it('coalesces slow periodic reads and discards a late response after the account changes', async () => {
    let finish!: (value: { ok: true; item: AnalysisDocument }) => void

    const get = vi.fn().mockResolvedValueOnce({ ok: true, item: source() })
      .mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))

    const list = vi.fn(async () => ({ ok: true, items: $authState.get().accountId === 'A' ? [source()] : [] }))
    bridge({ list, get })
    mount(); await flush()
    act(() => fireEvent.click(screen.getByRole('button', { name: /Original.txt/ }))); await flush()
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOW_DOMAIN_POLL_INTERVAL_MS * 3))
    expect(get).toHaveBeenCalledTimes(2)
    act(() => account('B')); await flush()
    await act(async () => finish({ ok: true, item: source('Private account A') }))
    expect(screen.queryByText(/Private account A/)).toBeNull()
    expect(screen.queryByText('Original note')).toBeNull()
  })

  it.each([
    { status: 'processing', allowed: true, visible: true },
    { status: 'processing', allowed: false, visible: false },
    { status: 'ready', allowed: false, visible: false },
    { status: 'failed', allowed: true, visible: true }
  ] as const)('offers the server-authorized cloud retry for $status / $allowed without completing a pending parse', async ({ status, allowed, visible }) => {
    let item: AnalysisDocument = { ...source(), status, can_retry: allowed }

    const retry = vi.fn(async () => {item = { ...item, status: 'processing', can_retry: false };

 return { ok: true }})

    bridge({ list: vi.fn(async () => ({ ok: true, items: [item] })), get: vi.fn(async () => ({ ok: true, item })), retry })
    mount(); await flush()
    act(() => fireEvent.click(screen.getByRole('button', { name: /Original.txt/ }))); await flush()
    expect(Boolean(screen.queryByRole('button', { name: '重试解析' }))).toBe(visible)

    if (visible) {
      act(() => fireEvent.click(screen.getByRole('button', { name: '重试解析' }))); await flush()
      expect(retry).toHaveBeenCalledExactlyOnceWith(item.id)
      expect(screen.queryByRole('button', { name: '重试解析' })).toBeNull()
      expect(screen.queryByRole('textbox', { name: '针对当前资料提问' })).toBeNull()
      expect(screen.getAllByText('正在解析原文…').length).toBeGreaterThan(0)
    }
  })
})
