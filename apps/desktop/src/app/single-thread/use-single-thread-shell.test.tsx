import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COMPOSER_AREAS } from '@/app/chat/composer/contrib'
import { registry } from '@/contrib/registry'
import { MAIN_THREAD_TITLE, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { $pendingThreadClaim, type RequestGateway } from './composer-middleware'
import { SINGLE_THREAD_MIDDLEWARE_ID, useSingleThreadShell } from './use-single-thread-shell'

const { secondaryWindow } = vi.hoisted(() => ({ secondaryWindow: vi.fn(() => false) }))

vi.mock('@/store/windows', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  isSecondaryWindow: () => secondaryWindow()
}))

function gatewayWith(rows: unknown[]) {
  return vi.fn(async (method: string) =>
    method === 'session.list' ? { sessions: rows } : {}
  ) as unknown as RequestGateway & ReturnType<typeof vi.fn>
}

function Shell({ request }: { request: RequestGateway }) {
  useSingleThreadShell(request)

  return <span data-testid="where">{useLocation().pathname}</span>
}

function mount(request: RequestGateway, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Shell request={request} />
    </MemoryRouter>
  )
}

const where = () => screen.getByTestId('where').textContent
const middlewareIds = () => registry.getArea(COMPOSER_AREAS.middleware).map(contribution => contribution.id)

beforeEach(() => {
  $gatewayState.set('open')
  $activeGatewayProfile.set('default')
  secondaryWindow.mockReturnValue(false)
})

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  $pendingThreadClaim.set(null)
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $gatewayState.set('idle')
})

describe('hc-1014 the single-thread shell', () => {
  it('does nothing at all with the switch off: no lookup, no middleware, Start stays Start', async () => {
    const request = gatewayWith([{ id: 'root', resolved_id: 'tip', title: MAIN_THREAD_TITLE }])

    mount(request)
    await act(async () => undefined)

    expect(request).not.toHaveBeenCalled()
    expect(middlewareIds()).not.toContain(SINGLE_THREAD_MIDDLEWARE_ID)
    expect(where()).toBe('/')
  })

  it('opens the thread instead of the Start page, at its live tip', async () => {
    setSingleThreadFlagForTest(true)
    const request = gatewayWith([{ id: 'root', resolved_id: 'tip-4', title: MAIN_THREAD_TITLE }])

    mount(request)

    await waitFor(() => expect(where()).toBe('/tip-4'))
    expect(middlewareIds()).toContain(SINGLE_THREAD_MIDDLEWARE_ID)
  })

  it('keeps the empty thread on `/` until the first message makes it', async () => {
    setSingleThreadFlagForTest(true)
    const request = gatewayWith([])

    mount(request)
    await act(async () => undefined)

    expect(request).toHaveBeenCalledTimes(1)
    expect(where()).toBe('/')
  })

  it('leaves a page the user opened alone', async () => {
    setSingleThreadFlagForTest(true)
    mount(gatewayWith([{ id: 'root', title: MAIN_THREAD_TITLE }]), '/projects')
    await act(async () => undefined)

    expect(where()).toBe('/projects')
  })

  it('titles the session a first message creates', async () => {
    setSingleThreadFlagForTest(true)
    const request = gatewayWith([])

    mount(request)
    await act(async () => undefined)

    $pendingThreadClaim.set({ at: Date.now(), profile: 'default' })
    $activeSessionId.set('rt-new')
    act(() => $selectedStoredSessionId.set('stored-new'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.title', { session_id: 'rt-new', title: MAIN_THREAD_TITLE })
    )
  })

  it.each([
    ['developer mode', () => setToolViewMode('technical')],
    ['a secondary window', () => secondaryWindow.mockReturnValue(true)]
  ])('stays out of %s', async (_label, arrange) => {
    setSingleThreadFlagForTest(true)
    arrange()
    const request = gatewayWith([{ id: 'root', title: MAIN_THREAD_TITLE }])

    mount(request)
    await act(async () => undefined)

    expect(request).not.toHaveBeenCalled()
    expect(where()).toBe('/')
  })
})
