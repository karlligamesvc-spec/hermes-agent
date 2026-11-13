/**
 * hc-1226 产品模式下发 `/new`，几秒后输入框里又出现 `/new`: the one thread's `/new` on the composer's
 * own send paths, end to end inside the renderer.
 *
 * The real submit engine (use-composer-submit: clear the draft, send, put the words back if the send is
 * not accepted) and the real queue (use-composer-queue: drain, keep and retry an entry that is not
 * accepted) send through the real middleware chain into the real single-thread middleware, as ChatBar
 * wires them (index.tsx `submitThroughComposerMiddleware`). Only the engine is faked.
 *
 * `/new` used to answer the chain with a cancel after it had folded the thread: the typed `/new` came
 * back into the composer once the summary was done, and a queued `/new` stayed queued and was retried,
 * folding the thread again on every retry.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COMPOSER_AREAS, type ComposerDraft, submitThroughComposerMiddleware } from '@/app/chat/composer/contrib'
import { useComposerQueue } from '@/app/chat/composer/hooks/use-composer-queue'
import { useComposerSubmit } from '@/app/chat/composer/hooks/use-composer-submit'
import type { ChatBarProps } from '@/app/chat/composer/types'
import { registry } from '@/contrib/registry'
import { setRuntimeI18nLocale } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import {
  $parkedQueueSessions,
  $queuedPromptsBySession,
  enqueueQueuedPrompt,
  getQueuedPrompts,
  MAX_AUTO_DRAIN_ATTEMPTS
} from '@/store/composer-queue'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import {
  $activeSessionId,
  $busy,
  $gatewayState,
  $messages,
  $selectedStoredSessionId,
  setSessionsLoading
} from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'

import { type RequestGateway, singleThreadSend } from './composer-middleware'

const notices = vi.hoisted(() => [] as string[])

vi.mock('@/store/notifications', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  dismissNotification: vi.fn(),
  notify: vi.fn((input: { message?: string }) => {
    notices.push(String(input.message ?? ''))

    return `notice-${notices.length}`
  })
}))

const THREAD = 'thread-root'
const RESTARTED = '好，前面的我记着，从这儿重新来。'
const NOT_NOW = '这会儿还没法从头来，稍后再发一次。'

/** The engine: counts summaries, answers them (nothing to fold yet) or fails them. */
function engine(failCompress = false) {
  const compresses: unknown[] = []

  const request = (async (method: string, params?: unknown) => {
    if (method === 'session.compress') {
      compresses.push(params)

      if (failCompress) {
        throw new Error('compress failed')
      }

      return { summary: { noop: true } }
    }

    return {}
  }) as RequestGateway

  return { compresses, request }
}

/** The app's own submit, behind the chain (what a send the middleware let through reaches). */
function appSubmit() {
  const sent: string[] = []

  return { sent, submit: vi.fn(async (text: string) => (sent.push(text), true)) }
}

/** ChatBar's onSubmit: every send goes through the middleware chain, then the app's submit. */
function chatBarOnSubmit(submit: (text: string) => Promise<boolean>): ChatBarProps['onSubmit'] {
  return (text, options) => submitThroughComposerMiddleware(text, options, submit)
}

const disposers: Array<() => void> = []

function registerSingleThread(request: RequestGateway): void {
  disposers.push(
    registry.register({
      area: COMPOSER_AREAS.middleware,
      data: {
        handler: (draft: ComposerDraft) =>
          singleThreadSend(
            draft,
            () => request,
            () => 'default'
          )
      },
      id: 'single-thread-test',
      order: -100
    })
  )
}

function renderSubmit(text: string, onSubmit: ChatBarProps['onSubmit'], busy = false) {
  const draftRef = { current: text }
  const editor = window.document.createElement('div')
  editor.dataset.slot = 'composer-rich-input'
  editor.textContent = text
  const loadIntoComposer = vi.fn()
  const stashAt = vi.fn()

  const clearDraft = vi.fn(() => {
    draftRef.current = ''
    editor.textContent = ''
  })

  const hook = renderHook(() =>
    useComposerSubmit({
      activeQueueSessionKey: THREAD,
      activeQueueSessionKeyRef: { current: THREAD },
      attachments: [],
      busy,
      compacting: false,
      clearDraft,
      disabled: false,
      draftRef,
      drainNextQueued: vi.fn(async () => false),
      editorRef: { current: editor },
      exitQueuedEdit: vi.fn(() => false),
      focusInput: vi.fn(),
      inputDisabled: false,
      loadIntoComposer,
      onCancel: vi.fn(),
      onSteer: vi.fn(async () => true),
      onSteerHidden: vi.fn(async () => true),
      onSubmit,
      queueCurrentDraft: vi.fn(() => true),
      queueEdit: null,
      queuedPrompts: [],
      sessionId: 'rt-1',
      setComposerText: vi.fn(),
      stashAt
    })
  )

  return { clearDraft, editor, hook, loadIntoComposer, stashAt }
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  $gatewayState.set('open')
  noteMainThreadClaimed('default', THREAD)
  $selectedStoredSessionId.set(THREAD)
  $activeSessionId.set('rt-1')
  $messages.set([{ id: 'm1', parts: [], role: 'user', timestamp: Date.now() / 1000 - 60 } as unknown as ChatMessage])
  notices.length = 0
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  setSingleThreadFlagForTest(false)
  resetMainThreadForTest()
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $messages.set([])
  $busy.set(false)
  $gatewayState.set('idle')
  $queuedPromptsBySession.set({})
  $parkedQueueSessions.set({})
})

