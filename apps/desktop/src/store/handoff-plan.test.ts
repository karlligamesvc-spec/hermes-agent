/**
 * hc-1091 (多助手二期 R6): the relay plan (一条龙接力) — starting it, the
 * driver that runs each next baton as a plain hc-1086 relay, the holds (the
 * user's decision, a failure, a used-up allowance, the planner on a relay),
 * 「停下」 / 「剩下的不做了」 / 「再试一次」, K9 and accounts, and which card a
 * plan belongs to. The relay turns themselves are hc-1086's runner and are not
 * run here: a baton's result is written the way the runner writes it.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HandoffUsageHint } from '@/i18n/handoff-usage'

import { $authState } from './auth'
import {
  $handoffPlanBatonIds,
  $handoffPlans,
  cancelRestOfPlan,
  handoffPlanById,
  handoffPlanKey,
  type HandoffPlanRecord,
  type HandoffPlanStep,
  planForCard,
  reconcileHandoffPlans,
  resetHandoffPlansForTest,
  retryHandoffPlan,
  startHandoffPlan,
  type StartHandoffPlanInput,
  stopHandoffPlan,
  useHandoffPlanDriver
} from './handoff-plan'
import { setSingleThreadFlagForTest } from './single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from './single-thread-bots'
import {
  $handoffs,
  cancelHandoffsForProfile,
  handoffById,
  type HandoffRecord,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest,
  startHandoff,
  updateHandoff
} from './single-thread-handoff'
import { setToolViewMode } from './tool-view'

const usage = vi.hoisted(() => ({ hint: null as HandoffUsageHint | null, reads: 0 }))

vi.mock('./handoff-usage', () => ({
  checkHandoffUsage: vi.fn(async (_turns: number) => {
    usage.reads += 1

    return usage.hint
  })
}))

const SIGNED_OUT_AUTH = $authState.get()

const ROSTER = botRosterFrom(
  [
    { is_default: true, name: 'default' },
    { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } },
    { name: 'cutter', ui_meta: { apex: { created: 2, name: '剪辑助手' } } },
    { name: 'scripts', ui_meta: { apex: { created: 3, name: '带货脚本' } } }
  ],
  () => true
)

const FROM_APEX = { messageId: 'm-plan', profile: 'default', storedSessionId: 'apex-root' }

const STEPS: HandoffPlanStep[] = [
  { kind: 'have', label: '定选题：租房党衣柜改造' },
  {
    ask: '按这个选题写 3 个标题和一段 200 字文案',
    kind: 'relay',
    label: '写标题和文案',
    name: '小红书文案',
    to: 'writer'
  },
  {
    ask: '用小红书文案交回的标题和文案剪成 30 秒竖屏',
    kind: 'relay',
    label: '剪成竖屏',
    name: '剪辑助手',
    to: 'cutter'
  }
]

const OK_HINT: HandoffUsageHint = { level: 'ok', line: '要多跑 1 个回合', reason: null, start: true, warning: null }

const USED_UP: HandoffUsageHint = {
  level: 'used_up',
  line: '…',
  reason: '本月额度已经用完。',
  start: false,
  warning: null
}

function input(patch: Partial<StartHandoffPlanInput> = {}): StartHandoffPlanInput {
  return {
    from: FROM_APEX,
    key: handoffPlanKey('default', STEPS),
    previous: { files: ['/Users/me/a.png'], text: '选题定了：租房党衣柜改造，不打孔。' },
    steps: STEPS,
    ...patch
  }
}

function started(patch: Partial<StartHandoffPlanInput> = {}): HandoffPlanRecord {
  const result = startHandoffPlan(input(patch))

  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`)
  }

  return result.plan
}

/** What hc-1086's runner writes when a baton's turn comes back. */
function returned(id: string, text: string): HandoffRecord {
  return updateHandoff(id, {
    finishedAt: Date.now(),
    result: { at: Date.now(), files: ['/Users/me/out.mp4'], links: [], summary: text, text },
    status: 'returned'
  })!
}

const plan = (id: string) => handoffPlanById(id)!

const flush = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })

function on(): void {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  $authState.set({ ...$authState.get(), accountId: 'acct-1', status: 'signed-in' })
  resetBotRosterForTest(ROSTER)
}

/** The shell's driver, as use-multi-bot-shell.ts mounts it. */
function drive() {
  return renderHook(() => useHandoffPlanDriver())
}

beforeEach(() => {
  localStorage.clear()
  resetHandoffsForTest()
  resetHandoffPlansForTest()
  usage.hint = OK_HINT
  usage.reads = 0
  on()
})

afterEach(() => {
  $authState.set(SIGNED_OUT_AUTH)
  resetHandoffsForTest()
  resetHandoffPlansForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  localStorage.clear()
})

