import { cleanup, render, waitFor } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getSessionMessages } from '@/hermes'
import { $activeGatewayProfile, $newChatProfile } from '@/store/profile'
import {
  $currentCwd,
  $freshDraftReady,
  $messages,
  $resumeFailedSessionId,
  $sessions,
  setFreshDraftReady,
  setMessages,
  setResumeFailedSessionId,
  setSessions
} from '@/store/session'

import type { ClientSessionState } from '../../types'

import { useSessionActions } from './use-session-actions'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listAllProfileSessions: vi.fn(),
  setApiRequestProfile: vi.fn(),
  setSessionArchived: vi.fn()
}))

const RUNTIME_SESSION_ID = 'rt-new-001'

function Harness({
  onReady,
  requestGateway
}: {
  onReady: (create: (preview?: string | null) => Promise<string | null>) => void
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })

  const actions = useSessionActions({
    activeSessionId: null,
    activeSessionIdRef: ref<string | null>(null),
    busyRef: ref(false),
    creatingSessionRef: ref(false),
    ensureSessionState: () => ({}) as ClientSessionState,
    getRouteToken: () => 'token',
    navigate: vi.fn() as never,
    requestGateway,
    runtimeIdByStoredSessionIdRef: ref(new Map<string, string>()),
    selectedStoredSessionId: null,
    selectedStoredSessionIdRef: ref<string | null>(null),
    sessionStateByRuntimeIdRef: ref(new Map<string, ClientSessionState>()),
    syncSessionStateToView: vi.fn(),
    updateSessionState: () => ({}) as ClientSessionState
  })

  useEffect(() => {
    onReady(actions.createBackendSessionForSend)
  }, [actions.createBackendSessionForSend, onReady])

  return null
}

async function createWith(profileSetup: () => void): Promise<Record<string, unknown> | undefined> {
  let createParams: Record<string, unknown> | undefined

  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'session.create') {
      createParams = params

      return { session_id: RUNTIME_SESSION_ID, stored_session_id: null } as never
    }

    return {} as never
  })

  $currentCwd.set('')
  profileSetup()

  let create: ((preview?: string | null) => Promise<string | null>) | null = null
  render(<Harness onReady={c => (create = c)} requestGateway={requestGateway} />)
  await waitFor(() => expect(create).not.toBeNull())
  await create!()

  return createParams
}

describe('createBackendSessionForSend profile routing', () => {
  afterEach(() => {
    cleanup()
    $newChatProfile.set(null)
    $activeGatewayProfile.set('default')
    vi.restoreAllMocks()
  })

  it('routes a plain new chat (no explicit profile) to the live gateway profile', async () => {
    // The "rubberband to default" bug: the top New Session button clears
    // $newChatProfile to null. In global-remote mode one backend serves every
    // profile, so an omitted `profile` lands the chat on the launch (default)
    // profile. The session must instead carry the active gateway profile.
    const params = await createWith(() => {
      $activeGatewayProfile.set('coder')
      $newChatProfile.set(null)
    })

    expect(params).toMatchObject({ profile: 'coder' })
  })

  it('honours an explicit per-profile "+" selection', async () => {
    const params = await createWith(() => {
      $activeGatewayProfile.set('coder')
      $newChatProfile.set('analyst')
    })

    expect(params).toMatchObject({ profile: 'analyst' })
  })

  it('passes the default profile for single-profile users (backend resolves it to launch)', async () => {
    const params = await createWith(() => {
      $activeGatewayProfile.set('default')
      $newChatProfile.set(null)
    })

    expect(params).toMatchObject({ profile: 'default' })
  })
})

// ── Resume failure recovery (the "stuck loading session window" bug) ──────────
// When session.resume rejects AND the REST transcript fallback ALSO fails, the
// hook must (a) not throw out of the fallback (which stranded the loader), and
// (b) arm $resumeFailedSessionId so use-route-resume can retry. A resume that
// succeeds must NOT leave the flag armed.
function ResumeHarness({
  onReady,
  requestGateway
}: {
  onReady: (resume: (storedSessionId: string, replaceRoute?: boolean) => Promise<unknown>) => void
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })

  const actions = useSessionActions({
    activeSessionId: null,
    activeSessionIdRef: ref<string | null>(null),
    busyRef: ref(false),
    creatingSessionRef: ref(false),
    ensureSessionState: () => ({}) as ClientSessionState,
    getRouteToken: () => 'token',
    navigate: vi.fn() as never,
    requestGateway,
    runtimeIdByStoredSessionIdRef: ref(new Map<string, string>()),
    selectedStoredSessionId: null,
    selectedStoredSessionIdRef: ref<string | null>(null),
    sessionStateByRuntimeIdRef: ref(new Map<string, ClientSessionState>()),
    syncSessionStateToView: vi.fn(),
    updateSessionState: (_sessionId, updater) => updater({} as ClientSessionState)
  })

  useEffect(() => {
    onReady(actions.resumeSession)
  }, [actions.resumeSession, onReady])

  return null
}