describe('hc-1226 a typed /new in the one thread', () => {
  it('folds the thread once and leaves the composer empty: /new does not come back', async () => {
    const { compresses, request } = engine()
    const { sent, submit } = appSubmit()

    registerSingleThread(request)
    const { clearDraft, editor, hook, loadIntoComposer, stashAt } = renderSubmit('/new', chatBarOnSubmit(submit))

    act(() => hook.result.current.submitDraft())

    await waitFor(() => expect(notices).toContain(RESTARTED))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(compresses).toHaveLength(1)
    expect(clearDraft).toHaveBeenCalledTimes(1)
    expect(loadIntoComposer).not.toHaveBeenCalled()
    expect(stashAt).not.toHaveBeenCalled()
    expect(editor.textContent).toBe('')
    expect(sent).toEqual([])
  })

  it.each([
    ['while a reply is still running (sent at once, as every command is then)', true, false, 0],
    ['when the summary fails', false, true, 1]
  ])('%s: nothing is folded, and /new is back in the composer to send again', async (_l, busy, fail, compressed) => {
    const { compresses, request } = engine(fail)
    const { sent, submit } = appSubmit()

    $busy.set(busy)
    registerSingleThread(request)
    const { hook, loadIntoComposer, stashAt } = renderSubmit('/new', chatBarOnSubmit(submit), busy)

    act(() => hook.result.current.submitDraft())

    await waitFor(() => expect(loadIntoComposer).toHaveBeenCalledWith('/new', []))
    expect(stashAt).toHaveBeenCalledWith(THREAD, '/new', [])
    expect(compresses).toHaveLength(compressed)
    expect(notices).toContain(NOT_NOW)
    expect(notices).not.toContain(RESTARTED)
    expect(sent).toEqual([])
  })

  it('「从头来」 folds the thread and its words still go out as a message: nothing comes back', async () => {
    const { compresses, request } = engine()
    const { sent, submit } = appSubmit()

    registerSingleThread(request)
    const { hook, loadIntoComposer } = renderSubmit('从头来，帮我写个新脚本', chatBarOnSubmit(submit))

    act(() => hook.result.current.submitDraft())

    await waitFor(() => expect(sent).toEqual(['从头来，帮我写个新脚本']))
    expect(compresses).toHaveLength(1)
    expect(loadIntoComposer).not.toHaveBeenCalled()
  })
})

describe('hc-1226 a queued /new in the one thread', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setSessionsLoading(false)
  })

  afterEach(() => {
    setSessionsLoading(true)
    vi.useRealTimers()
  })

  it('drains once and leaves the queue: it is not retried, so the thread is folded once', async () => {
    vi.useFakeTimers()
    const { compresses, request } = engine()
    const { sent, submit } = appSubmit()

    registerSingleThread(request)
    enqueueQueuedPrompt(THREAD, { attachments: [], text: '/new' })

    renderHook(() =>
      useComposerQueue({
        activeQueueSessionKey: THREAD,
        attachments: [],
        busy: false,
        clearDraft: () => undefined,
        draftRef: { current: '' },
        focusInput: () => undefined,
        loadIntoComposer: () => undefined,
        onCancel: vi.fn(),
        onSteer: undefined,
        onSubmit: chatBarOnSubmit(submit),
        queueEditRef: { current: null },
        queueSessionKey: THREAD,
        sessionId: 'rt-1',
        turnLive: false
      })
    )

    // Past every retry the queue would make for an entry that was not accepted.
    for (let attempt = 0; attempt <= MAX_AUTO_DRAIN_ATTEMPTS; attempt++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
    }

    expect(compresses).toHaveLength(1)
    expect(getQueuedPrompts(THREAD)).toEqual([])
    expect(notices.filter(notice => notice === RESTARTED)).toHaveLength(1)
    expect(sent).toEqual([])
  })
})
