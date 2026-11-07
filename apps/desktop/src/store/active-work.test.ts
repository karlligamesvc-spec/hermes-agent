import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'

import { $mainThreadsByProfile, type MainThreadState } from './main-thread'
import { $sessions } from './session'
import { clearAllSessionStates, publishSessionState } from './session-states'
import { setSingleEngineFlagForTest } from './single-engine'
import { $singleThreadFlag } from './single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from './single-thread-bots'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const setActiveWork = vi.fn()

const busy = (storedSessionId: string, isBusy: boolean) =>
  ({ busy: isBusy, needsInput: false, storedSessionId }) as ClientSessionState

const session = (id: string, title: null | string) => ({ id, title }) as (typeof $sessions.value)[number]

beforeAll(async () => {
  desktopWindow.hermesDesktop = { setActiveWork } as unknown as Window['hermesDesktop']
  // Subscribes at import time, so the bridge has to exist first.
  await import('./active-work')
})

beforeEach(() => {
  clearAllSessionStates()
  $sessions.set([])
  setActiveWork.mockClear()
})

describe('active work bridge', () => {
  // hc-1100: the stored ids also feed the main process's ledger of turns a quit cuts off.
  it('reports a busy session by title and id', () => {
    $sessions.set([session('s1', 'Fix login'), session('s2', 'Idle chat')])
    publishSessionState('runtime-1', busy('s1', true))

    expect(setActiveWork).toHaveBeenLastCalledWith({ count: 1, ids: ['s1'], titles: ['Fix login'] })
  })

  it('counts an untitled busy session without inventing a title', () => {
    $sessions.set([session('s1', null)])
    publishSessionState('runtime-1', busy('s1', true))

    expect(setActiveWork).toHaveBeenLastCalledWith({ count: 1, ids: ['s1'], titles: [] })
  })

  it('drops back to nothing when the turn ends', () => {
    $sessions.set([session('s1', 'Fix login')])
    publishSessionState('runtime-1', busy('s1', true))
    publishSessionState('runtime-1', busy('s1', false))

    expect(setActiveWork).toHaveBeenLastCalledWith({ count: 0, ids: [], titles: [] })
  })

  it('does not re-send an unchanged summary', () => {
    $sessions.set([session('s1', 'Fix login')])
    publishSessionState('runtime-1', busy('s1', true))
    setActiveWork.mockClear()

    $sessions.set([session('s1', 'Fix login'), session('s2', 'Something else')])

    expect(setActiveWork).not.toHaveBeenCalled()
  })
})

// hc-1166: with one engine the quit stops every assistant's turn, and every assistant's thread has the same
// title, so the confirmation says whose turns they are.
describe('one engine for every assistant', () => {
  beforeEach(() => {
    $singleThreadFlag.set(true)
    setMultiBotFlagForTest(true)
    resetBotRosterForTest(
      botRosterFrom([{ name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }], () => true)
    )
    $mainThreadsByProfile.set({
      default: {
        ids: ['stored-apex'],
        profile: 'default',
        rootId: 'stored-apex',
        status: 'found',
        tipId: 'stored-apex'
      },
      writer: {
        ids: ['stored-writer'],
        profile: 'writer',
        rootId: 'stored-writer',
        status: 'found',
        tipId: 'stored-writer'
      }
    } as unknown as Record<string, MainThreadState>)
    $sessions.set([session('stored-apex', 'APEX 主线'), session('stored-writer', 'APEX 主线')])
  })

  afterEach(() => {
    setSingleEngineFlagForTest(false)
    $mainThreadsByProfile.set({})
    resetBotRosterForTest()
    setMultiBotFlagForTest(false)
    $singleThreadFlag.set(false)
  })

  it.each([
    [true, ['APEX', '小红书文案']],
    [false, ['APEX 主线', 'APEX 主线']]
  ])('switch %s: names the assistants working', (on, titles) => {
    setSingleEngineFlagForTest(on)
    publishSessionState('runtime-apex', busy('stored-apex', true))
    publishSessionState('runtime-writer', busy('stored-writer', true))

    expect(setActiveWork).toHaveBeenLastCalledWith({ count: 2, ids: ['stored-apex', 'stored-writer'], titles })
  })
})
