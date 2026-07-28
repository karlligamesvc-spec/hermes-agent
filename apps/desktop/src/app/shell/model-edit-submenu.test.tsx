import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type * as HermesApi from '@/hermes'
import { $modelPresets, getModelPreset } from '@/store/model-presets'
import {
  $activeSessionId,
  $currentFastMode,
  $currentReasoningEffort,
  getCurrentModelSource,
  setCurrentFastMode,
  setCurrentModelSource,
  setCurrentReasoningEffort
} from '@/store/session'

import { type FastControl, ModelEditSubmenu } from './model-edit-submenu'

vi.mock('@/hermes', async importOriginal => {
  const actual = await importOriginal<typeof HermesApi>()

  return { ...actual, setApiRequestProfile: vi.fn() }
})

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  $modelPresets.set({})
  $activeSessionId.set(null)
  setCurrentFastMode(false)
  setCurrentModelSource('')
  setCurrentReasoningEffort('')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Render the submenu inside an open menu/sub so its content (switches) mounts.
function renderSubmenu(opts: {
  effort?: string
  fastControl: FastControl
  model?: string
  reasoning: boolean
  requestGateway: () => Promise<unknown>
}) {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <DropdownMenuSub open>
          <DropdownMenuSubTrigger>edit</DropdownMenuSubTrigger>
          <ModelEditSubmenu
            effort={opts.effort ?? 'medium'}
            fastControl={opts.fastControl}
            isActive
            model={opts.model ?? 'm1'}
            onSelectModel={vi.fn()}
            provider="p1"
            reasoning={opts.reasoning}
            requestGateway={opts.requestGateway as never}
          />
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The effort radio's options, in rendered order. */
function effortChoices(): string[] {
  return screen.getAllByRole('menuitemradio').map(item => item.textContent?.trim() ?? '')
}

/** The single checked effort option, or '' when the radio has none. */
function checkedEffort(): string {
  const checked = screen.getAllByRole('menuitemradio').find(item => item.getAttribute('aria-checked') === 'true')

  return checked?.textContent?.trim() ?? ''
}

// Regression: editing the active row before a live session exists must stay
// preset-only — the gateway's config.set falls back to global config when no
// session matches, so it must not be called. (Caught in the second review.)
describe('ModelEditSubmenu no-session guard', () => {
  it('param fast: records explicit off in the draft but skips the gateway without a session', () => {
    const requestGateway = vi.fn().mockResolvedValue({})
    setCurrentFastMode(true)
    renderSubmenu({ fastControl: { kind: 'param', on: true }, reasoning: false, requestGateway })

    fireEvent.click(screen.getByRole('switch'))

    expect(getModelPreset('p1', 'm1').fast).toBe(false)
    expect($currentFastMode.get()).toBe(false)
    expect(getCurrentModelSource()).toBe('manual')
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('reasoning: records the preset but skips the gateway without a session', () => {
    const requestGateway = vi.fn().mockResolvedValue({})
    renderSubmenu({ fastControl: { kind: 'none' }, reasoning: true, requestGateway })

    // Thinking starts on (medium); toggling it off routes through patchReasoning.
    fireEvent.click(screen.getByRole('switch'))

    expect(getModelPreset('p1', 'm1').effort).toBe('none')
    expect($currentReasoningEffort.get()).toBe('none')
    expect(getCurrentModelSource()).toBe('manual')
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('param fast: pushes to the gateway once a session is active', async () => {
    const requestGateway = vi.fn().mockResolvedValue({})
    $activeSessionId.set('sess1')
    renderSubmenu({ fastControl: { kind: 'param', on: false }, reasoning: false, requestGateway })

    fireEvent.click(screen.getByRole('switch'))

    expect(requestGateway).toHaveBeenCalledWith('config.set', { key: 'fast', session_id: 'sess1', value: 'fast' })
  })
})

// hc-598: the radio used to render all seven of Hermes' levels for every model.
// Vendors publish two to four; the rest were choices the backend either folds
// onto a level already on the list or rejects outright.
describe('ModelEditSubmenu effort levels follow the model', () => {
  const requestGateway = () => Promise.resolve({})

  it.each([
    // plugins/model-providers/deepseek: low/medium/high through, top three → max.
    ['deepseek-v4-pro', ['Low', 'Medium', 'High', 'Max']],
    // plugins/model-providers/zai: GLM-5.2 has exactly two enabled levels.
    ['glm-5.2', ['High', 'Max']],
    // No profile evidence → the conservative default.
    ['qwen3.7-max', ['Low', 'Medium', 'High']]
  ])('offers %s only the levels it has', (model, expected) => {
    renderSubmenu({ fastControl: { kind: 'none' }, model, reasoning: true, requestGateway })

    expect(effortChoices()).toEqual(expected)
  })

  it('never offers a level the model cannot honor', () => {
    renderSubmenu({ fastControl: { kind: 'none' }, model: 'glm-5.2', reasoning: true, requestGateway })

    // The four GLM-5.2 does not distinguish. Rendering them made three of the
    // seven rows land on `high` and one on `max` without saying so.
    for (const decoy of ['Minimal', 'Low', 'Medium', 'Extra High', 'Ultra']) {
      expect(effortChoices()).not.toContain(decoy)
    }
  })

  it('falls a saved level the model lacks back to the closest one it has', () => {
    // `ultra` was picked while a model that supports it was active. GLM-5.2
    // tops out at `max` — show `max`, not a blank radio and not an error.
    renderSubmenu({ effort: 'ultra', fastControl: { kind: 'none' }, model: 'glm-5.2', reasoning: true, requestGateway })

    expect(checkedEffort()).toBe('Max')
  })

  it('falls a saved level BELOW the model floor up to that floor', () => {
    // GLM-5.2's minimum enabled level is `high` — `minimal` cannot be honored.
    renderSubmenu({
      effort: 'minimal',
      fastControl: { kind: 'none' },
      model: 'glm-5.2',
      reasoning: true,
      requestGateway
    })

    expect(checkedEffort()).toBe('High')
  })

  it('leaves the saved preset alone — the fallback is display, not a rewrite', () => {
    renderSubmenu({ effort: 'ultra', fastControl: { kind: 'none' }, model: 'glm-5.2', reasoning: true, requestGateway })

    // Nothing was clicked, so nothing may be written: the user's `ultra` still
    // applies on models that can honor it.
    expect(getModelPreset('p1', 'glm-5.2').effort).toBeUndefined()
  })

  it('turns Thinking back on at a level the model actually has', () => {
    // The generic default is `medium`; GLM-5.2 has no such level, so re-enabling
    // must not persist one the backend would silently reinterpret.
    renderSubmenu({ effort: 'none', fastControl: { kind: 'none' }, model: 'glm-5.2', reasoning: true, requestGateway })

    fireEvent.click(screen.getByRole('switch'))

    expect(getModelPreset('p1', 'glm-5.2').effort).toBe('high')
  })

  it('still persists an explicit pick verbatim', () => {
    renderSubmenu({ fastControl: { kind: 'none' }, model: 'deepseek-v4-pro', reasoning: true, requestGateway })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Max' }))

    expect(getModelPreset('p1', 'deepseek-v4-pro').effort).toBe('max')
    expect($currentReasoningEffort.get()).toBe('max')
  })
})
