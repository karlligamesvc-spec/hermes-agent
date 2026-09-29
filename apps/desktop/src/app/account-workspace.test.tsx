import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DesktopManagedStatus } from '@/global'
import { $authState, handleAuthGate, markSignedIn, refreshAuthStatus, signOutAccount } from '@/store/auth'

import { AccountWorkspace } from './account-workspace'

const initial = $authState.get()
const bridge = window.hermesDesktop

afterEach(() => {
  cleanup()
  $authState.set(initial)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: bridge })
  window.localStorage.clear()
})

it('resets account-owned view memory across logout and UUID changes, preserving a soft expiry and metadata refresh', () => {
  const base = { ...initial, enabled: true, status: 'signed-in' as const, accountId: 'owner-a', account: { email: 'same@fixture.test', name: 'A', plan: 'p' } }
  $authState.set(base)

  function Draft() {
    const [value, setValue] = useState('')

    return <input aria-label="account draft" onChange={e => setValue(e.target.value)} value={value} />
  }

  render(<AccountWorkspace><Draft /></AccountWorkspace>)
  fireEvent.change(screen.getByLabelText('account draft'), { target: { value: 'private A' } })
  act(() => $authState.set({ ...base, status: 'expired', account: { ...base.account, name: 'refreshed' } }))
  expect((screen.getByLabelText('account draft') as HTMLInputElement).value).toBe('private A')
  act(() => $authState.set({ ...base, accountId: 'owner-b' }))
  expect((screen.getByLabelText('account draft') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('account draft'), { target: { value: 'private B' } })
  act(() => handleAuthGate({ reason: 'unauthorized', statusCode: 401 }))
  expect(screen.queryByLabelText('account draft')).toBeNull()
  act(() => $authState.set({ ...base, accountId: 'owner-b' }))
  expect((screen.getByLabelText('account draft') as HTMLInputElement).value).toBe('')
  act(() => $authState.set({ ...base, enabled: false, status: 'signed-out' }))
  expect((screen.getByLabelText('account draft') as HTMLInputElement).value).toBe('')
})

it('never lets an old status read or its finally overwrite a completed logout or a newer sign-in refresh', async () => {
  const status = (id: string): DesktopManagedStatus => ({ enabled: true, signedIn: true, accountId: id,
    email: `${id}@fixture.test`, name: id, plan: 'p', model: 'fixture', modelDisplay: 'fixture', provider: 'custom', baseUrl: 'http://127.0.0.1' })

  for (const transition of ['logout', 'sign-in'] as const) {
    let oldResolve!: (value: DesktopManagedStatus) => void
    let newResolve!: (value: DesktopManagedStatus) => void

    const statusRead = vi.fn()
      .mockImplementationOnce(() => new Promise<DesktopManagedStatus>(resolve => { oldResolve = resolve }))
      .mockImplementationOnce(() => new Promise<DesktopManagedStatus>(resolve => { newResolve = resolve }))

    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { managed: { status: statusRead, signOut: async () => ({ ok: true }) } } })
    $authState.set({ ...initial, enabled: true, status: 'signed-in', accountId: 'old', account: { email: 'old@fixture.test', name: 'old', plan: 'p' } })
    const old = refreshAuthStatus()

    if (transition === 'logout') { await signOutAccount() }
    else { markSignedIn({ email: 'new@fixture.test' }) }

    oldResolve(status('old'))
    await old

    if (transition === 'logout') {
      expect($authState.get()).toMatchObject({ status: 'signed-out', accountId: null })
      expect(window.localStorage.getItem('apexnodes-desktop-signed-in-v1')).toBeNull()
    } else {
      const newest = refreshAuthStatus()
      expect(statusRead).toHaveBeenCalledTimes(2)
      expect($authState.get().account.email).toBe('new@fixture.test')
      newResolve(status('new'))
      await newest
      expect($authState.get()).toMatchObject({ status: 'signed-in', accountId: 'new', account: { email: 'new@fixture.test' } })
    }
  }
})
