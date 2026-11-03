/**
 * hc-1060 G4 on the real composer pieces, in Chinese: the single-thread
 * composer as 「APEX 极简助手原型 v2」 draws it (Kael 2026-10-26, N5–N7).
 *
 * - a fixed 「给 APEX 发消息」 placeholder that is also the input's name;
 * - 听写 beside the input: tap, or hold and let go, and ⌘D;
 * - one round button: voice while the input is empty, Send once it is not,
 *   and no Stop — the input keeps taking messages while APEX works;
 * - the Stop moved to the activity line, and 「停一下」 halts like it.
 *
 * The flag-off and developer-mode composer is pinned byte for byte in
 * src/single-thread-composer-identity.test.tsx.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatBar as GatedChatBar } from '@/app/single-thread/composer-gate'
import { isStopRequest, steerWithStopRequests } from '@/app/single-thread/stop-request'
import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { allKeybindActions, contributedKeybindHandler } from '@/lib/keybinds/actions'
import { $authState } from '@/store/auth'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'
import { clearQueuedPrompts, enqueueQueuedPrompt, isQueueParked } from '@/store/composer-queue'
import { $hudMode } from '@/store/hud'
import { $comboIndex } from '@/store/keybinds'
import { $activeSessionId, $busy, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { $threadStop, publishThreadStop } from '@/store/single-thread-stop'
import { setToolViewMode } from '@/store/tool-view'
import { remixRunningTurn } from '@/test/remix-turn'

import { RICH_INPUT_SLOT } from './rich-editor'
import { ComposerControls, DICTATE_ACTION, DICTATION_HOLD_MS } from './single-thread-actions'
import type { ChatBarState, VoiceStatus } from './types'

import { ChatBar } from '.'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

stubThreadEnvironment()

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

const SESSION = 'session-g4'

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40))
  })

function signInApexAccount() {
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: false,
    status: 'signed-in'
  })
}

interface ControlsOverrides {
  busy?: boolean
  conversationActive?: boolean
  hasComposerPayload?: boolean
  voiceStatus?: VoiceStatus
}

/** The trailing controls alone, with every callback a spy. */
function renderControls(overrides: ControlsOverrides = {}) {
  const spies = { onDictate: vi.fn(), onEnd: vi.fn(), onStart: vi.fn() }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const element = (next: ControlsOverrides) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <form onSubmit={event => event.preventDefault()}>
            <ComposerControls
              autoSpeak={false}
              busy={next.busy ?? false}
              canSubmit={(next.busy ?? false) || (next.hasComposerPayload ?? false)}
              conversation={{
                active: next.conversationActive ?? false,
                level: 0,
                muted: false,
                onEnd: spies.onEnd,
                onStart: spies.onStart,
                onStopTurn: vi.fn(),
                onToggleMute: vi.fn(),
                status: 'idle'
              }}
              disabled={false}
              hasComposerPayload={next.hasComposerPayload ?? false}
              homeStyle
              onDictate={spies.onDictate}
              onToggleAutoSpeak={vi.fn()}
              state={STATE}
              voiceStatus={next.voiceStatus ?? 'idle'}
            />
          </form>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  const view = render(element(overrides))

  return { ...spies, rerender: (next: ControlsOverrides) => view.rerender(element({ ...overrides, ...next })), view }
}

const buttonNames = () =>
  screen.queryAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')

