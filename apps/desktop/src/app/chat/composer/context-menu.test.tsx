import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { saveHermesConfig } from '@/api/config'
import { $authState } from '@/store/auth'
import type { SkillInfo } from '@/types/hermes'

import { ContextMenu, GenerationModelIcon } from './context-menu'
import { requestComposerInsert } from './focus'
import { generationModels } from './generation-models'
import type { ChatBarState } from './types'

const getSkills = vi.fn()
const toggleSkill = vi.fn()

vi.mock('@/hermes', () => ({
  getSkills: () => getSkills(),
  // store/profile routes every API call through this on subscribe, and the
  // module graph under ContextMenu pulls it in. Without the stub the mock
  // module throws before any test body runs.
  setApiRequestProfile: vi.fn(),
  toggleSkill: (name: string, enabled: boolean) => toggleSkill(name, enabled)
}))

vi.mock('@/api/config', () => ({ saveHermesConfig: vi.fn(async () => ({ ok: true })) }))

vi.mock('./focus', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestComposerFocus: vi.fn(),
  requestComposerInsert: vi.fn()
}))

// Notifications hit nanostores/timers we don't care about here.
vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return { name: 'x', description: 'does things', category: 'office', enabled: false, ...overrides }
}

// hc-572's real-machine bug: dozens of enabled skills flattened into the menu.
// Reproduce that shape (12 enabled / 20 disabled) and assert none of the
// individual names ever reach the menu — only the two collapsed rows do.
const ENABLED = Array.from({ length: 12 }, (_, i) => skill({ name: `enabled-skill-${i}`, enabled: true }))
const DISABLED = Array.from({ length: 20 }, (_, i) => skill({ name: `disabled-skill-${i}`, enabled: false }))
const CATALOG: SkillInfo[] = [...ENABLED, ...DISABLED]

const STATE: ChatBarState = {
  model: { model: 'm', provider: 'p', canSwitch: true },
  tools: { enabled: true, label: 'Add' },
  voice: { enabled: false, active: false }
}

// Without `advanced` the menu keeps its flat developer-mode zones; with it
// (the everyday composer) zones 2–3 fold under one 高级 row. The router is the
// only context either needs (the connectors row navigates).
const ADVANCED = {
  voice: {
    autoSpeak: false,
    disabled: false,
    onDictate: vi.fn(),
    onStartConversation: vi.fn(),
    onToggleAutoSpeak: vi.fn(),
    state: STATE,
    voiceStatus: 'idle' as const
  }
}

function renderMenu({ folded = false }: { folded?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ContextMenu advanced={folded ? ADVANCED : undefined} state={STATE} />
    </MemoryRouter>
  )
}

// Radix's DropdownMenuTrigger opens on pointerdown, not a bare click event —
// confirmed against this project's jsdom/testing-library setup, which has no
// existing click-to-open coverage to crib from.
function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Add images, files and more' })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
  $authState.set({ ...$authState.get(), modelTiers: false })
})

function setTierMode() {
  $authState.set({ ...$authState.get(), enabled: true, modelTiers: true, status: 'signed-in' })
}

const MODEL_LABELS = [...generationModels('image'), ...generationModels('video')].map(model => model.label)

const menuNames = () =>
  [...window.document.querySelectorAll('[role="menu"]')].map(menu => menu.textContent ?? '').join('\n')

describe('ContextMenu — collapsed skill rows (hc-572 followup)', () => {
  it('never lists an individual skill in the menu — only two rows with live counts', async () => {
    getSkills.mockResolvedValue(CATALOG)
    renderMenu()

    openMenu()

    expect(screen.getByText('Enabled skills')).toBeTruthy()
    expect(screen.getByText('Unused skills')).toBeTruthy()
    await screen.findByText('12')
    expect(screen.getByText('20')).toBeTruthy()

    // The menu body never grows a per-skill list — no individual skill name
    // (enabled or disabled) ever appears as a menu row.
    for (const row of CATALOG) {
      expect(screen.queryByText(row.name)).toBeNull()
    }
  })

  it('opens the browse dialog scoped to "enabled" when that row is clicked', async () => {
    getSkills.mockResolvedValue(CATALOG)
    renderMenu()
    openMenu()
    await screen.findByText('12')

    fireEvent.click(screen.getByText('Enabled skills'))

    expect(await screen.findByText('enabled-skill-0')).toBeTruthy()
    expect(screen.queryByText('disabled-skill-0')).toBeNull()
  })

  it('opens the browse dialog scoped to "unused" when that row is clicked', async () => {
    getSkills.mockResolvedValue(CATALOG)
    renderMenu()
    openMenu()
    await screen.findByText('20')

    fireEvent.click(screen.getByText('Unused skills'))

    expect(await screen.findByText('disabled-skill-0')).toBeTruthy()
    expect(screen.queryByText('enabled-skill-0')).toBeNull()
  })

  it('updates both the dialog and the menu row counts live after a toggle — no reload', async () => {
    getSkills.mockResolvedValue(CATALOG)
    toggleSkill.mockResolvedValue({ ok: true, name: 'disabled-skill-0', enabled: true })
    renderMenu()
    openMenu()
    await screen.findByText('20')

    fireEvent.click(screen.getByText('Unused skills'))
    await screen.findByText('disabled-skill-0')

    fireEvent.click(screen.getByRole('switch', { name: 'Enable disabled-skill-0' }))
    await waitFor(() => expect(toggleSkill).toHaveBeenCalledWith('disabled-skill-0', true))

    // Close the dialog and reopen the "+" trigger — same as a real user would
    // after enabling a skill — and check the rows read live, with no reload.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    openMenu()
    expect(await screen.findByText('13')).toBeTruthy()
    expect(screen.getByText('19')).toBeTruthy()
  })
})

