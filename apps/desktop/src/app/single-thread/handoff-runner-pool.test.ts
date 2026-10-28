/**
 * hc-1086 with hc-1093: the relay dispatcher against this window's real gateway
 * registry and pool (store/gateway.ts, session-request-router), with only the
 * sockets and main faked. A relay dials the receiver's engine at background
 * priority only — a foreground dial makes main evict another assistant's
 * engine (hc-1093) — and into a full pool it does not dial at all: it waits in
 * the relay queue until a slot frees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMainThreadForTest } from '@/store/main-thread'
import { $poolLimits, POOL_LIMITS_DEFAULTS } from '@/store/pool-limits'
import { $activeGatewayProfile } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import {
  handoffById,
  resetHandoffsForTest,
  setHandoffDispatcher,
  setMultiBotHandoffFlagForTest,
  startHandoff
} from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

import { createHandoffRunner, type HandoffRunner, liveHandoffDeps } from './handoff-runner'

const { engine } = vi.hoisted(() => {
  /** What each profile's engine is asked, over whichever socket reaches it. */
  const calls: [profile: string, method: string][] = []

  return {
    engine: {
      answer(profile: string, method: string): unknown {
        calls.push([profile, method])

        if (method === 'session.list') {
          return { sessions: [{ id: `${profile}-root`, title: 'APEX 主线' }] }
        }

        if (method === 'session.resume') {
          return { running: false, session_id: `${profile}-live`, session_key: `${profile}-root` }
        }

        return { status: 'streaming' }
      },
      calls
    }
  }
})

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  HermesGateway: class {
    connectionState = 'closed'
    profile = ''
    connect = async (wsUrl: string): Promise<void> => {
      this.profile = new URL(wsUrl).searchParams.get('profile') ?? ''
      this.connectionState = 'open'
    }
    close = (): void => {
      this.connectionState = 'closed'
    }
    request = async (method: string) => engine.answer(this.profile, method)
    onEvent = vi.fn(() => () => {})
    onState = vi.fn(() => () => {})
  },
  setApiRequestConnection: vi.fn()
}))

const { closeSecondaryGateways, configureGatewayRegistry, openGatewayForProfile, setPrimaryGateway } =
  await import('@/store/gateway')

const getConnection = vi.fn(async (profile: string, _options?: { priority?: string }) => ({
  authMode: 'token',
  baseUrl: 'http://127.0.0.1:9',
  mode: 'local',
  profile,
  token: 'fake-test-token',
  wsUrl: `ws://127.0.0.1:9/api/ws?token=fake-test-token&profile=${profile}`
}))

const ROSTER = botRosterFrom(
  [
    { is_default: true, name: 'default' },
    { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } },
    { name: 'editor', ui_meta: { apex: { created: 2, name: '剪辑' } } }
  ],
  () => true
)

let runner: HandoffRunner | null = null

const dialsTo = (profile: string) => getConnection.mock.calls.filter(([dialed]) => dialed === profile)
const asked = (profile: string, method: string) => engine.calls.filter(([p, m]) => p === profile && m === method)

beforeEach(async () => {
  localStorage.clear()
  engine.calls.length = 0
  getConnection.mockClear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    getConnection,
    touchBackend: vi.fn(async () => ({ ok: true }))
  }
  configureGatewayRegistry({ onEvent: vi.fn() })
  setPrimaryGateway(
    { connectionState: 'open', request: async (method: string) => engine.answer('default', method) } as never,
    'default'
  )
  $activeGatewayProfile.set('default')
  resetHandoffsForTest()
  resetMainThreadForTest()
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(ROSTER)
  // One pool slot, already taken by 剪辑's engine.
  $poolLimits.set({ ...POOL_LIMITS_DEFAULTS, maxBackends: 1 })
  await openGatewayForProfile('editor')
  getConnection.mockClear()
})

afterEach(() => {
  runner?.dispose()
  runner = null
  setHandoffDispatcher(null)
  closeSecondaryGateways()
  $poolLimits.set({ ...POOL_LIMITS_DEFAULTS })
  resetHandoffsForTest()
  resetMainThreadForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

function start(): HandoffRunner {
  runner = createHandoffRunner(liveHandoffDeps(), {
    missingRounds: 2,
    pollMs: 20,
    queueMs: 15,
    retryAfterMs: 200,
    settleMs: 2,
    unreachableRounds: 3
  })
  setHandoffDispatcher(runner)

  return runner
}

const relayTo = (to: string) =>
  startHandoff({ ask: '写成文案', from: { messageId: null, profile: 'default', storedSessionId: null }, to })

describe('the relay and the engine pool', () => {
  it('into a full pool: no dial for the receiver at all, the relay waits as pool_full', async () => {
    start()
    const started = relayTo('writer')
    const id = started.ok ? started.handoff.id : ''

    await vi.waitFor(() => expect(handoffById(id)?.queueReason).toBe('pool_full'))
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(dialsTo('writer')).toEqual([])
    expect(asked('writer', 'prompt.submit')).toEqual([])
    expect(handoffById(id)?.status).toBe('queued')
  })

  it('a slot frees: it dials the receiver at background priority, never foreground', async () => {
    start()
    const started = relayTo('writer')
    const id = started.ok ? started.handoff.id : ''

    await vi.waitFor(() => expect(handoffById(id)?.queueReason).toBe('pool_full'))
    $poolLimits.set({ ...POOL_LIMITS_DEFAULTS, maxBackends: 2 })

    await vi.waitFor(() => expect(asked('writer', 'prompt.submit')).toHaveLength(1))
    expect(asked('writer', 'session.list')).toHaveLength(1)
    expect(dialsTo('writer').length).toBeGreaterThan(0)
    // getConnection(profile) with no options is main's background dial; { priority: 'foreground' } may evict.
    expect(getConnection.mock.calls.filter(([, options]) => options !== undefined)).toEqual([])
  })

  it('a receiver whose engine is already up is reached through its open socket, pool full or not', async () => {
    start()
    relayTo('editor')

    await vi.waitFor(() => expect(asked('editor', 'prompt.submit')).toHaveLength(1))
    expect(getConnection.mock.calls.filter(([, options]) => options !== undefined)).toEqual([])
  })
})
