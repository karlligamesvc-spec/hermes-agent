import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { I18nProvider } from '@/i18n'
import { $hudMode } from '@/store/hud'
import { applyWakeStartResult, applyWakeStatus, resetWakeWordState } from '@/store/wake-word'

import { ComposerControls } from './controls'

vi.mock('./model-pill', () => ({ ModelPill: () => null }))

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { active: false, enabled: false }
}

function renderControls(overrides: Partial<React.ComponentProps<typeof ComposerControls>> = {}) {
  return render(
    <MemoryRouter><I18nProvider configClient={null} initialLocale="en">
      <ComposerControls
        autoSpeak={false}
        busy={false}
        canSubmit={true}
        conversation={{
          active: false,
          level: 0,
          muted: false,
          onEnd: vi.fn(),
          onStart: vi.fn(),
          onStopTurn: vi.fn(),
          onToggleMute: vi.fn(),
          status: 'idle'
        }}
        disabled={false}
        hasComposerPayload={true}
        onDictate={vi.fn()}
        onToggleAutoSpeak={vi.fn()}
        state={state}
        voiceStatus="idle"
        {...overrides}
      />
    </I18nProvider></MemoryRouter>
  )
}

async function expectShortcutTooltip(label: string, shortcut: string) {
  fireEvent.pointerMove(screen.getByLabelText(label), { pointerType: 'mouse' })

  const tooltip = await screen.findByRole('tooltip')

  expect(tooltip.textContent).toContain(label)
  expect(tooltip.textContent).toContain(shortcut)
}

afterEach(() => {
  cleanup()
  $hudMode.set(false)
})

// The HUD is a Spotlight bar a few hundred pixels wide: the four voice
// controls fold into one menu there, and the way out of HUD mode joins the
// row instead of floating above the bar in a reserved strip. The docked
// composer keeps every control inline and shows no exit.
describe('HUD mode', () => {
  it('keeps the voice controls inline and offers no exit in the docked composer', () => {
    renderControls()

    expect(screen.getByLabelText('Voice dictation')).toBeTruthy()
    expect(screen.getByLabelText('Read replies aloud')).toBeTruthy()
    expect(screen.queryByLabelText('Exit HUD mode')).toBeNull()
    expect(screen.queryByLabelText('Reset HUD size and position')).toBeNull()
    expect(screen.queryByLabelText('Voice')).toBeNull()
  })

  it('folds them into one menu and offers the way out in the HUD', () => {
    $hudMode.set(true)
    renderControls()

    expect(screen.getByLabelText('Voice')).toBeTruthy()
    expect(screen.getByLabelText('Reset HUD size and position')).toBeTruthy()
    expect(screen.getByLabelText('Exit HUD mode')).toBeTruthy()

    // Folded away, not duplicated — the whole point is the row's width back.
    expect(screen.queryByLabelText('Voice dictation')).toBeNull()
    expect(screen.queryByLabelText('Read replies aloud')).toBeNull()
  })

  // A collapsed menu that looked idle while the mic was open would be a worse
  // trade than the space it saves, so the trigger reports the live state.
  it('reports a live voice state on the collapsed trigger', () => {
    $hudMode.set(true)
    renderControls({ voiceStatus: 'recording' })

    expect(screen.getByLabelText('Stop dictation')).toBeTruthy()
    expect(screen.queryByLabelText('Voice')).toBeNull()
  })
})

// A tile can be narrower than the controls cost, and the row is inside an
// overflow-hidden surface — so anything that doesn't fold gets clipped off the
// right edge, send button first. The ladder keeps going past `stacked`: voice
// folds into the same menu the HUD uses, then the model pill drops. Send is
// the last thing standing.
describe('narrow tiles', () => {
  it('folds the voice controls into one menu without entering HUD mode', () => {
    renderControls({ foldVoice: true })

    expect(screen.getByLabelText('Voice')).toBeTruthy()
    expect(screen.queryByLabelText('Voice dictation')).toBeNull()
    expect(screen.queryByLabelText('Read replies aloud')).toBeNull()

    // Folding is a width decision, not the HUD: no exit affordance appears.
    expect(screen.queryByLabelText('Exit HUD mode')).toBeNull()
  })

  it('keeps Send at the tightest width, with everything else dropped', () => {
    renderControls({ foldVoice: true, minimal: true })

    expect(screen.getByLabelText('Send')).toBeTruthy()
    expect(screen.queryByLabelText('Voice')).toBeNull()
  })

  it('keeps Stop reachable mid-turn at the tightest width', () => {
    renderControls({ busy: true, foldVoice: true, hasComposerPayload: false, minimal: true })

    expect(screen.getByLabelText('Stop')).toBeTruthy()
  })
})

