import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import { SkillBrowseDialog } from './skill-browse-dialog'
import { disabledSkills, enabledSkills, type SkillCatalog } from './skill-catalog'

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return { name: 'alpha', description: 'does alpha things', category: 'office', enabled: false, ...overrides }
}

const SKILLS: SkillInfo[] = [
  skill({ name: 'alpha', category: 'office', enabled: false, description: 'does alpha things' }),
  skill({ name: 'mango', category: 'office', enabled: true, description: 'mango capability' }),
  skill({ name: 'gamma', category: 'social', enabled: false, description: 'gamma capability' })
]

function fakeCatalog(setEnabled = vi.fn().mockResolvedValue(undefined)): SkillCatalog {
  return {
    skills: SKILLS,
    enabled: enabledSkills(SKILLS),
    disabled: disabledSkills(SKILLS),
    loading: false,
    saving: null,
    setEnabled
  }
}

function renderDialog(catalog: SkillCatalog) {
  return render(<SkillBrowseDialog catalog={catalog} onOpenChange={vi.fn()} open />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillBrowseDialog', () => {
  it('lists only disabled skills, never the enabled ones', () => {
    renderDialog(fakeCatalog())

    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('gamma')).toBeTruthy()
    // "mango" is enabled — it lives in the menu's enabled zone, not the browse list.
    expect(screen.queryByText('mango')).toBeNull()
  })

  it('filters the list as you search', () => {
    renderDialog(fakeCatalog())

    fireEvent.change(screen.getByPlaceholderText('Search skills…'), { target: { value: 'alpha' } })

    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('gamma')).toBeNull()
  })

  it('narrows to a category when a chip is picked', () => {
    renderDialog(fakeCatalog())

    fireEvent.click(screen.getByRole('button', { name: 'Social' }))

    expect(screen.getByText('gamma')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('enables a skill (promotes it) when its switch is flipped on', async () => {
    const setEnabled = vi.fn().mockResolvedValue(undefined)
    renderDialog(fakeCatalog(setEnabled))

    fireEvent.click(screen.getByRole('switch', { name: 'Enable alpha' }))

    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'alpha' }),
        true
      )
    )
  })

  it('shows the all-enabled state when nothing is left to enable', () => {
    const allOn = SKILLS.map(s => ({ ...s, enabled: true }))
    renderDialog({
      skills: allOn,
      enabled: allOn,
      disabled: [],
      loading: false,
      saving: null,
      setEnabled: vi.fn()
    })

    expect(screen.getByText('Every skill is enabled 🎉')).toBeTruthy()
  })

  it('scopes the switch to a single skill row', () => {
    renderDialog(fakeCatalog())

    const alphaRow = screen.getByText('alpha').closest('li')
    expect(alphaRow).toBeTruthy()
    expect(within(alphaRow as HTMLElement).getByRole('switch', { name: 'Enable alpha' })).toBeTruthy()
  })
})