describe('resumeSession failure recovery', () => {
  afterEach(() => {
    cleanup()
    setResumeFailedSessionId(null)
    setMessages([])
    vi.restoreAllMocks()
  })

  async function runResume(
    requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  ): Promise<void> {
    let resume: ((storedSessionId: string, replaceRoute?: boolean) => Promise<unknown>) | null = null
    render(<ResumeHarness onReady={r => (resume = r)} requestGateway={requestGateway} />)
    await waitFor(() => expect(resume).not.toBeNull())
    await resume!('stored-1', true)
  }

  it('arms $resumeFailedSessionId when resume RPC and REST fallback both fail', async () => {
    // session.resume rejects (e.g. timeout against a wedged backend)...
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'session.resume') {
        throw new Error('request timed out: session.resume')
      }

      return {} as never
    })

    // ...and the REST transcript fallback also rejects (backend unreachable).
    vi.mocked(getSessionMessages).mockRejectedValue(new Error('network down'))

    await runResume(requestGateway)

    // The window is no longer silently stranded: the failure latch is armed for
    // the stored session, which use-route-resume consumes to retry.
    expect($resumeFailedSessionId.get()).toBe('stored-1')
  })

  it('does NOT arm the failure latch when the resume RPC fails but the REST fallback paints history', async () => {
    // session.resume rejects, but the REST transcript fallback succeeds and
    // hydrates a readable transcript — the window is NOT stranded.
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'session.resume') {
        throw new Error('request timed out: session.resume')
      }

      return {} as never
    })

    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: [
        { content: 'hello', role: 'user', timestamp: 1 },
        { content: 'hi there', role: 'assistant', timestamp: 2 }
      ],
      session_id: 'stored-1'
    } as never)

    await runResume(requestGateway)

    // Arming here would auto-retry a window that already shows history and,
    // on exhaustion, blank that transcript behind the error overlay — a
    // regression vs. plain fallback-success. The latch must stay clear.
    expect($resumeFailedSessionId.get()).toBeNull()
    // The fallback transcript is visible.
    expect($messages.get().length).toBeGreaterThan(0)
  })

  it('does NOT throw out of the fallback when REST also fails (no unhandled rejection)', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'session.resume') {
        throw new Error('request timed out: session.resume')
      }

      return {} as never
    })

    vi.mocked(getSessionMessages).mockRejectedValue(new Error('network down'))

    // resumeSession must resolve (swallow the fallback failure), not reject.
    await expect(runResume(requestGateway)).resolves.toBeUndefined()
  })

  it('leaves the failure latch clear when resume succeeds', async () => {
    // Pre-arm to prove a successful resume clears it (entry-clear path).
    setResumeFailedSessionId('stored-1')

    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session.resume') {
        return { session_id: 'runtime-1', resumed: params?.session_id, messages: [], info: {} } as never
      }

      return {} as never
    })

    vi.mocked(getSessionMessages).mockResolvedValue({ messages: [] } as never)

    await runResume(requestGateway)

    expect($resumeFailedSessionId.get()).toBeNull()
  })
})

// ── Scenario session request (hc-554 follow-up: pick a scenario → named session) ──
// A scenario picked mid-conversation gets a fresh, scenario-named session
// instead of landing in the middle of an unrelated thread; one picked on an
// already-empty draft is named in place — no reset, so idly browsing scenarios
// never spends an extra draft. Naming itself is deferred to actual session
// creation (a draft has no backend id until createBackendSessionForSend runs),
// so handleScenarioSessionRequest only queues it; these tests exercise both
// halves together, the way pick.ts's single call site actually drives them.
function ScenarioHarness({
  onReady,
  requestGateway
}: {
  onReady: (actions: {
    create: (preview?: string | null) => Promise<string | null>
    handleScenarioSessionRequest: (title: string) => void
    startFreshSessionDraft: () => void
  }) => void
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })

  const actions = useSessionActions({
    activeSessionId: null,
    activeSessionIdRef: ref<string | null>(null),
    busyRef: ref(false),
    creatingSessionRef: ref(false),
    ensureSessionState: () => ({}) as ClientSessionState,
    getRouteToken: () => 'token',
    navigate: vi.fn() as never,
    requestGateway,
    runtimeIdByStoredSessionIdRef: ref(new Map<string, string>()),
    selectedStoredSessionId: null,
    selectedStoredSessionIdRef: ref<string | null>(null),
    sessionStateByRuntimeIdRef: ref(new Map<string, ClientSessionState>()),
    syncSessionStateToView: vi.fn(),
    updateSessionState: () => ({}) as ClientSessionState
  })

  useEffect(() => {
    onReady({
      create: actions.createBackendSessionForSend,
      handleScenarioSessionRequest: actions.handleScenarioSessionRequest,
      startFreshSessionDraft: actions.startFreshSessionDraft
    })
  }, [actions.createBackendSessionForSend, actions.handleScenarioSessionRequest, actions.startFreshSessionDraft, onReady])

  return null
}