describe('ComposerControls shortcut tooltips', () => {
  it('shows Enter for Send', async () => {
    renderControls()

    await expectShortcutTooltip('Send', '↵')
  })

  it('keeps Send (not Steer) while a turn is running if there is a payload', async () => {
    renderControls({ busy: true })

    await expectShortcutTooltip('Send', '↵')
  })

  it('shows Stop only when the composer is empty mid-turn', async () => {
    renderControls({ busy: true, canSubmit: true, hasComposerPayload: false })

    await expectShortcutTooltip('Stop', '↵')
  })

  it('does not expose a separate queue action for a mid-turn payload', () => {
    renderControls({ busy: true })

    expect(screen.queryByLabelText('Queue message')).toBeNull()
  })
})

describe('wake-word ear visibility', () => {
  afterEach(() => {
    resetWakeWordState()
  })

  it('stays mounted during a busy agent turn', () => {
    applyWakeStatus({ available: true, enabled: true, listening: true, phrase: 'hey hermes' })
    renderControls({ busy: true })

    expect(screen.getByLabelText('APEX voice activation — listening')).toBeTruthy()
  })

  it('stays mounted (enabled in config) even when a start was refused', () => {
    applyWakeStatus({ available: true, enabled: true, listening: false, phrase: 'hey hermes' })
    // Transient refusal marks available false but enabled keeps it mounted.
    applyWakeStartResult({ hint: 'mic busy', reason: 'unavailable', started: false })
    renderControls()

    expect(screen.getByLabelText('APEX voice activation — off')).toBeTruthy()
  })

  it('stays visible (never hides) even when unavailable and not enabled', () => {
    applyWakeStatus({ available: false, enabled: false, listening: false, phrase: 'hey hermes' })
    renderControls()

    // The ear ALWAYS shows so the user can click to enable; a failed start
    // surfaces its reason in the tooltip rather than hiding the control.
    expect(screen.getByLabelText('APEX voice activation — off')).toBeTruthy()
  })

  it('surfaces the backend refusal reason in the tooltip, still visible', () => {
    applyWakeStatus({ available: false, enabled: false, listening: false, phrase: 'hey hermes' })
    applyWakeStartResult({ hint: 'run `hermes tools` (Voice section)', reason: 'unavailable', started: false })
    renderControls()

    const ear = screen.getByLabelText('APEX voice activation — off')
    expect(ear).toBeTruthy()
  })

  it('keeps mute and end reachable in the floating call controls', () => {
    applyWakeStatus({ available: true, enabled: true, listening: true, phrase: 'hey hermes' })
    renderControls({
      conversation: {
        active: true,
        level: 0,
        muted: false,
        onEnd: vi.fn(),
        onStart: vi.fn(),
        onStopTurn: vi.fn(),
        onToggleMute: vi.fn(),
        status: 'listening'
      }
    })

    const mute = screen.getByRole('button', { name: 'Mute microphone' })
    const endConversation = screen.getByRole('button', { name: 'End voice conversation' })

    expect((mute as HTMLButtonElement).disabled).toBe(false)
    expect((endConversation as HTMLButtonElement).disabled).toBe(false)
  })
})

// Main chat follows Start's mic + Send hierarchy; compact HUD/tile controls
// keep the existing width ladder above. Voice never submits the pending text.
describe('Start-style main chat actions', () => {
  it.each([
    { busy: false, payload: false, action: 'Send', disabled: true },
    { busy: false, payload: true, action: 'Send', disabled: false },
    { busy: true, payload: false, action: 'Stop', disabled: false },
    { busy: true, payload: true, action: 'Send', disabled: false }
  ])('keeps mic before $action (busy=$busy, payload=$payload)', ({ busy, payload, action, disabled }) => {
    const start = vi.fn()
    renderControls({
      homeStyle: true,
      busy,
      hasComposerPayload: payload,
      canSubmit: busy || payload,
      conversation: { active: false, level: 0, muted: false, status: 'idle', onEnd: vi.fn(), onStart: start, onStopTurn: vi.fn(), onToggleMute: vi.fn() }
    })
    const mic = screen.getByRole('button', { name: 'Start voice conversation' }) as HTMLButtonElement
    const send = screen.getByRole('button', { name: action }) as HTMLButtonElement
    expect(mic.type).toBe('button')
    expect(send.type).toBe('submit')
    expect(send.disabled).toBe(disabled)
    expect(mic.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(mic)
    expect(start).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Voice dictation')).toBeNull()
    expect(screen.queryByLabelText('Read replies aloud')).toBeNull()
  })

  it('retains dictation and reply reading behind the compact settings control', () => {
    const dictate = vi.fn()
    const speak = vi.fn()
    renderControls({ homeStyle: true, state: { ...state, voice: { active: false, enabled: true } }, onDictate: dictate, onToggleAutoSpeak: speak })
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Voice$/ }), { button: 0, pointerId: 1 })
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Voice dictation' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Read replies aloud' }))
    expect(dictate).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('menuitemcheckbox', { name: /voice activation/i })).toBeTruthy()
  })
})
