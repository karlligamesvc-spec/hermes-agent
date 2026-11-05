/**
 * hc-1077: the shell with several assistants on — the roster and every
 * assistant's thread kept, the Start-route redirect held while a switch lands,
 * and a conversation followed to its assistant.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QUICK_ENTRY_ASSISTANT_KEY } from '@/i18n/quick-entry'
import { $mainThread, $mainThreadsByProfile, MAIN_THREAD_TITLE, resetMainThreadForTest } from '@/store/main-thread'
import { notificationTitle } from '@/store/notification-title'
import { $activeGatewayProfile, $freshSessionRequest, $gatewaySwapTarget } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  $botIntent,
  $botRoster,
  openBot,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
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

/** Every route the shell's window visited, in order. */
let visited: string[] = []
/** Every navigation the window made (a location key changes even for the same path). */
let navigations = 0
/** The window's router, for a test that moves the route itself. */
let go: (to: string) => void = () => undefined

/**
 * The chat controller's half of a switch, at the app's timing (hc-1146): a
 * fresh draft drops the selection and goes to `/` a little late, and a
 * conversation route is selected a little after the route changed (resumeSession
 * selects at its synchronous entry).
 */
function Controller() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  useEffect(
    () =>
      $freshSessionRequest.listen(() => {
        setTimeout(() => {
          $selectedStoredSessionId.set(null)
          navigate('/')
        }, 5)
      }),
    [navigate]
  )

  useEffect(() => {
    const id = pathname === '/' ? null : decodeURIComponent(pathname.slice(1))

    if (!id || $selectedStoredSessionId.get() === id) {
      return
    }

    const timer = setTimeout(() => $selectedStoredSessionId.set(id), 2)

    return () => clearTimeout(timer)
  }, [pathname])

  return null
}

function Shell({ controller, request }: { controller: boolean; request: RequestGateway }) {
  useSingleThreadShell(request)
  const { key, pathname } = useLocation()
  const navigate = useNavigate()

  go = to => navigate(to)

  useEffect(() => {
    if (visited.at(-1) !== pathname) {
      visited.push(pathname)
    }
  }, [pathname])

  useEffect(() => {
    navigations += 1
  }, [key])

  return (
    <>
      <span data-testid="where">{pathname}</span>
      {controller && <Controller />}
    </>
  )
}

function mount(request: RequestGateway, path = '/', controller = false) {
  visited = []
  navigations = 0

  return render(
    <MemoryRouter initialEntries={[path]}>
      <Shell controller={controller} request={request} />
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
  $gatewaySwapTarget.set(null)
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

/**
 * hc-1099: an engine already running is published as the active profile in
 * the click's own tick (the registry's onActiveRouteChanged mirror), before
 * the conversation being left is dropped (a fresh draft before hc-1146; since,
 * the route's resume selecting the thread opened) and well before the swap
 * settles. Mount with the controller stub to get the chat controller's half.
 */
function warmEngines(): { asked: [string, null | string][] } {
  // Each switch asked for, with the swap that was still in flight when it was asked.
  const asked: [string, null | string][] = []

  ensureGatewayProfile.mockImplementation(async (profile: string) => {
    asked.push([profile, $gatewaySwapTarget.get()])
    $gatewaySwapTarget.set(profile)
    $activeGatewayProfile.set(profile)
    await new Promise(resolve => setTimeout(resolve, 20))
    $gatewaySwapTarget.set(null)
  })

  return { asked }
}

/** Let `ms` pass one millisecond per act() scope, so React paints each route change when the app would. */
async function pass(ms: number): Promise<void> {
  for (let passed = 0; passed < ms; passed += 1) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 1)))
  }
}

const settle = () => pass(60)

describe('hc-1099 a switch to an assistant whose engine is already running', () => {
  afterEach(() => {
    ensureGatewayProfile.mockReset()
    ensureGatewayProfile.mockImplementation(async () => undefined)
  })

  it.each([
    ['opened at once (hc-1146)', true, ['/apex-root', '/writer-root']],
    ['through a fresh draft (no thread known yet)', false, ['/apex-root', '/', '/writer-root']]
  ])('lands, %s: the conversation being left does not pull its assistant back', async (_label, known, routes) => {
    setMultiBotFlagForTest(true)
    $selectedStoredSessionId.set('apex-root')
    mount(gateway(), '/apex-root', true)
    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))
    const { asked } = warmEngines()

    if (!known) {
      $mainThreadsByProfile.set({ default: $mainThreadsByProfile.get().default! })
    }

    act(() => void openBot('writer'))
    await settle()

    expect(asked).toEqual([['writer', null]])
    expect($activeGatewayProfile.get()).toBe('writer')
    expect($botIntent.get()).toBeNull()
    expect(visited).toEqual(routes)
    expect($selectedStoredSessionId.get()).toBe('writer-root')
  })

  it('a conversation opened during the switch is still followed once it settles', async () => {
    setMultiBotFlagForTest(true)
    $selectedStoredSessionId.set('apex-root')
    mount(gateway(), '/apex-root', true)
    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))
    const { asked } = warmEngines()

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    act(() => void openBot('writer'))
    // After 小红书文案's thread was selected, before the swap settles: a notification opens APEX's thread.
    await pass(10)
    act(() => $selectedStoredSessionId.set('apex-root'))
    await settle()

    // Followed once nothing was in flight any more, not in the middle of the switch.
    expect(asked).toEqual([
      ['writer', null],
      ['default', null]
    ])
    expect($activeGatewayProfile.get()).toBe('default')
    // The follow says in desktop.log that it undid the click's switch (bot-switch-log.ts).
    expect(logged.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringMatching(
        /^\[multi-bot\] switch to writer undone: the conversation on screen belongs to default \(\d+ ms after it landed\)$/
      )
    ])
    logged.mockRestore()
  })

  it('any gateway swap holds the follow too, not only a click (a resume moving the engine)', async () => {
    setMultiBotFlagForTest(true)
    $selectedStoredSessionId.set('apex-root')
    mount(gateway(), '/apex-root')
    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))

    // No click: a swap to 小红书文案's engine is published while APEX's thread is still selected.
    act(() => {
      $gatewaySwapTarget.set('writer')
      $activeGatewayProfile.set('writer')
    })
    await act(async () => undefined)
    expect(ensureGatewayProfile).not.toHaveBeenCalled()

    // Settled with APEX's thread still on screen: now it is followed.
    act(() => $gatewaySwapTarget.set(null))
    await waitFor(() => expect(ensureGatewayProfile).toHaveBeenCalledWith('default'))
  })
})

