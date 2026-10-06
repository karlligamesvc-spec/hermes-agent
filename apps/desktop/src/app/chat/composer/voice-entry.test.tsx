import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { BusinessGoalLauncher } from '@/app/business-workspace/components/business-goal-launcher'
import { I18nProvider } from '@/i18n'
import { $voiceConversationStartRequest, takeVoiceConversationStart } from '@/store/composer'
import { $hudMode } from '@/store/hud'
import { $voiceLiveStatus } from '@/store/voice-live'

import { ComposerControls } from './controls'
import { ComposerScopeProvider, MAIN_COMPOSER_SCOPE } from './scope'
import type { ChatBarState } from './types'
import { VoiceConversationPanel } from './voice-conversation-panel'

vi.mock('./model-pill', () => ({ ModelPill: () => null }))

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { enabled: false, active: false }
}

const conversation = {
  active: false,
  level: 0,
  muted: false,
  status: 'idle' as const,
  onEnd: vi.fn(),
  onStart: vi.fn(),
  onToggleMute: vi.fn(),
  onStopTurn: vi.fn()
}

afterEach(() => {
  cleanup()
  $hudMode.set(false)
  $voiceLiveStatus.set(null)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  takeVoiceConversationStart($voiceConversationStartRequest.get())
})

it.each(['home', 'chat'] as const)(
  '%s has a one-click voice entry even with an unsent draft, without sending it',
  surface => {
    const submit = vi.fn(async () => true)
    const start = vi.fn()
    const before = $voiceConversationStartRequest.get()
    $voiceLiveStatus.set({
      mode: 'qwen-realtime',
      available: true,
      qwenAvailable: true,
      model: 'Flash',
      voice: 'longanqian',
      reason: null
    })
    render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="en">
          {surface === 'home' ? (
            <BusinessGoalLauncher draft="Unsent goal" onDraftChange={vi.fn()} onSubmit={submit} />
          ) : (
            <ComposerControls
              autoSpeak={false}
              busy={false}
              canSubmit
              conversation={{ ...conversation, onStart: start }}
              disabled={false}
              hasComposerPayload
              homeStyle
              onDictate={vi.fn()}
              onToggleAutoSpeak={vi.fn()}
              state={state}
              voiceStatus="idle"
            />
          )}
        </I18nProvider>
      </MemoryRouter>
    )
    expect(screen.queryByRole('button', { name: 'Voice chat engine' })).toBeNull()
    expect(screen.queryByText(/Qwen|GPT-Live|Speech-to-text \+ Hermes voice/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start voice conversation' }))

    if (surface === 'home') {
      expect($voiceConversationStartRequest.get()).toBeGreaterThan(before)
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Unsent goal')
    } else {
      expect(start).toHaveBeenCalledTimes(1)
    }

    expect(submit).not.toHaveBeenCalled()
  }
)

function Location() {
  return <output>{useLocation().search}</output>
}

it('dragging the call header moves and bounds the panel, stops on release, and preserves control clicks', () => {
  const end = vi.fn()
  const mute = vi.fn()
  render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <VoiceConversationPanel level={0} muted={false} onEnd={end} onToggleMute={mute} status="listening" />
      </I18nProvider>
    </MemoryRouter>
  )
  const panel = screen.getByRole('region', { name: 'Start voice conversation' })
  const handle = screen.getByRole('group', { name: 'Move voice window' })
  vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => ({
    x: Number.parseFloat(panel.style.left) || 200,
    y: Number.parseFloat(panel.style.top) || 56,
    left: Number.parseFloat(panel.style.left) || 200,
    top: Number.parseFloat(panel.style.top) || 56,
    width: 512,
    height: 72,
    right: 712,
    bottom: 128,
    toJSON: () => ({})
  }))

  const pointer = (type: string, x: number, y: number, pointerId = 1) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    fireEvent(handle, event)
  }

  pointer('pointerdown', 220, 76)
  pointer('pointermove', 320, 176, 2)
  expect(panel.style.left).toBe('')
  pointer('pointermove', 320, 176)
  expect(panel.style.left).toBe('300px')
  expect(panel.style.top).toBe('156px')
  expect(panel.className).not.toContain('-translate-x-1/2')
  pointer('pointermove', 5000, 5000)
  expect(panel.style.left).toBe(`${window.innerWidth - 512 - 8}px`)
  expect(panel.style.top).toBe(`${window.innerHeight - 72 - 8}px`)
  pointer('pointermove', -100, -100)
  expect(panel.style.left).toBe('8px')
  expect(panel.style.top).toBe('8px')
  pointer('pointerup', -100, -100)
  pointer('pointermove', 400, 300)
  expect(panel.style.left).toBe('8px')
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(panel.style.left).toBe('24px')
  pointer('pointerdown', 44, 28)
  pointer('pointercancel', 44, 28)
  pointer('pointermove', 500, 400)
  expect(panel.style.left).toBe('24px')
  fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }))
  fireEvent.click(screen.getByRole('button', { name: 'End voice conversation' }))
  expect(mute).toHaveBeenCalledTimes(1)
  expect(end).toHaveBeenCalledTimes(1)
})

it('the floating call expands real transcript turns and exposes mute, settings and end outside hidden home chrome', () => {
  const end = vi.fn()
  const mute = vi.fn()
  render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <div hidden>
          <VoiceConversationPanel
            level={0.5}
            muted={false}
            onEnd={end}
            onToggleMute={mute}
            status="listening"
            transcript={[
              { speaker: 'user', text: 'First question', turnId: '1', startMs: 0, endMs: 1 },
              { speaker: 'assistant', text: 'First ', turnId: '2', startMs: 1, endMs: 2 },
              { speaker: 'assistant', text: 'answer', turnId: '2', startMs: 2, endMs: 3 },
              { speaker: 'assistant', text: 'Second answer', turnId: '3', startMs: 3, endMs: 4 }
            ]}
          />
        </div>
        <Location />
      </I18nProvider>
    </MemoryRouter>
  )
  expect(screen.queryByRole('log')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Live transcript' }))
  expect(screen.getByText('First answer')).toBeTruthy()
  expect(screen.getByText('Second answer')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }))
  expect(mute).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Voice settings' }))
  expect(screen.getByText('?tab=config:voice')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'End voice conversation' }))
  expect(end).toHaveBeenCalledTimes(1)
})

it.each(['hud', 'tile'] as const)(
  '%s keeps a reachable in-window hangup instead of placing controls outside its compact surface',
  surface => {
    $hudMode.set(surface === 'hud')
    const end = vi.fn()
    const scope = surface === 'tile' ? { ...MAIN_COMPOSER_SCOPE, target: 'tile:fixture' as const } : MAIN_COMPOSER_SCOPE

    const { container } = render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="en">
          <ComposerScopeProvider value={scope}>
            <ComposerControls
              autoSpeak={false}
              busy={false}
              canSubmit
              conversation={{ ...conversation, active: true, onEnd: end }}
              disabled={false}
              hasComposerPayload={false}
              onDictate={vi.fn()}
              onToggleAutoSpeak={vi.fn()}
              state={state}
              voiceStatus="idle"
            />
          </ComposerScopeProvider>
        </I18nProvider>
      </MemoryRouter>
    )

    expect(container.querySelector('[data-voice-conversation-panel]')).toBeNull()
    const button = screen.getByRole('button', { name: 'End voice conversation' })
    expect(container.contains(button)).toBe(true)
    fireEvent.click(button)
    expect(end).toHaveBeenCalledTimes(1)
  }
)