describe('「开始」', () => {
  it('queues the first baton as a relay from the planner, carrying the reply the plan came in', () => {
    const p = started()
    const first = handoffById(p.batons[0]!)!

    expect(p).toMatchObject({ batons: [first.id], owner: 'acct-1', status: 'running', steps: STEPS })
    expect(first).toMatchObject({
      ask: '按这个选题写 3 个标题和一段 200 字文案',
      baton: 1,
      carry: { files: ['/Users/me/a.png'], text: '选题定了：租房党衣柜改造，不打孔。' },
      from: { name: 'APEX', profile: 'default', storedSessionId: 'apex-root' },
      status: 'queued',
      to: 'writer'
    })
    expect($handoffPlanBatonIds.get().has(first.id)).toBe(true)
  })

  it.each([
    ['several assistants off', () => setMultiBotFlagForTest(false)],
    ['developer mode', () => setToolViewMode('technical')],
    ['the relay switch off', () => setMultiBotHandoffFlagForTest(false)],
    ['the account not known yet', () => $authState.set({ ...$authState.get(), accountId: undefined })]
  ])('is refused and writes nothing: %s', (_label, turnOff) => {
    turnOff()
    localStorage.clear()

    expect(startHandoffPlan(input())).toEqual({ ok: false, reason: 'off' })
    expect($handoffs.get()).toEqual([])
    expect($handoffPlans.get()).toEqual([])
    expect(localStorage.length).toBe(0)
  })

  it.each([
    ['no relay', [STEPS[0]!]],
    ['more batons than a plan may have', [...STEPS, { ...(STEPS[1] as HandoffPlanStep), label: '再写一版' }]]
  ])('is refused as written: %s', (_label, steps) => {
    expect(startHandoffPlan(input({ steps }))).toEqual({ ok: false, reason: 'invalid' })
    expect($handoffs.get()).toEqual([])
  })

  it('runs one plan at a time', () => {
    started()

    expect(startHandoffPlan(input({ key: 'other' }))).toEqual({ ok: false, reason: 'plan_running' })
    expect($handoffs.get()).toHaveLength(1)
  })

  it('is refused while the planner is itself working on a relay (接手的不能再往外交)', () => {
    startHandoff({ ask: '帮 APEX 看一下', from: { ...FROM_APEX, profile: 'writer' }, to: 'default' })

    expect(startHandoffPlan(input())).toEqual({ ok: false, reason: 'nested' })
    expect($handoffPlans.get()).toEqual([])
  })
})

describe('the driver: baton by baton, each one the next one’s input', () => {
  it('starts the next baton from the one that came back, after reading the usage line, until the last is done', async () => {
    drive()
    const p = started()

    returned(p.batons[0]!, '3 个标题：①不打孔也能多一半空间 ②…；文案 200 字')
    await flush()

    const second = handoffById(plan(p.id).batons[1]!)!

    expect(usage.reads).toBe(1)
    expect(second).toMatchObject({
      ask: '用小红书文案交回的标题和文案剪成 30 秒竖屏',
      baton: 2,
      carry: { files: ['/Users/me/out.mp4'], text: '3 个标题：①不打孔也能多一半空间 ②…；文案 200 字' },
      chainId: p.batons[0],
      from: { profile: 'default' },
      to: 'cutter'
    })

    returned(second.id, '成片做好了')
    await flush()

    expect(plan(p.id)).toMatchObject({ end: null, status: 'done' })
    expect(plan(p.id).finishedAt).not.toBeNull()
    expect($handoffs.get()).toHaveLength(2)
  })

  it('holds at a baton that waits on the user and goes on once it is answered', async () => {
    drive()
    const p = started()

    updateHandoff(p.batons[0]!, {
      status: 'waiting',
      waitingFor: { kind: 'clarify', question: '用 9:16 还是 3:4？', requestId: 'q1' }
    })
    await flush()

    expect(plan(p.id)).toMatchObject({ batons: [p.batons[0]], hold: null, status: 'running' })

    updateHandoff(p.batons[0]!, { status: 'running', waitingFor: null })
    returned(p.batons[0]!, '标题写好了')
    await flush()

    expect(plan(p.id).batons).toHaveLength(2)
  })

  it('holds a used-up allowance before the next baton, says why, and 「再试一次」 goes on once there is room', async () => {
    drive()
    const p = started()

    usage.hint = USED_UP
    returned(p.batons[0]!, '标题写好了')
    await flush()

    expect(plan(p.id)).toMatchObject({ batons: [p.batons[0]], hold: { kind: 'used_up', reason: '本月额度已经用完。' } })
    expect(await retryHandoffPlan(p.id)).toBe('本月额度已经用完。')
    expect(plan(p.id).batons).toHaveLength(1)

    usage.hint = OK_HINT
    expect(await retryHandoffPlan(p.id)).toBeNull()
    await flush()

    expect(plan(p.id)).toMatchObject({ hold: null })
    expect(plan(p.id).batons).toHaveLength(2)
  })

  it('holds at a failed baton; 「再试一次」 reads the usage line, then runs the same relay again', async () => {
    drive()
    const p = started()

    updateHandoff(p.batons[0]!, {
      failure: { kind: 'turn_error', message: 'x' },
      finishedAt: Date.now(),
      status: 'failed'
    })
    await flush()

    expect(plan(p.id)).toMatchObject({ batons: [p.batons[0]], status: 'running' })

    usage.hint = USED_UP
    expect(await retryHandoffPlan(p.id)).toBe('本月额度已经用完。')
    expect(handoffById(p.batons[0]!)!.status).toBe('failed')

    usage.hint = OK_HINT
    expect(await retryHandoffPlan(p.id)).toBeNull()
    expect(handoffById(p.batons[0]!)!.status).toBe('queued')

    returned(p.batons[0]!, '这次写好了')
    await flush()

    expect(plan(p.id).batons).toHaveLength(2)
  })

  it('waits for the planner’s own relay to come back before the next baton (L3), then goes on by itself', async () => {
    drive()
    const p = started()
    const incoming = startHandoff({ ask: '帮我看一眼', from: { ...FROM_APEX, profile: 'scripts' }, to: 'default' })

    returned(p.batons[0]!, '标题写好了')
    await flush()

    expect(plan(p.id)).toMatchObject({ batons: [p.batons[0]], hold: { kind: 'nested' } })

    returned((incoming as { handoff: HandoffRecord }).handoff.id, '看完了')
    await flush()

    expect(plan(p.id)).toMatchObject({ hold: null })
    expect(plan(p.id).batons).toHaveLength(2)
  })
})

