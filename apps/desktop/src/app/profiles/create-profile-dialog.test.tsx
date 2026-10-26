import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createProfile, updateProfileSoul } from '@/hermes'

import { APEX_DESKTOP_DEFAULT_SOUL } from '../../../shared/apex-default-soul'

import { CreateProfileDialog } from './create-profile-dialog'

// hc-1042: a profile created blank used to keep the engine's upstream seed ("You are Hermes Agent,
// built by Nous Research"), so its first chat introduced itself as Hermes. Blank now means APEX.

vi.mock('@/hermes', () => ({
  createProfile: vi.fn(async () => ({ name: 'x', ok: true, path: '/x' })),
  updateProfileSoul: vi.fn(async () => ({ ok: true }))
}))

// Radix Select scrolls the chosen option into view, which jsdom does not implement.
const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeEach(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()

  if (scroll) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

async function createWith(cloneFromNone: boolean, soul: string) {
  render(<CreateProfileDialog onClose={vi.fn()} open profiles={[]} />)

  if (cloneFromNone) {
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Clone from' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'None (blank)' }))
  }

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'work' } })
  fireEvent.change(screen.getByLabelText(/SOUL\.md/), { target: { value: soul } })
  await act(async () => {
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!)
  })
  await waitFor(() => expect(createProfile).toHaveBeenCalledTimes(1))
}

describe('the SOUL a new profile starts with', () => {
  it.each([
    ['blank profile, SOUL left empty', true, '', `${APEX_DESKTOP_DEFAULT_SOUL}\n`],
    ['blank profile, SOUL only whitespace', true, '  \n', `${APEX_DESKTOP_DEFAULT_SOUL}\n`],
    ['blank profile, own SOUL', true, 'You are Ada.', 'You are Ada.'],
    ['cloned profile, own SOUL', false, 'You are Ada.', 'You are Ada.']
  ])('%s', async (_label, cloneFromNone, soul, written) => {
    await createWith(cloneFromNone, soul)

    expect(createProfile).toHaveBeenCalledWith({ clone_from: cloneFromNone ? null : 'default', name: 'work' })
    await waitFor(() => expect(updateProfileSoul).toHaveBeenCalledWith('work', written))
  })

  it('a cloned profile with SOUL left empty keeps the cloned persona', async () => {
    await createWith(false, '')

    expect(updateProfileSoul).not.toHaveBeenCalled()
  })

  it('tells the user a blank profile starts as APEX', async () => {
    render(<CreateProfileDialog onClose={vi.fn()} open profiles={[]} />)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Clone from' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'None (blank)' }))

    expect(screen.getByLabelText(/SOUL\.md/).getAttribute('placeholder')).toContain('keep the APEX default')
  })
})