function scenarioSessionCreateGateway(storedSessionId: string) {
  return vi.fn(async (method: string) => {
    if (method === 'session.create') {
      return { session_id: RUNTIME_SESSION_ID, stored_session_id: storedSessionId } as never
    }

    if (method === 'session.title') {
      return { title: undefined } as never
    }

    return {} as never
  })
}

async function withScenarioHarness(requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>) {
  let ready: {
    create: (preview?: string | null) => Promise<string | null>
    handleScenarioSessionRequest: (title: string) => void
    startFreshSessionDraft: () => void
  } | null = null

  render(<ScenarioHarness onReady={r => (ready = r)} requestGateway={requestGateway} />)
  await waitFor(() => expect(ready).not.toBeNull())

  return ready!
}

describe('scenario session request (pick → named session)', () => {
  afterEach(() => {
    cleanup()
    setMessages([])
    setSessions([])
    setFreshDraftReady(false)
    vi.restoreAllMocks()
  })

  it('has-messages: resets to a fresh (empty) draft, then names the session it creates', async () => {
    setMessages([{ id: 'm1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }] as never)

    const requestGateway = scenarioSessionCreateGateway('stored-1')
    const { create, handleScenarioSessionRequest } = await withScenarioHarness(requestGateway)

    handleScenarioSessionRequest('拆一条视频')

    // The reset actually ran — reusing in place would have left the prior
    // message untouched, and $freshDraftReady is startFreshSessionDraft's own
    // "a reset just happened" signal.
    expect($messages.get()).toEqual([])
    expect($freshDraftReady.get()).toBe(true)

    await create()

    expect(requestGateway).toHaveBeenCalledWith('session.title', { session_id: RUNTIME_SESSION_ID, title: '拆一条视频' })
    expect($sessions.get().find(s => s.id === 'stored-1')?.title).toBe('拆一条视频')
  })

  it('empty session: names in place with no reset (no session litter from idle browsing)', async () => {
    setMessages([])

    const requestGateway = scenarioSessionCreateGateway('stored-2')
    const { create, handleScenarioSessionRequest } = await withScenarioHarness(requestGateway)

    handleScenarioSessionRequest('热榜')

    // startFreshSessionDraft never ran — its own "a reset just happened" flag
    // stayed at its default.
    expect($freshDraftReady.get()).toBe(false)

    await create()

    expect(requestGateway).toHaveBeenCalledWith('session.title', { session_id: RUNTIME_SESSION_ID, title: '热榜' })
    expect($sessions.get().find(s => s.id === 'stored-2')?.title).toBe('热榜')
  })

  it('blank/whitespace scenario name: queues nothing — falls back to the un-named default', async () => {
    setMessages([])

    const requestGateway = scenarioSessionCreateGateway('stored-3')
    const { create, handleScenarioSessionRequest } = await withScenarioHarness(requestGateway)

    handleScenarioSessionRequest('   ')
    await create()

    expect(requestGateway).not.toHaveBeenCalledWith('session.title', expect.anything())
    expect($sessions.get().find(s => s.id === 'stored-3')?.title).toBeNull()
  })

  it('a queued title is consumed exactly once — a later, unrelated session creation gets no title', async () => {
    setMessages([{ id: 'm1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }] as never)

    const requestGateway = scenarioSessionCreateGateway('stored-4')
    const { create, handleScenarioSessionRequest } = await withScenarioHarness(requestGateway)

    handleScenarioSessionRequest('拆一条视频')
    await create()
    requestGateway.mockClear()

    // A second session created from the same harness with no new scenario
    // request in between (e.g. the composer just sends another message on a
    // later fresh draft) must not inherit the already-consumed title.
    await create()

    expect(requestGateway).not.toHaveBeenCalledWith('session.title', expect.anything())
  })

  it('an unrelated fresh-draft reset (Cmd+N) clears a stale title from an abandoned scenario pick', async () => {
    setMessages([{ id: 'm1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }] as never)

    const requestGateway = scenarioSessionCreateGateway('stored-5')
    const { create, handleScenarioSessionRequest, startFreshSessionDraft } = await withScenarioHarness(requestGateway)

    handleScenarioSessionRequest('拆一条视频') // queues "拆一条视频" for the draft this starts
    // The user abandons that draft without sending, then starts an unrelated
    // one — the same reset Cmd+N / sidebar "new session" call directly. The
    // abandoned scenario's name must not attach to this unrelated chat.
    startFreshSessionDraft()

    await create()

    expect(requestGateway).not.toHaveBeenCalledWith('session.title', expect.anything())
    expect($sessions.get().find(s => s.id === 'stored-5')?.title).toBeNull()
  })
})