describe('the user’s controls', () => {
  it('「停下」 stops the baton on its way and runs nothing after it', async () => {
    drive()
    const p = started()

    expect(await stopHandoffPlan(p.id)).toBe(true)
    await flush()

    expect(handoffById(p.batons[0]!)!.status).toBe('stopped')
    expect(plan(p.id)).toMatchObject({ end: 'stopped', status: 'ended' })
    expect($handoffs.get()).toHaveLength(1)
  })

  it('「剩下的不做了」 lets the baton on its way finish, then ends', async () => {
    drive()
    const p = started()

    expect(cancelRestOfPlan(p.id)).toBe(true)
    expect(plan(p.id)).toMatchObject({ restCancelled: true, status: 'running' })

    returned(p.batons[0]!, '标题写好了')
    await flush()

    expect(plan(p.id)).toMatchObject({ end: 'rest_cancelled', status: 'ended' })
    expect($handoffs.get()).toHaveLength(1)
    expect(usage.reads).toBe(0)
  })

  it('「剩下的不做了」 on a plan held at a failed baton ends it now', async () => {
    drive()
    const p = started()

    updateHandoff(p.batons[0]!, { failure: { kind: 'interrupted', message: '' }, finishedAt: 1, status: 'failed' })
    cancelRestOfPlan(p.id)

    expect(plan(p.id)).toMatchObject({ end: 'rest_cancelled', status: 'ended' })
  })
})

describe('K9 and accounts', () => {
  it('ends with 「X 已删除」 when the receiver of the baton on its way is deleted', async () => {
    drive()
    const p = started()

    await cancelHandoffsForProfile('writer')
    await flush()

    expect(plan(p.id)).toMatchObject({ cancelReason: 'receiver_deleted', end: 'baton_cancelled', status: 'ended' })
  })

  it('holds and says why when a later baton’s receiver is gone by its turn', async () => {
    drive()
    const p = started()

    resetBotRosterForTest(ROSTER.filter(bot => bot.profile !== 'cutter'))
    returned(p.batons[0]!, '标题写好了')
    await flush()

    expect(plan(p.id)).toMatchObject({ hold: { kind: 'refused', reason: 'unknown_receiver' }, status: 'running' })
  })

  it('drops another account’s plans once the account signed in is known', () => {
    const p = started()

    $authState.set({ ...$authState.get(), accountId: 'acct-2' })
    reconcileHandoffPlans()

    expect(handoffPlanById(p.id)).toBeNull()
  })
})

describe('which card a plan belongs to', () => {
  it('is the card with its key whose reply was written before the plan started; an identical block written later is new', () => {
    const p = started()

    expect(planForCard(p.key, p.createdAt - 60_000)?.id).toBe(p.id)
    expect(planForCard(p.key, null)?.id).toBe(p.id)
    expect(planForCard(p.key, p.createdAt + 60_000)).toBeNull()
    expect(planForCard('default:other', p.createdAt - 60_000)).toBeNull()
  })

  it('names a thread and a block the same way every time (message ids change on reload, these do not)', () => {
    expect(handoffPlanKey('default', STEPS)).toBe(handoffPlanKey('default', JSON.parse(JSON.stringify(STEPS))))
    expect(handoffPlanKey('default', STEPS)).not.toBe(handoffPlanKey('writer', STEPS))
    expect(handoffPlanKey('default', STEPS)).not.toBe(handoffPlanKey('default', STEPS.slice(1)))
  })
})

describe('off', () => {
  it('the driver reads and writes nothing while relay is off: a plan stays where it was and goes on once it is back on', async () => {
    const p = started()

    setMultiBotHandoffFlagForTest(false)
    const { unmount } = drive()

    returned(p.batons[0]!, '标题写好了')
    await flush()

    expect(plan(p.id).batons).toHaveLength(1)
    expect(usage.reads).toBe(0)

    unmount()
    setMultiBotHandoffFlagForTest(true)
    drive()
    await flush()

    expect(plan(p.id).batons).toHaveLength(2)
  })
})
