/**
 * hc-1091 (多助手二期 R6): the relay plan card as rendered under the reply
 * that proposed it (prototype v2 artboard ⑬) — proposed, started, held,
 * done — and what its buttons do. It reads store/handoff-plan.ts and hc-1086's
 * records; nothing here dispatches a turn.
 */
// First: the recording time zone (the shell harness's fixtures are wall-clock times).
import '@/__identity__/single-thread-shell/time-zone'

import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PLAN_REPLY, PLAN_TRANSCRIPT } from '@/__identity__/handoff-plan/render'
import { renderTranscript, seedShellState } from '@/__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import {
  $handoffPlans,
  handoffPlanKey,
  type HandoffPlanRecord,
  type HandoffPlanStep,
  resetHandoffPlansForTest
} from '@/store/handoff-plan'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $planUsage } from '@/store/plan-usage'
import { $activeGatewayProfile } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import {
  $handoffs,
  handoffById,
  type HandoffRecord,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest
} from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

const { openBot } = vi.hoisted(() => ({ openBot: vi.fn(async (_profile: string) => undefined) }))

vi.mock('@/store/single-thread-bots', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  openBot
}))

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'cutter', ui_meta: { apex: { color: 'teal', created: 2, name: '剪辑助手', shape: 'cloud' } } }
]

const STEPS: HandoffPlanStep[] = [
  { kind: 'have', label: '定选题：租房党衣柜改造，不打孔' },
  {
    ask: '按这个选题写 3 个标题和一段 200 字文案',
    kind: 'relay',
    label: '写标题和文案',
    name: '小红书文案',
    to: 'writer'
  },
  {
    ask: '用小红书文案交回的标题和文案，把素材剪成 30 秒竖屏',
    kind: 'relay',
    label: '剪成 30 秒竖屏',
    name: '剪辑助手',
    to: 'cutter'
  }
]

/** The key the card works out for PLAN_REPLY's block (its legs as the block reads them). */
const KEY = handoffPlanKey('default', [
  { kind: 'have', label: '定选题：租房党衣柜改造，不打孔' },
  { ask: '按这个选题写 3 个标题和一段 200 字文案', kind: 'relay', label: '写标题和文案', to: '小红书文案' },
  {
    ask: '用小红书文案交回的标题和文案，把素材剪成 30 秒竖屏',
    kind: 'relay',
    label: '剪成 30 秒竖屏',
    to: '剪辑助手'
  }
])

const STARTED_AT = new Date(2026, 9, 21, 15, 7).getTime()

function baton(id: string, over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    ask: '按这个选题写 3 个标题和一段 200 字文案',
    attempts: 1,
    baton: 1,
    cancelReason: null,
    carry: { files: [], links: [], text: '选题', truncated: false },
    chainId: 'b1',
    createdAt: STARTED_AT,
    failure: null,
    finishedAt: null,
    from: { messageId: 't3-answer', name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
    id,
    notBefore: null,
    owner: 'acc-1',
    queueReason: null,
    result: null,
    startedAt: STARTED_AT,
    status: 'running',
    to: 'writer',
    turn: null,
    updatedAt: STARTED_AT,
    waitingFor: null,
    ...over
  }
}

function plan(over: Partial<HandoffPlanRecord> = {}): HandoffPlanRecord {
  return {
    batons: ['b1'],
    cancelReason: null,
    createdAt: STARTED_AT,
    end: null,
    finishedAt: null,
    from: { messageId: 't3-answer', name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
    hold: null,
    id: 'pl_1',
    key: KEY,
    owner: 'acc-1',
    restCancelled: false,
    status: 'running',
    steps: STEPS,
    updatedAt: STARTED_AT,
    ...over
  }
}

const returnedResult = (summary: string) => ({
  at: STARTED_AT + 370_000,
  files: ['/Users/me/租房党衣柜改造.mp4'],
  links: [],
  summary,
  text: summary
})

function relayOn(): void {
  seedShellState()
  // A plan starts after the reply that proposed it was written (the harness's clock is earlier).
  vi.setSystemTime(STARTED_AT)
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
  $activeGatewayProfile.set('default')
  $authState.set({ ...$authState.get(), accountId: 'acc-1', status: 'signed-in' })
  noteMainThreadClaimed('default', 'chat-a')
  $selectedStoredSessionId.set('chat-a')
}

function reply(id: string, minute: number, text: string): ThreadMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(2026, 9, 21, 15, minute),
    id,
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
}

function ask(id: string, minute: number, text: string): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: new Date(2026, 9, 21, 15, minute),
    id,
    metadata: { custom: {} },
    role: 'user'
  } as ThreadMessage
}

