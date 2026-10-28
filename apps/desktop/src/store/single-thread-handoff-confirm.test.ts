/**
 * hc-1087: every relay goes through the confirm card first (L2, L6). Both entries (our `@`, R4's
 * 「交给 X」) call proposeHandoff; only 「交给它」 reaches hc-1086's startHandoff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setSingleThreadFlagForTest } from './single-thread'
import { type BotProfileRow, botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from './single-thread-bots'
import {
  $handoffs,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest,
  type StartHandoffInput
} from './single-thread-handoff'
import {
  $handoffProposal,
  $handoffReceiverNames,
  confirmHandoffProposal,
  dismissHandoffProposal,
  proposeHandoff
} from './single-thread-handoff-confirm'
import { setToolViewMode } from './tool-view'

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } },
  { name: 'cutter', ui_meta: { apex: { created: 2, name: '剪辑助手' } } }
]

const INPUT: StartHandoffInput = {
  ask: '按这个选题写 3 个标题',
  from: { messageId: 'm1', profile: 'default', storedSessionId: 'chat-a' },
  previous: { text: '租房党衣柜改造，不打孔' },
  to: 'writer'
}

function relayOn(on = true): void {
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(on)
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
}

beforeEach(() => {
  localStorage.clear()
  resetHandoffsForTest()
  $handoffReceiverNames.set({})
})

afterEach(() => {
  dismissHandoffProposal()
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  localStorage.clear()
})

describe('proposeHandoff', () => {
  it('does nothing while relay is off (no card, nothing stored)', () => {
    relayOn(false)

    expect(proposeHandoff(INPUT)).toBe(false)
    expect($handoffProposal.get()).toBeNull()
    expect(confirmHandoffProposal()).toBeNull()
    expect($handoffs.get()).toEqual([])
  })

  it('puts up the card and starts nothing until 「交给它」', () => {
    relayOn()

    expect(proposeHandoff(INPUT, { origin: 'mention' })).toBe(true)
    expect($handoffProposal.get()).toMatchObject({ input: INPUT, origin: 'mention', refusal: null })
    expect($handoffs.get()).toEqual([])
  })

  it('「交给它」 queues the relay, calls onStarted once with it and takes the card down', () => {
    relayOn()

    const onStarted = vi.fn()

    proposeHandoff(INPUT, { onStarted })
    const result = confirmHandoffProposal()

    expect(result?.ok).toBe(true)
    expect($handoffs.get()).toHaveLength(1)
    expect($handoffs.get()[0]).toMatchObject({ ask: INPUT.ask, status: 'queued', to: 'writer' })
    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(onStarted).toHaveBeenCalledWith($handoffs.get()[0])
    expect($handoffProposal.get()).toBeNull()
    expect(confirmHandoffProposal()).toBeNull()
  })

  it('remembers the receiver’s name for a later 「X 已删除」 (K9)', () => {
    relayOn()
    proposeHandoff(INPUT)
    confirmHandoffProposal()

    expect($handoffReceiverNames.get()).toEqual({ writer: '小红书文案' })
    expect(JSON.parse(localStorage.getItem('apex.single-thread.handoff-names.v1')!)).toEqual({ writer: '小红书文案' })
  })

  it('a refusal keeps the card up and says why; nothing starts', () => {
    relayOn()

    const onStarted = vi.fn()

    proposeHandoff({ ...INPUT, to: 'nobody' }, { onStarted })

    expect(confirmHandoffProposal()).toEqual({ ok: false, reason: 'unknown_receiver' })
    expect($handoffProposal.get()?.refusal).toBe('unknown_receiver')
    expect($handoffs.get()).toEqual([])
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('「先不」 starts nothing', () => {
    relayOn()

    const onStarted = vi.fn()

    proposeHandoff(INPUT, { onStarted })
    dismissHandoffProposal()

    expect($handoffProposal.get()).toBeNull()
    expect($handoffs.get()).toEqual([])
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('a new card replaces one not answered: only the new one’s onStarted runs', () => {
    relayOn()

    const first = vi.fn()
    const second = vi.fn()

    proposeHandoff(INPUT, { onStarted: first })
    proposeHandoff({ ...INPUT, ask: '剪成 30 秒', to: 'cutter' }, { onStarted: second })
    confirmHandoffProposal()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect($handoffs.get().map(record => record.to)).toEqual(['cutter'])
  })
})