describe('ContextMenu — the everyday composer folds zones 2–3 under 高级 (WP4)', () => {
  it('keeps the skill and connector rows one level down, counts and all', async () => {
    getSkills.mockResolvedValue(CATALOG)
    renderMenu({ folded: true })
    openMenu()

    expect(screen.queryByText('Enabled skills')).toBeNull()
    expect(screen.queryByText('Connectors')).toBeNull()

    const advanced = screen.getByRole('menuitem', { name: /^Advanced/ })

    advanced.focus()
    fireEvent.keyDown(advanced, { key: 'ArrowRight' })

    expect(await screen.findByText('Enabled skills')).toBeTruthy()
    expect(await screen.findByText('12')).toBeTruthy()
    expect(screen.getByText('20')).toBeTruthy()
    expect(screen.getByText('Connectors')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Approvals/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Voice settings/ })).toBeTruthy()
  })
})

// hc-960 exit 31 (Kael, 2026-10-20): tier mode names no model anywhere, so
// the image / video rows lose their pickers and always run on the defaults.
describe('ContextMenu — generation rows in tier mode', () => {
  it('names no model and opens no picker', async () => {
    setTierMode()
    renderMenu({ folded: true })
    openMenu()

    const image = await screen.findByRole('menuitem', { name: 'Image' })
    const video = screen.getByRole('menuitem', { name: 'Video' })

    for (const row of [image, video]) {
      expect(row.getAttribute('aria-haspopup')).toBeNull()
      expect(row.querySelector('[data-generation-model-icon]')).toBeNull()
    }

    expect(MODEL_LABELS.filter(label => menuNames().includes(label))).toEqual([])
  })

  it('starts on the default model, and the opener names none', async () => {
    window.localStorage.setItem('apex-generation-video-model-v1', 'MiniMax-H3')
    setTierMode()
    renderMenu({ folded: true })
    vi.mocked(saveHermesConfig).mockClear()
    openMenu()

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Video' }))

    await waitFor(() =>
      expect(saveHermesConfig).toHaveBeenCalledWith({
        apex: { generation_video_model: 'doubao-seedance-2-0-mini-260615' }
      })
    )
    await waitFor(() =>
      expect(requestComposerInsert).toHaveBeenCalledWith("I want to make a video. Here's the idea: ", {
        mode: 'block',
        target: 'main'
      })
    )
  })

  it('moves a pick made before tier mode to the default at start-up', async () => {
    window.localStorage.setItem('apex-generation-image-model-v1', 'qwen-image-3.0-pro')
    setTierMode()
    renderMenu({ folded: true })

    await waitFor(() =>
      expect(saveHermesConfig).toHaveBeenCalledWith({ apex: { generation_image_model: 'gpt-image-2.5-flare' } })
    )
    expect(saveHermesConfig).not.toHaveBeenCalledWith({ apex: { generation_image_model: 'qwen-image-3.0-pro' } })
  })

  // The twin: outside tier mode (switch off, or the user's own key) the pickers,
  // their model names and a saved pick all stay.
  it('keeps the pickers and the saved pick outside tier mode', async () => {
    window.localStorage.setItem('apex-generation-image-model-v1', 'qwen-image-3.0-pro')
    renderMenu({ folded: true })

    await waitFor(() =>
      expect(saveHermesConfig).toHaveBeenCalledWith({ apex: { generation_image_model: 'qwen-image-3.0-pro' } })
    )
    openMenu()

    const image = await screen.findByRole('menuitem', { name: /^Image/ })

    expect(image.getAttribute('aria-haspopup')).toBe('menu')
    expect(image.textContent).toContain('Qwen Image 3.0 Pro')
  })
})

describe('GenerationModelIcon', () => {
  it('uses one clean provider mark without numeric or letter variant badges', () => {
    for (const model of [...generationModels('image'), ...generationModels('video')]) {
      const { container, unmount } = render(<GenerationModelIcon model={model} />)
      const icon = container.querySelector(`[data-generation-model-icon="${model.icon}"]`)

      expect(icon).toBeTruthy()
      expect(icon?.querySelectorAll(':scope > *')).toHaveLength(1)
      expect(icon?.textContent).toBe('')

      unmount()
    }
  })
})