describe('hc-1146 a click opens the thread this window already knows', () => {
  afterEach(() => {
    ensureGatewayProfile.mockReset()
    ensureGatewayProfile.mockImplementation(async () => undefined)
  })

  async function onApexWithWriterKnown(request: RequestGateway = gateway()) {
    setMultiBotFlagForTest(true)
    $selectedStoredSessionId.set('apex-root')
    mount(request, '/apex-root', true)
    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))
  }

  it('paints the known thread at once while its lookup runs (no `loading` thread), and asks the lookup all the same', async () => {
    const request = gateway()

    await onApexWithWriterKnown(request)
    warmEngines()
    const painted: string[] = []
    const stop = $mainThread.listen(thread => painted.push(`${thread.profile}:${thread.status}`))

    act(() => void openBot('writer'))
    await settle()
    stop()

    expect(painted).toEqual(['writer:found', 'writer:found'])
    expect(calls(request, 'session.list').map(([, params]) => params?.profile)).toContain('writer')
  })

  it('moves on to the live tip when the thread rotated while the assistant worked in the background', async () => {
    const threads = { default: 'apex-root', writer: 'writer-root' }

    const request = vi.fn(async (method: string, params?: Record<string, unknown>) =>
      method === 'session.list' && params?.profile === 'writer' && threads.writer !== 'writer-root'
        ? { sessions: [{ id: 'writer-root', resolved_id: threads.writer, title: MAIN_THREAD_TITLE }] }
        : gateway(threads)(method, params)
    ) as unknown as RequestGateway

    await onApexWithWriterKnown(request)
    warmEngines()
    // Compressed in the background: this window still holds the old tip.
    threads.writer = 'writer-tip-2'

    act(() => void openBot('writer'))
    await settle()

    expect(visited).toEqual(['/apex-root', '/writer-root', '/writer-tip-2'])
    expect($selectedStoredSessionId.get()).toBe('writer-tip-2')
    expect($botIntent.get()).toBeNull()
  })

  it('leaves a route the click did not open alone', async () => {
    await onApexWithWriterKnown()
    warmEngines()

    act(() => void openBot('writer'))
    await settle()
    // Confirmed: the thread opened was the live tip. A later rotation is the session's own business.
    act(() => $mainThread.set({ ...$mainThread.get(), ids: ['writer-root', 'writer-tip-3'], tipId: 'writer-tip-3' }))
    await settle()

    expect(visited).toEqual(['/apex-root', '/writer-root'])
  })

  it('leaves alone a route the user moved to before the lookup landed', async () => {
    let answer!: () => void
    const held = new Promise<void>(resolve => (answer = resolve))
    const threads = { default: 'apex-root', writer: 'writer-root' }

    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session.list' && params?.profile === 'writer' && threads.writer !== 'writer-root') {
        await held

        return { sessions: [{ id: 'writer-root', resolved_id: threads.writer, title: MAIN_THREAD_TITLE }] }
      }

      return gateway(threads)(method, params)
    }) as unknown as RequestGateway

    await onApexWithWriterKnown(request)
    warmEngines()
    threads.writer = 'writer-tip-2'

    act(() => void openBot('writer'))
    await settle()
    // An earlier conversation, opened from 「更早的对话」 while the thread was still being confirmed.
    act(() => go('/older-chat'))
    await settle()
    answer()
    await settle()

    expect(visited).toEqual(['/apex-root', '/writer-root', '/older-chat'])
  })

  it('a follow onto a thread already on screen does not navigate again', async () => {
    setMultiBotFlagForTest(true)
    mount(gateway(), '/apex-root', true)
    await waitFor(() => expect($mainThreadsByProfile.get().writer?.rootId).toBe('writer-root'))
    warmEngines()

    const before = navigations

    // A notification opened 小红书文案's thread at its own route while APEX is on screen.
    act(() => go('/writer-root'))
    await waitFor(() => expect($activeGatewayProfile.get()).toBe('writer'))
    await settle()

    expect(ensureGatewayProfile).toHaveBeenCalledWith('writer')
    // The notification's navigation, and no second one from the follow.
    expect(navigations).toBe(before + 1)
    expect(visited).toEqual(['/apex-root', '/writer-root'])
  })

  it('goes back through a fresh draft to the thread of the assistant still answering when the engine cannot start', async () => {
    await onApexWithWriterKnown()
    ensureGatewayProfile.mockRejectedValueOnce(new Error('spawn failed'))

    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    act(() => void openBot('writer').catch(() => undefined))
    await settle()
    vi.mocked(console.error).mockRestore()

    expect(where()).toBe('/apex-root')
    expect(visited).toEqual(['/apex-root', '/writer-root', '/', '/apex-root'])
    expect($activeGatewayProfile.get()).toBe('default')
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
