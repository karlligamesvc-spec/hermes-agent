/**
 * hc-1077: the shell with several assistants on — the roster and every
 * assistant's thread kept, the Start-route redirect held while a switch lands,
 * and a conversation followed to its assistant.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QUICK_ENTRY_ASSISTANT_KEY } from '@/i18n/quick-entry'
import { $mainThreadsByProfile, MAIN_THREAD_TITLE, resetMainThreadForTest } from '@/store/main-thread'
import { notificationTitle } from '@/store/notification-title'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { $botIntent, $botRoster, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { $pendingThreadClaim, type RequestGateway } from './composer-middleware'
import { useSingleThreadShell } from './use-single-thread-shell'

const { ensureGatewayProfile } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined)
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

/** A gateway serving two profiles: APEX's thread `apex-root`, 小红书文案's `writer-root`. */
function gateway(threads: Record<string, string> = { default: 'apex-root', writer: 'writer-root' }) {
  return vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'session.list') {
      const id = threads[String(params?.profile)]

      return { sessions: id ? [{ id, title: MAIN_THREAD_TITLE }] : [] }
    }

    if (method === 'profiles.list') {
      return {
        profiles: [
          { is_default: true, name: 'default' },
          { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }
        ]
      }
    }

    if (method === 'profiles.describe') {
      return { soul: '你是小红书文案。' }
    }

    return {}
  }) as unknown as RequestGateway & ReturnType<typeof vi.fn>
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

const calls = (request: ReturnType<typeof vi.fn>, method: string) =>
  request.mock.calls.filter(([name]) => name === method)

beforeEach(() => {
  $gatewayState.set('open')
  $activeGatewayProfile.set('default')
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  resetBotRosterForTest()
  ensureGatewayProfile.mockClear()
})

afterEach(() => {
  cleanup()
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetMainThreadForTest()
  resetBotRosterForTest()
  $pendingThreadClaim.set(null)
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $gatewayState.set('idle')
})

describe('hc-1077 several assistants in the shell', () => {
  it('with the switch off reads no roster and looks up no other thread', async () => {
    const request = gateway()

    mount(request)
    await waitFor(() => expect(where()).toBe('/apex-root'))

    expect(calls(request, 'profiles.list')).toHaveLength(0)
    expect(calls(request, 'session.list').map(([, params]) => params?.profile)).toEqual(['default'])
  })

  it('on: reads the roster and every other assistant’s thread', async () => {
    setMultiBotFlagForTest(true)
    const request = gateway()

    mount(request)

    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))
    expect($botRoster.get().map(bot => bot.name)).toEqual(['APEX', '小红书文案'])
    expect(calls(request, 'profiles.describe').map(([, params]) => params)).toEqual([{ name: 'writer' }])
    expect(where()).toBe('/apex-root')
  })

  it('holds `/` while a switch lands, then opens the new assistant’s thread', async () => {
    setMultiBotFlagForTest(true)
    $botIntent.set('writer')
    const request = gateway()

    mount(request)
    await act(async () => undefined)

    // APEX's thread is found, but 小红书文案 was asked for: no detour into APEX's.
    expect(where()).toBe('/')

    await act(async () => {
      $botIntent.set(null)
      $activeGatewayProfile.set('writer')
    })

    await waitFor(() => expect(where()).toBe('/writer-root'))
  })

  it('follows a conversation to its assistant (a notification opened 小红书文案’s thread)', async () => {
    setMultiBotFlagForTest(true)
    const request = gateway()

    mount(request)
    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))

    act(() => $selectedStoredSessionId.set('writer-root'))

    await waitFor(() => expect(ensureGatewayProfile).toHaveBeenCalledWith('writer'))
    // This engine never answered (the mock leaves the active profile alone): one try, not a loop.
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)))
    expect(ensureGatewayProfile).toHaveBeenCalledTimes(1)

    // A later selection of the same thread tries again.
    act(() => $selectedStoredSessionId.set(null))
    act(() => $selectedStoredSessionId.set('writer-root'))
    await waitFor(() => expect(ensureGatewayProfile).toHaveBeenCalledTimes(2))
  })

  it('stays put for APEX’s own thread, and for anything with the switch off', async () => {
    const request = gateway()

    mount(request)
    await waitFor(() => expect(where()).toBe('/apex-root'))
    $mainThreadsByProfile.set({
      ...$mainThreadsByProfile.get(),
      writer: { ids: ['writer-root'], profile: 'writer', rootId: 'writer-root', status: 'found', tipId: 'writer-root' }
    })

    act(() => $selectedStoredSessionId.set('apex-root'))
    act(() => $selectedStoredSessionId.set('writer-root'))
    await act(async () => undefined)

    expect(ensureGatewayProfile).not.toHaveBeenCalled()
  })
})

describe('hc-1077 the quick-entry window learns which assistant a capture reaches', () => {
  it('the main window records the on-screen assistant’s name, and clears it with the switch off', async () => {
    setMultiBotFlagForTest(true)
    mount(gateway())

    await waitFor(() => expect(window.localStorage.getItem(QUICK_ENTRY_ASSISTANT_KEY)).toBe('APEX'))

    act(() => $activeGatewayProfile.set('writer'))
    await waitFor(() => expect(window.localStorage.getItem(QUICK_ENTRY_ASSISTANT_KEY)).toBe('小红书文案'))

    act(() => setMultiBotFlagForTest(false))
    await waitFor(() => expect(window.localStorage.getItem(QUICK_ENTRY_ASSISTANT_KEY)).toBeNull())
  })

  it('installs the notification namer only while several assistants are on', async () => {
    expect(notificationTitle('需要输入', 'writer-root')).toBe('需要输入')

    setMultiBotFlagForTest(true)
    mount(gateway())
    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))

    expect(notificationTitle('需要输入', 'writer-root')).toBe('小红书文案 · 需要输入')

    act(() => setMultiBotFlagForTest(false))
    expect(notificationTitle('需要输入', 'writer-root')).toBe('需要输入')
  })
})
