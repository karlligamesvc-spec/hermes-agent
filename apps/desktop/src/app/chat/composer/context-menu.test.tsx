import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import { ContextMenu } from './context-menu'
import type { ChatBarState } from './types'

const getSkills = vi.fn()
const toggleSkill = vi.fn()

vi.mock('@/hermes', () => ({
  getSkills: () => getSkills(),
  toggleSkill: (name: string, enabled: boolean) => toggleSkill(name, enabled)
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

function renderMenu() {
  return render(
    <MemoryRouter>
      <ContextMenu state={STATE} />
    </MemoryRouter>
  )
}

// Radix's DropdownMenuTrigger opens on pointerdown, not a bare click event —
// confirmed against this project's jsdom/testing-library setup, which has no
// existing click-to-open coverage to crib from.
function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Add' })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

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