/** PLAN_TRANSCRIPT with its plan reply's text swapped. */
function withPlanReply(text: string): ThreadMessage[] {
  return [...PLAN_TRANSCRIPT.slice(0, -1), reply('t3-answer', 6, text)]
}

const planCard = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-handoff-card="plan"]')

const button = (card: HTMLElement, name: string) => within(card).getByRole('button', { name }) as HTMLButtonElement

beforeEach(() => {
  localStorage.clear()
  resetMainThreadForTest()
  resetHandoffsForTest()
  resetHandoffPlansForTest()
  $planUsage.set(null)
  openBot.mockClear()
})

afterEach(() => {
  cleanup()
  resetHandoffsForTest()
  resetHandoffPlansForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  $planUsage.set(null)
  $activeGatewayProfile.set('default')
  $selectedStoredSessionId.set(null)
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
  localStorage.clear()
})

afterAll(restoreRecordingTimeZone)

describe('proposed (⑬, before 「开始」)', () => {
  it('lists each baton — who, what, 已有 or one more turn — the usage line for all the turns, 「开始」 and 「改一下」', async () => {
    relayOn()
    $planUsage.set({ accountId: 'acc-1', usage: { period: 'month', planName: '快速', usedRatio: 0.18 } })

    const card = planCard(await renderTranscript(PLAN_TRANSCRIPT))!
    const steps = [...card.querySelectorAll('[data-handoff-plan-step]')].map(row => row.textContent)

    expect(card.getAttribute('data-handoff-plan-status')).toBe('proposed')
    expect(within(card).getByText('接力 · 3 棒')).toBeTruthy()
    expect(steps).toEqual([
      '✓APEX 定选题：租房党衣柜改造，不打孔已有',
      '2小红书文案 写标题和文案等开始多跑 1 个回合',
      '3剪辑助手 剪成 30 秒竖屏等开始多跑 1 个回合'
    ])
    expect(card.querySelector('[data-handoff-usage]')?.textContent).toBe(
      '要多跑 2 个回合，按你的套餐额度算 · 本月已用 18%'
    )
    expect(button(card, '开始').disabled).toBe(false)
    expect(button(card, '改一下')).toBeTruthy()
  })

  it('「开始」 queues the first baton with the reply (without its blocks) and the card follows the plan', async () => {
    relayOn()

    const container = await renderTranscript(PLAN_TRANSCRIPT)

    await act(async () => {
      fireEvent.click(button(planCard(container)!, '开始'))
    })

    const [started] = $handoffPlans.get()
    const first = handoffById(started!.batons[0]!)!

    expect(started).toMatchObject({ key: KEY, status: 'running', steps: STEPS })
    expect(first).toMatchObject({ ask: '按这个选题写 3 个标题和一段 200 字文案', status: 'queued', to: 'writer' })
    expect(first.carry.text).toBe(
      '选题还是**租房党衣柜改造，不打孔**：前后对比，不打孔、押金保住。\n\n可以，我排了一个接力。你点开始，中途要你拍板我会停下来问你。'
    )
    expect(first.carry.text).not.toContain('apex:')
    expect(planCard(container)!.getAttribute('data-handoff-plan-status')).toBe('running')
    // The plan card stands for its batons: no relay card of their own (hc-1087's slots).
    expect(container.querySelector('[data-handoff-card="relay"]')).toBeNull()
  })

  it('「改一下」 puts a start in the composer and sends nothing', async () => {
    relayOn()

    const inserted: string[] = []
    const off = onComposerInsertRequest(({ text }) => inserted.push(text))
    const container = await renderTranscript(PLAN_TRANSCRIPT)

    await act(async () => {
      fireEvent.click(button(planCard(container)!, '改一下'))
      // The composer bus delivers on the next tick.
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    off()

    expect(inserted).toEqual(['接力计划改一下：'])
    expect($handoffs.get()).toEqual([])
  })

  it('is gone once the conversation moved on and it was never started', async () => {
    relayOn()

    const container = await renderTranscript([
      ...PLAN_TRANSCRIPT,
      ask('t4-ask', 9, '先不了'),
      reply('t4-answer', 10, '好。')
    ])

    expect(planCard(container)).toBeNull()
  })

  it.each([
    [
      'more than 3 batons',
      PLAN_REPLY.replace('-->', '@小红书文案 | 写口播 | 写一段口播\n-->'),
      '一次接力最多 3 棒，这个排了 4 棒。让APEX拆短一点再开始。'
    ],
    [
      'a name not on the roster',
      PLAN_REPLY.replace('@剪辑助手', '@剪映'),
      '你的助手里没有「剪映」，这一棒交不出去。让APEX改一下。'
    ],
    ['the planner itself', PLAN_REPLY.replace('@剪辑助手', '@APEX'), 'APEX不能把一棒交给自己。让APEX改一下。']
  ])('cannot start as written, and says why: %s', async (_label, text, why) => {
    relayOn()

    const card = planCard(await renderTranscript(withPlanReply(text)))!

    expect(within(card).queryByRole('button', { name: '开始' })).toBeNull()
    expect(within(card).getByRole('alert').textContent).toBe(why)
    expect(button(card, '改一下')).toBeTruthy()
  })

  it('holds 「开始」 back while another plan runs, and says so', async () => {
    relayOn()
    resetHandoffsForTest([baton('other', { to: 'cutter' })])
    resetHandoffPlansForTest([plan({ batons: ['other'], id: 'pl_other', key: 'default:another' })])

    const card = planCard(await renderTranscript(PLAN_TRANSCRIPT))!

    expect(button(card, '开始').disabled).toBe(true)
    expect(within(card).getByRole('alert').textContent).toBe('已经有一个接力在跑，等它做完再开始。')
  })

  it('holds 「开始」 back when the allowance is used up, in R5’s words (L6)', async () => {
    relayOn()
    $planUsage.set({ accountId: 'acc-1', usage: { period: 'month', planName: '快速', usedRatio: 1 } })

    const card = planCard(await renderTranscript(PLAN_TRANSCRIPT))!

    expect(button(card, '开始').disabled).toBe(true)
    expect(within(card).getByRole('alert').textContent).toContain('本月额度已经用完')
  })

  it('says why when the relay refuses the first baton (the planner is on another assistant’s job)', async () => {
    relayOn()
    resetHandoffsForTest([baton('incoming', { from: { ...baton('x').from, profile: 'writer' }, to: 'default' })])

    const container = await renderTranscript(PLAN_TRANSCRIPT)

    await act(async () => {
      fireEvent.click(button(planCard(container)!, '开始'))
    })

    expect($handoffPlans.get()).toEqual([])
    expect(within(planCard(container)!).getByRole('alert').textContent).toBe(
      'APEX正在帮别的助手做事，接手的不能再往外交。'
    )
  })
})

describe('started', () => {
  it.each([
    [
      'the first relay baton running',
      [baton('b1')],
      plan(),
      { chip: '进行中', steps: ['已有', '在做', '等上一棒'], buttons: ['看它在做什么', '停下', '剩下的不做了'] }
    ],
    [
      'waiting on the user: jump to the receiver to answer',
      [
        baton('b1', {
          status: 'waiting',
          waitingFor: { kind: 'clarify', question: '用 9:16 还是 3:4？', requestId: 'q' }
        })
      ],
      plan(),
      {
        chip: '在等你决定',
        steps: ['已有', '在等你决定', '等上一棒'],
        buttons: ['去回答', '停下', '剩下的不做了'],
        text: '小红书文案在等你决定：用 9:16 还是 3:4？'
      }
    ],
    [
      'the second baton queued behind the receiver’s own turn',
      [
        baton('b1', { result: returnedResult('3 个标题'), status: 'returned' }),
        baton('b2', { queueReason: 'receiver_busy', status: 'queued', to: 'cutter' })
      ],
      plan({ batons: ['b1', 'b2'] }),
      {
        chip: '进行中',
        steps: ['已有', '交回了', '排第 1'],
        buttons: ['看它在做什么', '停下'],
        text: '剪辑助手手上还有一个活，做完马上接，不打断它。'
      }
    ],
    [
      'held at a failed baton',
      [baton('b1', { failure: { kind: 'interrupted', message: '' }, status: 'failed' })],
      plan(),
      {
        chip: '停在第 2 棒',
        steps: ['已有', '被打断', '等上一棒'],
        buttons: ['再试一次', '剩下的不做了'],
        text: '被打断了：App 关掉时它还没做完。'
      }
    ],
    [
      'held before the next baton: the allowance is used up',
      [baton('b1', { result: returnedResult('3 个标题'), status: 'returned' })],
      plan({ hold: { kind: 'used_up', reason: '本月额度已经用完。' } }),
      {
        chip: '停在第 3 棒',
        steps: ['已有', '交回了', '等上一棒'],
        buttons: ['再试一次', '剩下的不做了'],
        text: '本月额度已经用完。'
      }
    ],
    [
      'the planner is on another assistant’s job: the next baton waits by itself',
      [baton('b1', { result: returnedResult('3 个标题'), status: 'returned' })],
      plan({ hold: { kind: 'nested' } }),
      {
        chip: '进行中',
        steps: ['已有', '交回了', '等上一棒'],
        buttons: ['停下'],
        text: 'APEX手上正接着别的助手交来的活，做完就接着跑下一棒。'
      }
    ],
    [
      'done: the last baton’s result and the turns it took',
      [
        baton('b1', { result: returnedResult('3 个标题'), status: 'returned' }),
        baton('b2', { result: returnedResult('成片做好了：30 秒竖屏'), status: 'returned', to: 'cutter' })
      ],
      plan({ batons: ['b1', 'b2'], finishedAt: STARTED_AT + 370_000, status: 'done' }),
      {
        chip: '做完了 · 用时 6 分 10 秒',
        steps: ['已有', '交回了', '交回了'],
        buttons: ['打开剪辑助手的对话'],
        text: '一共多跑了 2 个回合。每一棒的过程在各自的对话里。'
      }
    ],
    [
      'stopped',
      [baton('b1', { status: 'stopped' })],
      plan({ end: 'stopped', finishedAt: STARTED_AT + 1000, status: 'ended' }),
      { chip: '停了', steps: ['已有', '已停下', '没跑'], buttons: [], text: '你在第 2 棒停下了，后面的没跑。' }
    ],
    [
      'the receiver was deleted (K9)',
      [baton('b1', { cancelReason: 'receiver_deleted', status: 'cancelled' })],
      plan({ cancelReason: 'receiver_deleted', end: 'baton_cancelled', status: 'ended' }),
      { chip: '停了', steps: ['已有', '已取消', '没跑'], buttons: [], text: '「小红书文案」已删除，这次接力取消了。' }
    ]
  ])('%s', async (_label, records, record, expected) => {
    relayOn()
    resetHandoffsForTest(records)
    resetHandoffPlansForTest([record])

    const container = await renderTranscript(PLAN_TRANSCRIPT)
    const card = planCard(container)!

    const chips = [...card.querySelectorAll('[data-handoff-plan-step] [data-handoff-chip]')].map(
      chip => chip.textContent
    )

    const head = card.querySelector('[data-handoff-chip]')?.textContent

    const buttons = within(card)
      .queryAllByRole('button')
      .map(node => node.textContent)
      .filter(name => name !== '全屏看')

    expect(head).toBe(expected.chip)
    expect(chips).toEqual(expected.steps)
    expect(buttons).toEqual(expected.buttons)

    if (expected.text) {
      expect(card.textContent).toContain(expected.text)
    }

    // A started plan stays under its reply: no relay card of its own for any baton.
    expect(container.querySelector('[data-handoff-card="relay"]')).toBeNull()
  })

  it('stays under its reply after the conversation moved on', async () => {
    relayOn()
    resetHandoffsForTest([baton('b1')])
    resetHandoffPlansForTest([plan()])

    const container = await renderTranscript([
      ...PLAN_TRANSCRIPT,
      ask('t4-ask', 9, '顺便问一下'),
      reply('t4-answer', 10, '好。')
    ])

    expect(planCard(container)?.getAttribute('data-handoff-plan-status')).toBe('running')
  })

  it('「停下」 and 「去回答」 act on the baton on its way', async () => {
    relayOn()
    resetHandoffsForTest([
      baton('b1', { status: 'waiting', waitingFor: { kind: 'approval', question: '删掉旧草稿？', requestId: 'a' } })
    ])
    resetHandoffPlansForTest([plan()])

    const container = await renderTranscript(PLAN_TRANSCRIPT)

    fireEvent.click(button(planCard(container)!, '去回答'))
    expect(openBot).toHaveBeenCalledWith('writer')

    await act(async () => {
      fireEvent.click(button(planCard(container)!, '停下'))
    })

    expect(handoffById('b1')?.status).toBe('stopped')
    expect($handoffPlans.get()[0]).toMatchObject({ end: 'stopped', status: 'ended' })
  })

  it('「再试一次」 reads the usage line first: used up, the baton stays and the card says why', async () => {
    relayOn()
    $planUsage.set({ accountId: 'acc-1', usage: { period: 'month', planName: '快速', usedRatio: 1 } })
    resetHandoffsForTest([baton('b1', { failure: { kind: 'turn_error', message: '' }, status: 'failed' })])
    resetHandoffPlansForTest([plan()])

    const container = await renderTranscript(PLAN_TRANSCRIPT)

    await act(async () => {
      fireEvent.click(button(planCard(container)!, '再试一次'))
    })

    expect(handoffById('b1')?.status).toBe('failed')
    expect(within(planCard(container)!).getByRole('alert').textContent).toContain('本月额度已经用完')
  })
})

describe('only in the assistant’s own thread with relay on', () => {
  it.each([
    ['developer mode', () => setToolViewMode('technical')],
    ['the relay switch off', () => setMultiBotHandoffFlagForTest(false)],
    ['an earlier conversation', () => $selectedStoredSessionId.set('older')]
  ])('%s: no card', async (_label, turnOff) => {
    relayOn()
    turnOff()

    expect(planCard(await renderTranscript(PLAN_TRANSCRIPT))).toBeNull()
  })
})
