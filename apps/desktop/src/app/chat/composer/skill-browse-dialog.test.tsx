import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import { SkillBrowseDialog } from './skill-browse-dialog'
import { disabledSkills, enabledSkills, type SkillCatalog, type SkillScope } from './skill-catalog'

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return { name: 'alpha', description: 'does alpha things', category: 'office', enabled: false, ...overrides }
}

const SKILLS: SkillInfo[] = [
  skill({ name: 'alpha', category: 'office', enabled: false, description: 'does alpha things' }),
  skill({ name: 'mango', category: 'office', enabled: true, description: 'mango capability' }),
  skill({ name: 'gamma', category: 'social', enabled: false, description: 'gamma capability' })
]

function fakeCatalog(skills: SkillInfo[] = SKILLS, setEnabled = vi.fn().mockResolvedValue(undefined)): SkillCatalog {
  return {
    skills,
    enabled: enabledSkills(skills),
    disabled: disabledSkills(skills),
    loading: false,
    saving: null,
    setEnabled
  }
}

function renderDialog(catalog: SkillCatalog, initialScope: SkillScope = 'disabled') {
  return render(<SkillBrowseDialog catalog={catalog} initialScope={initialScope} onOpenChange={vi.fn()} open />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillBrowseDialog — scope', () => {
  it('opens on the "disabled" (unused) scope showing only disabled skills', () => {
    renderDialog(fakeCatalog(), 'disabled')

    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('gamma')).toBeTruthy()
    expect(screen.queryByText('mango')).toBeNull()
  })

  it('opens on the "enabled" scope showing only enabled skills', () => {
    renderDialog(fakeCatalog(), 'enabled')

    expect(screen.getByText('mango')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.queryByText('gamma')).toBeNull()
  })

  it('labels each scope tab with a live count', () => {
    renderDialog(fakeCatalog())

    expect(screen.getByRole('button', { name: 'Enabled skills (1)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unused skills (2)' })).toBeTruthy()
  })

  it('switches halves when the other scope tab is clicked, without closing', () => {
    const onOpenChange = vi.fn()
    render(<SkillBrowseDialog catalog={fakeCatalog()} initialScope="disabled" onOpenChange={onOpenChange} open />)

    expect(screen.getByText('alpha')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Enabled skills (1)' }))

    expect(screen.getByText('mango')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe('SkillBrowseDialog — search and category', () => {
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
})

describe('SkillBrowseDialog — toggling', () => {
  it('enables a skill (promotes it) when its switch is flipped on from the "Unused" scope', async () => {
    const setEnabled = vi.fn().mockResolvedValue(undefined)
    renderDialog(fakeCatalog(SKILLS, setEnabled), 'disabled')

    fireEvent.click(screen.getByRole('switch', { name: 'Enable alpha' }))

    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha' }), true))
  })

  it('disables a skill (demotes it) when its switch is flipped off from the "Enabled" scope', async () => {
    const setEnabled = vi.fn().mockResolvedValue(undefined)
    renderDialog(fakeCatalog(SKILLS, setEnabled), 'enabled')

    fireEvent.click(screen.getByRole('switch', { name: 'Disable mango' }))

    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ name: 'mango' }), false))
  })

  it('scopes the switch to a single skill row', () => {
    renderDialog(fakeCatalog())

    const alphaRow = screen.getByText('alpha').closest('li')
    expect(alphaRow).toBeTruthy()
    expect(within(alphaRow as HTMLElement).getByRole('switch', { name: 'Enable alpha' })).toBeTruthy()
  })
})

describe('SkillBrowseDialog — empty states', () => {
  it('shows the all-enabled state in the "Unused" scope when nothing is left to enable', () => {
    const allOn = SKILLS.map(s => ({ ...s, enabled: true }))
    renderDialog(fakeCatalog(allOn), 'disabled')

    expect(screen.getByText('Every skill is enabled 🎉')).toBeTruthy()
  })

  it('shows the none-enabled state in the "Enabled" scope when nothing is enabled yet', () => {
    const allOff = SKILLS.map(s => ({ ...s, enabled: false }))
    renderDialog(fakeCatalog(allOff), 'enabled')

    expect(screen.getByText('No skills enabled yet')).toBeTruthy()
  })
})
