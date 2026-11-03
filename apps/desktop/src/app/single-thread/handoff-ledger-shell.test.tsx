/**
 * hc-1090: the multi-bot shell notes a relay that comes back in the memory
 * ledger — including the one a reopened window's dispatcher harvests the moment
 * it starts — and with relay off mounts nothing.
 */
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'
import type { DesktopMemoryLedgerRequest, DesktopMemoryLedgerResult } from '@/lib/memory-ledger'
import { $authState } from '@/store/auth'
import { resetHandoffLedgerForTest } from '@/store/handoff-ledger'
import { resetMainThreadForTest } from '@/store/main-thread'
import { $memoryLedger } from '@/store/memory-ledger'
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

const { relayId, routed } = vi.hoisted(() => {
  const relayId = { current: '' }

  const routed = vi.fn(
    async (_profile: unknown, _ambient: unknown, method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.list') {
        return { sessions: [{ id: `${String(params.profile)}-root`, title: 'APEX 主线' }] }
      }

      if (method !== 'session.resume') {
        return {}
      }

      const state = { running: false, session_id: 'writer-live', session_key: 'writer-root' }

      // The turn the last window left behind has finished: its hand-over and the reply are in the thread.
      return params.omit_messages
        ? state
        : {
            ...state,
            messages: [
              { content: `<!-- apex:handoff v=1 id=${relayId.current} from=default -->\n写成文案`, role: 'user' },
              {
                content: '写好了。\n<!-- apex:handback\n写好了 3 段文案，第 2 段最稳。\n-->',
                role: 'assistant'
              }
            ]
          }
    }
  )

  return { relayId, routed }
})

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

const ledger = vi.fn(async (_request: DesktopMemoryLedgerRequest): Promise<DesktopMemoryLedgerResult> => ({
  created: true,
  ledger: null,
  ok: true
}))

/** A relay the last window left in its turn. */
function leftInTurn(): string {
  const started = startHandoff({
    ask: '写成文案',
    from: { messageId: null, profile: 'default', storedSessionId: null },
    to: 'writer'
  })

  if (!started.ok) {
    throw new Error(started.reason)
  }

  const id = started.handoff.id

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
  relayId.current = id

  return id
}

beforeEach(() => {
  localStorage.clear()
  routed.mockClear()
  ledger.mockClear()
  resetHandoffsForTest()
  resetHandoffLedgerForTest()
  resetMainThreadForTest()
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(ROSTER)
  $activeGatewayProfile.set('default')
  $gatewayState.set('open')
  $authState.set({ ...$authState.get(), accountId: 'acc-1', status: 'signed-in' })
  $memoryLedger.set({ accountId: 'acc-1', ledger: null, status: 'ready' })
  setRuntimeI18nLocale('zh')
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { managed: { memoryLedger: ledger } }
})

afterEach(() => {
  cleanup()
  resetHandoffsForTest()
  resetHandoffLedgerForTest()
  resetMainThreadForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  $gatewayState.set('idle')
  setRuntimeI18nLocale('en')
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  localStorage.clear()
})

describe('the shell notes relays that come back (hc-1090)', () => {
  it('a reopened window harvests the result and the ledger hears it, once', async () => {
    const id = leftInTurn()

    mount()

    await vi.waitFor(() => expect(handoffById(id)?.status).toBe('returned'))
    await vi.waitFor(() => expect(ledger).toHaveBeenCalledTimes(1))
    expect(ledger.mock.calls[0][0]).toEqual({
      action: 'add',
      content: '在电脑上，小红书文案 帮 APEX 做完了「写成文案」，交回：写好了 3 段文案，第 2 段最稳。',
      kind: 'recent'
    })

    // Opened again: nothing new to write.
    cleanup()
    resetHandoffLedgerForTest({ keepMarks: true })
    mount()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ledger).toHaveBeenCalledTimes(1)
  })

  it('relay off: the result is not written', async () => {
    const id = leftInTurn()

    setMultiBotHandoffFlagForTest(false)
    mount()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(handoffById(id)?.status).toBe('running')
    expect(routed).not.toHaveBeenCalled()
    expect(ledger).not.toHaveBeenCalled()
    expect(localStorage.getItem('apex.single-thread.handoff-ledger.v1')).toBeNull()
  })
})
