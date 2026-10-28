/**
 * hc-1086: the multi-bot shell runs the relay (接力) dispatcher only while relay
 * is on and the gateway is open, against this window's own routing
 * (session-request-router, faked here), and a reopened window picks up a relay
 * the last one left in its turn.
 */
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAIN_THREAD_TITLE, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import {
  $handoffs,
  handoffById,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest,
  startHandoff
} from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

import type { RequestGateway } from './composer-middleware'
import { useSingleThreadShell } from './use-single-thread-shell'

const { routed } = vi.hoisted(() => ({
  routed: vi.fn(async (_profile: unknown, _ambient: unknown, method: string, params: Record<string, unknown> = {}) => {
    if (method === 'session.list') {
      return { sessions: [{ id: `${String(params.profile)}-root`, title: 'APEX 主线' }] }
    }

    if (method === 'session.resume') {
      return {
        running: false,
        session_id: `${String(params.profile)}-live`,
        session_key: `${String(params.profile)}-root`
      }
    }

    return {}
  })
}))

vi.mock('@/store/session-request-router', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestForSessionProfile: routed
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile: vi.fn(async () => undefined)
}))

const shellRequest = (async () => ({ profiles: [], sessions: [] })) as unknown as RequestGateway

function Shell() {
  useSingleThreadShell(shellRequest)

  return null
}

const mount = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Shell />
    </MemoryRouter>
  )

const ROSTER = botRosterFrom(
  [
    { is_default: true, name: 'default' },
    { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }
  ],
  () => true
)

const relay = () =>
  startHandoff({ ask: '写成文案', from: { messageId: null, profile: 'default', storedSessionId: null }, to: 'writer' })

const routedMethods = () => routed.mock.calls.map(([profile, , method]) => `${String(profile)} ${method}`)

beforeEach(() => {
  localStorage.clear()
  routed.mockClear()
  resetHandoffsForTest()
  resetMainThreadForTest()
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(ROSTER)
  $activeGatewayProfile.set('default')
  $gatewayState.set('open')
})

afterEach(() => {
  cleanup()
  resetHandoffsForTest()
  resetMainThreadForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  $gatewayState.set('idle')
  localStorage.clear()
})

describe('the shell runs the relay dispatcher', () => {
  it('while relay is on and the gateway open: a queued relay reaches the receiver’s own engine', async () => {
    mount()
    const started = relay()

    expect(started.ok).toBe(true)
    await vi.waitFor(() => expect(routedMethods()).toContain('writer prompt.submit'))
    expect(routedMethods()[0]).toBe('writer session.list')
    expect(routed.mock.calls[0][3]).toMatchObject({ profile: 'writer', title: MAIN_THREAD_TITLE })
  })

  it('not while the gateway is closed; it starts when the gateway opens', async () => {
    $gatewayState.set('idle')
    mount()
    const started = relay()

    await act(async () => new Promise(resolve => setTimeout(resolve, 50)))
    expect(started.ok && handoffById(started.handoff.id)?.status).toBe('queued')
    expect(routed).not.toHaveBeenCalled()

    await act(async () => $gatewayState.set('open'))
    await vi.waitFor(() => expect(routedMethods()).toContain('writer prompt.submit'))
  })

  it('stops with the shell: a relay queued after unmount reaches nobody', async () => {
    mount().unmount()
    relay()

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(routed).not.toHaveBeenCalled()
  })

  it('a reopened window follows a relay the last one left in its turn, without submitting again', async () => {
    const started = relay()

    expect(started.ok).toBe(true)
    const id = started.ok ? started.handoff.id : ''

    $handoffs.set(
      $handoffs.get().map(record =>
        record.id === id
          ? {
              ...record,
              attempts: 1,
              status: 'running' as const,
              turn: { requestText: 'x', runtimeSessionId: 'old', storedSessionId: 'writer-root', submittedAt: 1 }
            }
          : record
      )
    )
    mount()

    await vi.waitFor(() => expect(routedMethods()).toContain('writer session.resume'))
    expect(routedMethods()).not.toContain('writer prompt.submit')
  })
})
