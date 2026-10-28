/**
 * hc-1086 (多助手二期 R1): the relay (接力) records and the interface the relay
 * card (R2), the 「交给 X」 button (R4) and the ledger line (R5) use. These are
 * the use cases; the dispatch itself is handoff-runner.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setSingleThreadFlagForTest } from './single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from './single-thread-bots'
import {
  $handoffs,
  cancelHandoffsForProfile,
  carryFrom,
  forgetHandoff,
  HANDOFF_CARRY_MAX_CHARS,
  HANDOFF_MAX_BATONS,
  handoffById,
  type HandoffDispatcher,
  handoffQueuePosition,
  type HandoffRecord,
  handoffsFrom,
  handoffsTo,
  isHandoffMode,
  MULTI_BOT_HANDOFF_HINT_KEY,
  multiBotHandoffSwitchFrom,
  onHandoffReturned,
  onHandoffSettled,
  resetHandoffsForTest,
  retryHandoff,
  setHandoffDispatcher,
  setMultiBotHandoffFlagForTest,
  startHandoff,
  type StartHandoffInput,
  stopHandoff,
  updateHandoff
} from './single-thread-handoff'
import { setToolViewMode } from './tool-view'

const ROSTER = botRosterFrom(
  [
    { is_default: true, name: 'default' },
    { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } },
    { name: 'editor', ui_meta: { apex: { created: 2, name: '剪辑' } } },
    { name: 'titles', ui_meta: { apex: { created: 3, name: '标题' } } }
  ],
  () => true
)

const FROM_APEX = { messageId: 'm-7', profile: 'default', storedSessionId: 'apex-root' }

function input(patch: Partial<StartHandoffInput> = {}): StartHandoffInput {
  return {
    ask: '把这个选题写成小红书文案',
    from: FROM_APEX,
    previous: { text: '选题：秋天第一杯奶茶' },
    to: 'writer',
    ...patch
  }
}

function started(patch: Partial<StartHandoffInput> = {}): HandoffRecord {
  const result = startHandoff(input(patch))

  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`)
  }

  return result.handoff
}

function returned(id: string, text = '文案写好了'): HandoffRecord {
  return updateHandoff(id, {
    finishedAt: Date.now(),
    result: { at: Date.now(), files: ['/tmp/a.png'], links: [], summary: text, text },
    status: 'returned'
  })!
}

function on(): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(ROSTER)
}

beforeEach(() => {
  localStorage.clear()
  resetHandoffsForTest()
  on()
})

afterEach(() => {
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  localStorage.clear()
})

describe('the switch', () => {
  it.each([
    ['the platform', { payload: { desktop_features: { multi_bot_handoff: true } } }, true],
    ['a non-literal true', { payload: { desktop_features: { multi_bot_handoff: 'true' } } }, false],
    ['this install on', { installSwitches: { multi_bot_handoff: true }, payload: null }, true],
    [
      'this install off over the platform',
      { installSwitches: { multi_bot_handoff: false }, payload: { desktop_features: { multi_bot_handoff: true } } },
      false
    ],
    ['nothing', null, false]
  ])('%s', (_label, state, expected) => {
    expect(multiBotHandoffSwitchFrom(state as never)).toBe(expected)
  })

  it.each([
    ['several assistants off', () => setMultiBotFlagForTest(false)],
    ['developer mode', () => setToolViewMode('technical')],
    ['single-thread off', () => setSingleThreadFlagForTest(false)],
    ['the relay switch off', () => setMultiBotHandoffFlagForTest(false)]
  ])('counts only with several assistants on screen: %s turns it off and refuses every relay', (_label, turnOff) => {
    turnOff()

    expect(isHandoffMode()).toBe(false)
    expect(startHandoff(input())).toEqual({ ok: false, reason: 'off' })
    expect($handoffs.get()).toEqual([])
  })

  it('writes its hint only when the value changes, so the off path writes nothing', () => {
    resetHandoffsForTest()
    localStorage.clear()
    setMultiBotHandoffFlagForTest(false)
    expect(localStorage.getItem(MULTI_BOT_HANDOFF_HINT_KEY)).toBeNull()

    setMultiBotHandoffFlagForTest(true)
    expect(localStorage.getItem(MULTI_BOT_HANDOFF_HINT_KEY)).not.toBeNull()
  })
})

describe('starting a relay (R4 「交给 X」, R2 @)', () => {
  it('queues it with who to whom, what was carried and where it came from', () => {
    const handoff = started()

    expect(handoff).toMatchObject({
      ask: '把这个选题写成小红书文案',
      baton: 1,
      carry: { files: [], links: [], text: '选题：秋天第一杯奶茶', truncated: false },
      from: { ...FROM_APEX, name: 'APEX' },
      status: 'queued',
      to: 'writer'
    })
    expect(handoff.chainId).toBe(handoff.id)
    expect(handoffsFrom('default')).toEqual([handoff])
    expect(handoffsTo('writer')).toEqual([handoff])
    expect(handoffQueuePosition(handoff.id)).toBe(1)
  })

  it('carries the first 2,000 characters and every file and link (L4)', () => {
    const long = '字'.repeat(HANDOFF_CARRY_MAX_CHARS + 5)

    expect(carryFrom({ files: ['/a.mp4', '/a.mp4', ' '], links: ['https://x.test'], text: long })).toEqual({
      files: ['/a.mp4'],
      links: ['https://x.test'],
      text: '字'.repeat(HANDOFF_CARRY_MAX_CHARS),
      truncated: true
    })
  })

  it('carries the result without its next-step buttons or an earlier 交回摘要 (R3 request)', () => {
    const text = '\r\n正文\r\n<!-- apex:next\n出整条 | 出整条成片\n-->\n<!-- apex:handback\n上一棒\n-->\n'

    expect(carryFrom({ text })).toEqual({ files: [], links: [], text: '正文', truncated: false })
  })

  it('names the sender as the roster does when it started (【name 交来的活】)', () => {
    expect(started({ from: { messageId: null, profile: 'editor', storedSessionId: null } }).from.name).toBe('剪辑')
    expect(
      started({ from: { messageId: null, name: ' 小剪 ', profile: 'titles', storedSessionId: null }, to: 'editor' })
        .from.name
    ).toBe('小剪')
  })

  it.each([
    ['to the sender itself', { to: 'default' }, 'self'],
    ['to someone not on the roster', { to: 'ghost' }, 'unknown_receiver'],
    ['with nothing to do', { ask: ' ', previous: null }, 'empty'],
    ['with a result but no ask (the hand-over always says 要你做)', { ask: '' }, 'empty']
  ] as const)('refuses one %s', (_label, patch, reason) => {
    expect(startHandoff(input(patch))).toEqual({ ok: false, reason })
  })

  it('refuses a receiver handing work on while it works on a relay (no nesting, L3)', () => {
    const first = started()

    expect(
      startHandoff(input({ from: { messageId: null, profile: 'writer', storedSessionId: null }, to: 'editor' }))
    ).toEqual({
      ok: false,
      reason: 'nested'
    })

    returned(first.id)
    expect(
      startHandoff(input({ from: { messageId: null, profile: 'writer', storedSessionId: null }, to: 'editor' })).ok
    ).toBe(true)
  })

  it('carries a chain on from a returned baton, at most 3 batons (L3, R6)', () => {
    const one = started()

    expect(startHandoff(input({ continues: one.id, to: 'editor' }))).toEqual({ ok: false, reason: 'unknown_continues' })

    returned(one.id, '文案：秋天第一杯奶茶来了')
    const two = startHandoff({ ask: '剪成 15 秒', continues: one.id, from: FROM_APEX, to: 'editor' })

    expect(two.ok && two.handoff).toMatchObject({
      baton: 2,
      carry: { files: ['/tmp/a.png'], text: '文案：秋天第一杯奶茶来了' },
      chainId: one.id
    })

    const three = two.ok ? returned(two.handoff.id) : null
    const third = startHandoff({ ask: '起三个标题', continues: three!.id, from: FROM_APEX, to: 'titles' })

    expect(third.ok && third.handoff.baton).toBe(HANDOFF_MAX_BATONS)

    const last = third.ok ? returned(third.handoff.id) : null

    expect(startHandoff({ ask: '再来', continues: last!.id, from: FROM_APEX, to: 'writer' })).toEqual({
      ok: false,
      reason: 'too_many_batons'
    })
  })

  it('pokes the dispatcher', () => {
    const kick = vi.fn()

    setHandoffDispatcher({ interrupt: vi.fn(async () => undefined), kick })
    started()

    expect(kick).toHaveBeenCalledTimes(1)
  })
})

describe('the queue (L7)', () => {
  it('numbers queued relays first come, first served (「排第 N」)', () => {
    const a = started()
    const b = started({ to: 'editor' })
    const c = started({ to: 'titles' })

    updateHandoff(a.id, { status: 'running' })

    expect([a, b, c].map(record => handoffQueuePosition(record.id))).toEqual([null, 1, 2])
  })
})

describe('stopping (「停下」)', () => {
  it('takes a queued relay out of the queue without touching any engine', async () => {
    const interrupt = vi.fn(async () => undefined)

    setHandoffDispatcher({ interrupt, kick: vi.fn() })
    const handoff = started()

    await expect(stopHandoff(handoff.id)).resolves.toBe(true)
    expect(handoffById(handoff.id)?.status).toBe('stopped')
    expect(interrupt).not.toHaveBeenCalled()
    await expect(stopHandoff(handoff.id)).resolves.toBe(false)
  })

  it('interrupts the receiver’s turn of a running one', async () => {
    const interrupt = vi.fn<HandoffDispatcher['interrupt']>(async () => undefined)

    setHandoffDispatcher({ interrupt, kick: vi.fn() })
    const handoff = started()

    updateHandoff(handoff.id, { status: 'running' })
    await stopHandoff(handoff.id)

    expect(interrupt.mock.calls.map(([record]) => [record.id, record.to])).toEqual([[handoff.id, 'writer']])
    expect(handoffById(handoff.id)?.status).toBe('stopped')
  })
})

describe('deleting an assistant (K9)', () => {
  it('cancels every relay still queued or running to or from it, and only those', async () => {
    const interrupt = vi.fn<HandoffDispatcher['interrupt']>(async () => undefined)

    setHandoffDispatcher({ interrupt, kick: vi.fn() })
    const toWriter = started()
    const fromWriter = started({ from: { messageId: null, profile: 'editor', storedSessionId: null }, to: 'titles' })
    const done = started({ to: 'titles' })

    returned(toWriter.id)
    const again = started()

    // Both are mid-turn: the one to the deleted receiver and the one it sent.
    updateHandoff(again.id, { status: 'running' })
    updateHandoff(fromWriter.id, {
      from: { messageId: null, profile: 'writer', storedSessionId: null },
      status: 'running'
    })
    returned(done.id)

    await expect(cancelHandoffsForProfile('writer')).resolves.toBe(2)

    expect(handoffById(again.id)).toMatchObject({ cancelReason: 'receiver_deleted', status: 'cancelled' })
    expect(handoffById(fromWriter.id)).toMatchObject({ cancelReason: 'sender_deleted', status: 'cancelled' })
    expect(handoffById(toWriter.id)?.status).toBe('returned')
    // The surviving receiver's turn is interrupted; the deleted one's engine stops with its profile.
    expect(interrupt.mock.calls.map(([record]) => record.to)).toEqual(['titles'])
  })

  it('does nothing at all when there is no relay', async () => {
    const before = localStorage.length

    await expect(cancelHandoffsForProfile('writer')).resolves.toBe(0)
    expect(localStorage.length).toBe(before)
  })
})

describe('what came back (R5, R2, R3)', () => {
  it('fires 交回 once when a relay returns, and 「结束」 for every way it ends', () => {
    const returnedSeen: string[] = []
    const settledSeen: string[] = []

    onHandoffReturned(record => returnedSeen.push(record.id))
    onHandoffSettled(record => settledSeen.push(`${record.id}:${record.status}`))

    const a = started()
    const b = started({ to: 'editor' })

    updateHandoff(a.id, { status: 'running' })
    returned(a.id)
    updateHandoff(a.id, { ask: 'edited after it came back' })
    updateHandoff(b.id, { failure: { kind: 'turn_error', message: 'x' }, status: 'failed' })

    expect(returnedSeen).toEqual([a.id])
    expect(settledSeen).toEqual([`${a.id}:returned`, `${b.id}:failed`])
  })
})

describe('retry and forget', () => {
  it('puts a failed relay back at the end of the queue as the same relay (「再试一次」)', () => {
    const a = started()
    const b = started({ to: 'editor' })

    updateHandoff(a.id, { attempts: 2, failure: { kind: 'interrupted', message: '' }, status: 'failed' })

    expect(retryHandoff(a.id)).toBe(true)
    expect(handoffById(a.id)).toMatchObject({ attempts: 0, failure: null, status: 'queued' })
    expect([b, a].map(record => handoffQueuePosition(record.id))).toEqual([1, 2])
    expect(retryHandoff(b.id)).toBe(false)
  })

  it('forgets a settled relay, never an active one', () => {
    const a = started()

    forgetHandoff(a.id)
    expect(handoffById(a.id)).not.toBeNull()

    returned(a.id)
    forgetHandoff(a.id)
    expect(handoffById(a.id)).toBeNull()
  })
})

describe('kept on this computer', () => {
  it('survives a reopened window (Mac: the window closes, the app stays)', async () => {
    const a = started()

    updateHandoff(a.id, { status: 'running' })
    vi.resetModules()
    const reloaded = await import('./single-thread-handoff')

    expect(reloaded.$handoffs.get().map(record => [record.id, record.status])).toEqual([[a.id, 'running']])
  })
})
