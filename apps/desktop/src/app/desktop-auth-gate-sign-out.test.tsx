/**
 * hc-1142: in product mode the auth gate answers 「退出登录」 at the click and
 * keeps the login screen up while the engine the sign-out restarts is away.
 * Developer mode and the switch off are pinned byte for byte in
 * src/sign-out-identity.test.tsx.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { never, Providers, seed, settle } from '@/__identity__/re-sign-in/render'
import { DesktopAuthGate } from '@/app/desktop-auth-gate'
import { signOutFailureKind } from '@/i18n/sign-out'
import { $authState, $signingOut, signOutAccountWithReason } from '@/store/auth'
import { closeManagedReSignIn, openManagedReSignIn } from '@/store/managed-re-sign-in'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

// The gate re-reads main's status when the gateway comes back; these cases decide the status themselves.
vi.mock(import('@/store/auth'), async importOriginal => ({
  ...(await importOriginal()),
  refreshAuthStatus: async () => undefined
}))

const COVER = '正在退出登录…'
const loginButton = () => screen.queryByRole('button', { name: /登录 APEX/ })

let setGatewayOpen: (open: boolean) => void = () => undefined

function Gate({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  setGatewayOpen = setOpen

  return <DesktopAuthGate enabled={open} requestGateway={vi.fn(never) as never} />
}

async function renderGate(initiallyOpen = true) {
  render(
    <Providers>
      <Gate initiallyOpen={initiallyOpen} />
    </Providers>
  )
  await settle()
}

async function gateway(open: boolean) {
  act(() => setGatewayOpen(open))
  await settle()
}

function installSignOut(signOut: () => Promise<unknown>) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api: vi.fn(never), managed: { signOut: vi.fn(signOut), status: vi.fn(never) } }
  })
}

beforeEach(() => {
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  seed()
})

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('product mode, from the click to the login screen', () => {
  it('covers the window while the server is asked, and signs out only on its answer', async () => {
    let answer!: (result: unknown) => void
    installSignOut(() => new Promise(resolve => (answer = resolve)))
    await renderGate()

    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = signOutAccountWithReason()
    })

    expect(screen.getByText(COVER)).toBeTruthy()
    expect(loginButton()).toBeNull()
    expect($authState.get().status).toBe('signed-in')

    await act(async () => {
      answer({ ok: true })
      await outcome
    })

    expect(screen.queryByText(COVER)).toBeNull()
    expect(loginButton()).toBeTruthy()
  })

  it('keeps the login screen while the engine restarts, and after it is back', async () => {
    installSignOut(async () => ({ ok: true }))
    await renderGate()
    await act(async () => {
      await signOutAccountWithReason()
    })
    expect(loginButton()).toBeTruthy()

    await gateway(false)
    expect(loginButton()).toBeTruthy()

    await gateway(true)
    expect(loginButton()).toBeTruthy()
  })

  it('a failure takes the cover away and leaves the app as it was', async () => {
    installSignOut(async () => ({ ok: false, message: 'MANAGED_PROVISION_UNAVAILABLE', statusCode: 503 }))
    await renderGate()

    await act(async () => {
      expect(await signOutAccountWithReason()).toEqual({ ok: false, message: 'MANAGED_PROVISION_UNAVAILABLE', statusCode: 503 })
    })

    expect($signingOut.get()).toBe(false)
    expect($authState.get().status).toBe('signed-in')
    expect(screen.queryByText(COVER)).toBeNull()
    expect(loginButton()).toBeNull()
  })

  it('one sign-out at a time: a second click gets the first one’s answer', async () => {
    let answer!: (result: unknown) => void
    const signOut = vi.fn(() => new Promise(resolve => (answer = resolve)))
    installSignOut(signOut)

    const first = signOutAccountWithReason()
    const second = signOutAccountWithReason()
    answer({ ok: true })

    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(signOut).toHaveBeenCalledOnce()
  })
})

describe('product mode, what the hold does not reach', () => {
  it('a window whose engine has never been ready shows nothing: the boot screens come first', async () => {
    seed({ account: { email: '', name: '', plan: '' }, accountId: null, status: 'signed-out' })
    await renderGate(false)

    expect(loginButton()).toBeNull()
  })

  it.each(['signed-in', 'expired'] as const)('%s: an engine restart shows nothing over the app', async status => {
    seed({ status })
    await renderGate()
    await gateway(false)

    expect(loginButton()).toBeNull()
    expect(screen.queryByText(COVER)).toBeNull()
  })

  // Only the gate after a sign-out is held. A re-sign-in over a signed-in app (hc-1110) keeps what it did on main.
  it('a re-sign-in screen over a signed-in app still goes while the engine restarts, as before', async () => {
    seed({ status: 'signed-in' })
    openManagedReSignIn('')
    await renderGate()
    expect(loginButton()).toBeTruthy()

    await gateway(false)
    expect(loginButton()).toBeNull()

    await gateway(true)
    expect(loginButton()).toBeTruthy()
    closeManagedReSignIn()
  })

  it('outside product mode there is no cover', async () => {
    setToolViewMode('technical')
    let answer!: (result: unknown) => void
    installSignOut(() => new Promise(resolve => (answer = resolve)))
    await renderGate()

    const outcome = signOutAccountWithReason()
    await settle()

    expect(screen.queryByText(COVER)).toBeNull()
    answer({ ok: false })
    await act(async () => {
      await outcome
    })
  })
})

describe('why a sign-out did not finish', () => {
  it.each([
    [{ message: 'MANAGED_PROVISION_UNAVAILABLE', statusCode: 401 }, 'expired'],
    [{ message: 'MANAGED_PROVISION_UNAVAILABLE', statusCode: 403 }, 'expired'],
    [{ message: 'SIGN_OUT_REQUIRES_SIGN_IN' }, 'expired'],
    [{ message: 'MODEL_RUNTIME_UNAVAILABLE' }, 'busy'],
    [{ message: 'MODEL_RUNTIME_UPDATE_REQUIRED' }, 'busy'],
    [{ message: 'MODEL_MUTATION_SUPERSEDED' }, 'busy'],
    [{ message: 'SIGN_OUT_CLEAR_FAILED' }, 'local'],
    [{ message: 'MANAGED_PROVISION_UNAVAILABLE', statusCode: 500 }, 'network'],
    [{ message: 'Desktop relay key was not revoked.' }, 'network'],
    [{}, 'network']
  ])('%j reads as %s', (outcome, kind) => {
    expect(signOutFailureKind(outcome)).toBe(kind)
  })
})