function renderChatBar({ busy, gated = false }: { busy: boolean; gated?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onCancel = vi.fn()
  const onSteer = vi.fn(async (_text: string) => true)
  const onSubmit = vi.fn(async () => true)
  const Bar = gated ? GatedChatBar : ChatBar

  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <Bar
              busy={busy}
              disabled={false}
              onCancel={onCancel}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSteer={onSteer}
              onSubmit={onSubmit}
              sessionId={SESSION}
              state={STATE}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  return { onCancel, onSteer, onSubmit, view }
}

const editor = () => window.document.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

async function send(text: string) {
  editor().append(window.document.createTextNode(text))
  fireEvent.input(editor())
  await settle()
  fireEvent.keyDown(editor(), { key: 'Enter' })
  await settle()
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $singleThreadFlag.set(true)
  $activeSessionId.set(SESSION)
  $gatewayState.set('open')
  signInApexAccount()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  mainComposerScope.clear()
  clearSessionDraft(null)
  clearSessionDraft(SESSION)
  clearQueuedPrompts(SESSION)
  $busy.set(false)
  $hudMode.set(false)
  $threadStop.set(null)
  $singleThreadFlag.set(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  $activeSessionId.set(null)
})

describe('the input', () => {
  it('rests on 「给 APEX 发消息」, which is also its name', async () => {
    renderChatBar({ busy: false })
    await settle()

    expect(editor().getAttribute('data-placeholder')).toBe('给 APEX 发消息')
    expect(editor().getAttribute('aria-label')).toBe('给 APEX 发消息')
  })

  it('keeps the rotating starter and the name 「消息」 with the switch off', async () => {
    $singleThreadFlag.set(false)
    renderChatBar({ busy: false })
    await settle()

    expect(editor().getAttribute('data-placeholder')).not.toBe('给 APEX 发消息')
    expect(editor().getAttribute('aria-label')).toBe('消息')
  })
})

describe('the row: 听写 and one round button', () => {
  it.each([
    ['empty', {}, ['听写', '开始语音对话']],
    ['a draft', { hasComposerPayload: true }, ['听写', '发送']],
    ['empty while APEX works', { busy: true }, ['听写', '开始语音对话']],
    ['a draft while APEX works', { busy: true, hasComposerPayload: true }, ['听写', '发送']]
  ] as const)('%s', (_name, overrides, names) => {
    renderControls(overrides)

    expect(buttonNames()).toEqual(names)
  })

  it('never shows Stop: it lives on the activity line now', () => {
    renderControls({ busy: true })

    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
  })

  it('sends a draft through the form', () => {
    renderControls({ hasComposerPayload: true })

    const send = screen.getByRole('button', { name: '发送' })

    expect(send.getAttribute('type')).toBe('submit')
    expect(send.hasAttribute('disabled')).toBe(false)
  })

  it('starts the voice conversation from an empty input; while it runs, its panel hangs up', () => {
    const controls = renderControls()

    fireEvent.click(screen.getByRole('button', { name: '开始语音对话' }))
    expect(controls.onStart).toHaveBeenCalledTimes(1)

    controls.rerender({ conversationActive: true })
    // One hang-up (the panel's), no second round button, and no dictation:
    // the conversation holds the mic.
    expect(screen.getAllByRole('button', { name: '结束语音对话' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '开始语音对话' })).toBeNull()
    expect(screen.queryByRole('button', { name: '听写' })).toBeNull()

    controls.rerender({ conversationActive: true, hasComposerPayload: true })
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy()
  })

  it('keeps the default controls on the HUD bar', () => {
    $hudMode.set(true)
    renderControls({ busy: true })

    expect(window.document.querySelector('[data-single-thread-composer]')).toBeNull()
  })

  it('keeps the default controls in developer mode', () => {
    setToolViewMode('technical')
    renderControls({ busy: true })

    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
    expect(window.document.querySelector('[data-single-thread-composer]')).toBeNull()
  })
})

describe('听写: tap, or hold and let go', () => {
  const mic = () => screen.getByRole('button', { name: /听写/ })

  it('a tap starts it and the next tap stops it', () => {
    const controls = renderControls()

    fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 })
    fireEvent.pointerUp(mic(), { button: 0, pointerId: 1 })
    expect(controls.onDictate).toHaveBeenCalledTimes(1)

    controls.rerender({ voiceStatus: 'recording' })
    expect(screen.getByRole('button', { name: '停止听写' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.pointerDown(screen.getByRole('button', { name: '停止听写' }), { button: 0, pointerId: 2 })
    fireEvent.pointerUp(screen.getByRole('button', { name: '停止听写' }), { button: 0, pointerId: 2 })
    expect(controls.onDictate).toHaveBeenCalledTimes(2)
  })

  it('a press held past the hold time stops when let go', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 9, 26, 8, 0, 0))

    const controls = renderControls()

    fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 })
    vi.setSystemTime(Date.UTC(2026, 9, 26, 8, 0, 0) + DICTATION_HOLD_MS + 50)
    fireEvent.pointerUp(mic(), { button: 0, pointerId: 1 })

    expect(controls.onDictate).toHaveBeenCalledTimes(2)
  })

  it('Enter or Space on the focused mic taps it', () => {
    const controls = renderControls()

    // detail 0: a keyboard activation, not a pointer press.
    fireEvent.click(mic(), { detail: 0 })
    expect(controls.onDictate).toHaveBeenCalledTimes(1)
  })

  it('is busy, not pressable, while the recording turns into text', () => {
    renderControls({ voiceStatus: 'transcribing' })

    expect(screen.getByRole('button', { name: '正在转写听写' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('⌘D', () => {
  it('dictates while the single-thread row is mounted, and goes back to the default profile after', () => {
    const controls = renderControls()

    expect($comboIndex.get().get('mod+d')).toBe(DICTATE_ACTION)
    expect(allKeybindActions().find(action => action.id === DICTATE_ACTION)?.label).toBe('听写')

    contributedKeybindHandler(DICTATE_ACTION)!()
    expect(controls.onDictate).toHaveBeenCalledTimes(1)

    controls.view.unmount()
    expect($comboIndex.get().get('mod+d')).toBe('profile.default')
  })

  it('does nothing while the composer is hidden behind another page', () => {
    const controls = renderControls()

    controls.view.container.setAttribute('hidden', '')
    contributedKeybindHandler(DICTATE_ACTION)!()

    expect(controls.onDictate).not.toHaveBeenCalled()
  })

  it('stays the default-profile chord in developer mode', () => {
    setToolViewMode('technical')
    renderControls()

    expect($comboIndex.get().get('mod+d')).toBe('profile.default')
  })
})

describe('while APEX works, the input keeps taking messages', () => {
  it('a typed message reaches the running turn', async () => {
    const { onCancel, onSteer } = renderChatBar({ busy: true, gated: true })

    await settle()
    await send('顺便起 3 个标题')

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1))
    expect(onSteer.mock.calls[0]![0]).toBe('顺便起 3 个标题')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('「停一下」 halts the turn and parks the queue instead of reaching APEX as words', async () => {
    enqueueQueuedPrompt(SESSION, { text: '然后做小红书版', attachments: [] })

    const { onCancel, onSteer } = renderChatBar({ busy: true, gated: true })

    await settle()
    await send('停一下')

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(onSteer).not.toHaveBeenCalled()
    expect(isQueueParked(SESSION)).toBe(true)
  })

  it('「停一下，先把标题改了」 is words for APEX, not a stop', async () => {
    const { onCancel, onSteer } = renderChatBar({ busy: true, gated: true })

    await settle()
    await send('停一下，先把标题改了')

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('with the switch off, 「停一下」 is an ordinary steer', async () => {
    $singleThreadFlag.set(false)

    const { onCancel, onSteer } = renderChatBar({ busy: true, gated: true })

    await settle()
    await send('停一下')

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1))
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('the activity line’s 「停」', () => {
  it('is published by the main composer in single-thread mode, and halts like the old Stop', async () => {
    enqueueQueuedPrompt(SESSION, { text: '然后做小红书版', attachments: [] })

    const { onCancel } = renderChatBar({ busy: true, gated: true })

    await settle()
    expect($threadStop.get()).not.toBeNull()

    act(() => $threadStop.get()!())
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(isQueueParked(SESSION)).toBe(true)
  })

  it('is not published with the switch off', async () => {
    $singleThreadFlag.set(false)
    renderChatBar({ busy: true, gated: true })
    await settle()

    expect($threadStop.get()).toBeNull()
  })

  it('sits at the end of the activity line while APEX works, and stops it', async () => {
    const stop = vi.fn()

    publishThreadStop(stop)
    $busy.set(true)

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={remixRunningTurn()}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    )

    const button = await waitFor(() => {
      const node = container.querySelector<HTMLButtonElement>('[data-single-thread-activity] [data-single-thread-stop]')

      expect(node).not.toBeNull()

      return node!
    })

    expect(button.textContent).toBe('停')
    expect(button.getAttribute('aria-label')).toBe('让 APEX 停下手上的事')
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('is not there when nothing is running', async () => {
    publishThreadStop(vi.fn())

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={remixRunningTurn()}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    )

    await waitFor(() => expect(container.querySelector('[data-single-thread-activity]')).not.toBeNull())
    expect(container.querySelector('[data-single-thread-stop]')).toBeNull()
  })
})

describe('steerWithStopRequests', () => {
  it('leaves a stop request aimed at another session to that session', async () => {
    const steer = vi.fn(async () => true)
    const halt = vi.fn(async () => {})
    const wrapped = steerWithStopRequests(steer, SESSION, halt)

    await wrapped('停一下', { sessionId: 'session-other', storedSessionId: 'stored-other' })
    expect(steer).toHaveBeenCalledTimes(1)
    expect(halt).not.toHaveBeenCalled()

    await expect(wrapped('停一下', { sessionId: SESSION, storedSessionId: 'stored-g4' })).resolves.toBe(true)
    expect(halt).toHaveBeenCalledTimes(1)
    expect(steer).toHaveBeenCalledTimes(1)
  })
})

describe('isStopRequest', () => {
  it.each([
    ['停一下', true],
    ['停', true],
    ['停一下吧', true],
    ['先停一下。', true],
    ['APEX，停一下！', true],
    ['别做了', true],
    ['暫停', true],
    ['Stop', true],
    ['stop it', true],
    ['停一下，先把标题改了', false],
    ['停车场探店', false],
    ['不要停', false],
    ['how do I stop a running process', false],
    ['', false]
  ])('%s → %s', (text, expected) => {
    expect(isStopRequest(text)).toBe(expected)
  })
})
