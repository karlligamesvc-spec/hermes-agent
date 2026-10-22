// hc-1016 记得你 v1: the 「记下了 · 撤销」 line under a reply. Rendered through the
// real Thread so the mount point in assistant-message.tsx is exercised; with
// `desktop_features.single_thread` off the transcript must be byte-for-byte
// what it was before the line existed (hard rule 11).
import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MEMORY_LEDGER_COPY } from '@/app/memory-ledger/memory-ledger-copy'
import type { DesktopMemoryLedger, DesktopMemoryLedgerRequest, DesktopMemoryLedgerResult } from '@/lib/memory-ledger'
import { $authState } from '@/store/auth'
import { $memoryLedger } from '@/store/memory-ledger'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { createdAt, stubThreadEnvironment, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

type Bridge = (request: DesktopMemoryLedgerRequest) => Promise<DesktopMemoryLedgerResult>

stubThreadEnvironment()

const ID = '3f2a9c1d-0000-4000-8000-000000000001'
const copy = MEMORY_LEDGER_COPY.en.noted

const LEDGER: DesktopMemoryLedger = {
  aboutYou: [],
  limits: { aboutYouMax: 30, contentMaxChars: 100, recentKeepDays: 30, recentMax: 50 },
  recent: []
}

function messages(created = true): ThreadMessage[] {
  const t = createdAt.getTime() / 1000

  const result = JSON.stringify({
    action: 'add',
    created,
    entry: { content: 'never shows face', id: ID, kind: 'about_you', ref: '3f2a9c1d' },
    ok: true
  })

  return [
    {
      attachments: [],
      content: [{ text: 'I never show my face', type: 'text' }],
      createdAt,
      id: 'user-1',
      metadata: { custom: { timelineTimestamp: t } },
      role: 'user'
    },
    {
      content: [
        {
          args: { action: 'add', content: 'never shows face', kind: 'about_you' },
          argsText: '{}',
          result,
          toolCallId: 'call-1',
          toolName: 'apex_memory',
          type: 'tool-call'
        },
        { completedAt: t + 0.5, text: 'Got it, hands-only shots.', timestamp: t + 0.1, type: 'text' }
      ],
      createdAt,
      id: 'assistant-1',
      metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' }
    }
  ] as unknown as ThreadMessage[]
}

function renderThread(list = messages()) {
  return render(
    <ThreadRuntime messages={list}>
      <Thread />
    </ThreadRuntime>
  )
}

function install(bridge: Bridge) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    clientConfig: { get: async () => ({ payload: { desktop_features: { single_thread: true } } }) },
    managed: { memoryLedger: bridge }
  }
}

// React's client ids differ between two renders; nothing else may.
const stable = (html: string) => html.replace(/(id|aria-[a-z]+|for)="[^"]*"/g, '$1=""')

describe('记下了 line (hc-1016)', () => {
  beforeEach(() => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('product')
    $authState.set({
      account: { email: 'a@example.test', name: 'Lin', plan: 'free' },
      accountId: 'acc-1',
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })
  })

  afterEach(() => {
    cleanup()
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('switched on: one line under the reply, and 撤销 deletes the entry for real', async () => {
    const bridge = vi.fn<Bridge>(async () => ({ ledger: LEDGER, ok: true }))

    install(bridge)
    $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
    const { baseElement } = renderThread()

    expect(await screen.findByText(copy.line('never shows face'))).toBeTruthy()
    expect(baseElement.querySelectorAll('[data-memory-noted] p')).toHaveLength(1)
    // The engine wrote through its own key: the page and prompt copy are re-read once.
    await waitFor(() => expect(bridge).toHaveBeenCalledWith({ action: 'get' }))

    fireEvent.click(screen.getByRole('button', { name: copy.undo }))

    expect(await screen.findByText(copy.undone('never shows face'))).toBeTruthy()
    expect(bridge).toHaveBeenCalledWith({ action: 'remove', id: ID })
    expect(screen.queryByRole('button', { name: copy.undo })).toBeNull()
  })

  it('a failed undo says where to delete it instead', async () => {
    install(async request => (request.action === 'remove' ? { ledger: null, ok: false } : { ledger: LEDGER, ok: true }))
    $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
    renderThread()

    fireEvent.click(await screen.findByRole('button', { name: copy.undo }))

    expect(await screen.findByText(copy.undoFailed)).toBeTruthy()
  })

  it('a sentence already remembered is not announced again', async () => {
    install(async () => ({ ledger: LEDGER, ok: true }))
    $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
    const { baseElement } = renderThread(messages(false))

    await screen.findByText('Got it, hands-only shots.')
    expect(baseElement.querySelector('[data-memory-noted]')).toBeNull()
  })

  it.each(['off', 'idle', 'unavailable'] as const)(
    'with the ledger %s the transcript is exactly what it was without the line',
    async status => {
      const bridge = vi.fn<Bridge>(async () => ({ ledger: LEDGER, ok: true }))

      install(bridge)
      $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
      const on = renderThread()
      await screen.findByText(copy.line('never shows face'))
      const line = on.baseElement.querySelector('[data-memory-noted]')

      expect(line).not.toBeNull()
      line?.remove()
      const withoutLine = stable(on.baseElement.innerHTML)
      cleanup()

      $memoryLedger.set({ accountId: 'acc-1', ledger: null, status })
      const off = renderThread()
      await screen.findByText('Got it, hands-only shots.')

      expect(off.baseElement.querySelector('[data-memory-noted]')).toBeNull()
      expect(screen.queryByText(/Noted:/)).toBeNull()
      expect(stable(off.baseElement.innerHTML)).toBe(withoutLine)
    }
  )

  it.each([
    ['the switch off', () => setSingleThreadFlagForTest(false)],
    ['开发者模式', () => setToolViewMode('technical')]
  ])('with %s a ready ledger still shows no line', async (_label, arrange) => {
    install(async () => ({ ledger: LEDGER, ok: true }))
    $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
    arrange()
    const { baseElement } = renderThread()

    await screen.findByText('Got it, hands-only shots.')
    expect(baseElement.querySelector('[data-memory-noted]')).toBeNull()
  })

  it('another account’s ledger state does not switch the line on', async () => {
    install(async () => ({ ledger: LEDGER, ok: true }))
    $memoryLedger.set({ accountId: 'acc-2', ledger: LEDGER, status: 'ready' })
    const { baseElement } = renderThread()

    await screen.findByText('Got it, hands-only shots.')
    expect(baseElement.querySelector('[data-memory-noted]')).toBeNull()
  })
})
