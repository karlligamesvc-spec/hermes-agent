/**
 * hc-1087 (多助手二期 R2): the relay screens as rendered — the sender's cards
 * in each state and what their buttons do, the confirm card, the receiver's
 * 「X 交来的活」 and 「已交回」, the empty thread, and our `@` list. They read
 * hc-1086's records and call its actions; nothing here dispatches a turn.
 */
// First: the recording time zone (the shell harness's fixtures are wall-clock times).
import '@/__identity__/single-thread-shell/time-zone'

import type { Unstable_TriggerItem } from '@assistant-ui/core'
import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderSidebar, renderTranscript, seedShellState } from '@/__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { COMPOSER_AREAS } from '@/app/chat/composer/contrib'
import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { registry } from '@/contrib/registry'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $mainThread, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
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
import {
  $handoffProposal,
  $handoffReceiverNames,
  dismissHandoffProposal,
  proposeHandoff
} from '@/store/single-thread-handoff-confirm'
import { setToolViewMode } from '@/store/tool-view'

import { SingleThreadEmptyState } from '../thread-empty'

import { ComposerTriggerPopover, HANDOFF_ITEM_PROFILE, useAtCompletions } from './composer-at'
import { resetBotRolesForTest } from './roles'
import { HANDOFF_MENTION_MIDDLEWARE_ID, useHandoffScreens } from './use-handoff-screens'

const { ensureGatewayProfile, ownAt } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined),
  ownAt: { adapter: { own: true }, loading: false }
}))

vi.mock('@/store/profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile
}))

vi.mock('@/app/chat/composer/hooks/use-at-completions', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  useAtCompletions: () => ownAt
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

const at = (minute: number) => new Date(2026, 9, 21, 9, minute)

function user(id: string, minute: number, text: string): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: at(minute),
    id,
    metadata: { custom: {} },
    role: 'user'
  } as ThreadMessage
}

function assistant(id: string, minute: number, text: string): ThreadMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: at(minute),
    id,
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
}

const APEX_THREAD = [
  user('t1-ask', 20, '这周想做收纳，帮我挑个选题'),
  assistant('t1-answer', 21, '挑好了：租房党衣柜改造，不打孔。')
]

function record(id: string, over: Partial<HandoffRecord> = {}): HandoffRecord {
  const t = at(22).getTime()

  return {
    ask: '按这个选题写 3 个标题',
    attempts: 1,
    baton: 1,
    cancelReason: null,
    carry: { files: [], links: [], text: '挑好了：租房党衣柜改造，不打孔。', truncated: false },
    chainId: id,
    createdAt: t,
    failure: null,
    finishedAt: null,
    from: { messageId: 't1-answer', name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
    id,
    notBefore: null,
    owner: 'acc-1',
    queueReason: null,
    result: null,
    startedAt: t,
    status: 'running',
    to: 'writer',
    turn: null,
    updatedAt: t,
    waitingFor: null,
    ...over
  }
}

function relayOn(onScreen = 'default', storedId = 'chat-a'): void {
  seedShellState()
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
  $activeGatewayProfile.set(onScreen)
  $authState.set({ ...$authState.get(), accountId: 'acc-1', status: 'signed-in' })
  noteMainThreadClaimed(onScreen, storedId)
  $selectedStoredSessionId.set(storedId)
}

const card = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-handoff-card="relay"][data-handoff-id="${id}"]`)!

beforeEach(() => {
  localStorage.clear()
  resetMainThreadForTest()
  resetHandoffsForTest()
  resetBotRolesForTest()
  $handoffReceiverNames.set({})
  ensureGatewayProfile.mockClear()
})

afterEach(() => {
  cleanup()
  dismissHandoffProposal()
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  $activeGatewayProfile.set('default')
  $selectedStoredSessionId.set(null)
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
  localStorage.clear()
})

afterAll(restoreRecordingTimeZone)

describe('the sender’s relay card, each state (⑩ ⑫)', () => {
  it.each([
    [
      'queued: 排第 N and why',
      record('q', { queueReason: 'receiver_busy', status: 'queued' }),
      ['排第 1', '小红书文案手上还有一个活，做完马上接，不打断它。', '看它在做什么', '不等了']
    ],
    ['running', record('r'), ['在做', '带过去的：上面这条结果（16 字）和你这句话。', '看它在做什么', '停下']],
    [
      'waiting on the user',
      record('w', {
        status: 'waiting',
        waitingFor: { kind: 'clarify', question: '用 9:16 还是 3:4？', requestId: 'q1' }
      }),
      ['在等你决定', '小红书文案在等你决定：用 9:16 还是 3:4？', '去回答', '停下']
    ],
    [
      'back',
      record('b', {
        finishedAt: at(22).getTime() + 48_000,
        result: { at: 0, files: [], links: [], summary: '3 个标题，第 2 个最短', text: '' },
        status: 'returned'
      }),
      ['交回了 · 用时 48 秒', '3 个标题，第 2 个最短', '打开小红书文案的对话', '不看了']
    ],
    [
      'failed (hc-973’s three ways on)',
      record('f', { failure: { kind: 'turn_error', message: '' }, status: 'failed' }),
      ['没做成', '小红书文案这次没做成。', '重试', '换个办法', '先给我能出的部分']
    ],
    [
      'interrupted (the app quit on Windows)',
      record('i', { failure: { kind: 'interrupted', message: '' }, status: 'failed' }),
      ['被打断', '被打断了：App 关掉时它还没做完。', '重试']
    ],
    [
      'the platform busy, retried by itself',
      record('p', { queueReason: 'platform_busy_retry', status: 'queued' }),
      ['平台忙', '平台忙，稍后自动再试一次。']
    ],
    ['stopped', record('s', { status: 'stopped' }), ['已停下', '你停下了这次接力。', '再试一次']]
  ])('%s', async (_label, relay, words) => {
    relayOn()
    resetHandoffsForTest([relay])

    const container = await renderTranscript(APEX_THREAD)
    const shown = card(container, relay.id)

    expect(shown.getAttribute('data-handoff-status')).toBe(relay.status)
    expect(shown.textContent).toContain('交给 小红书文案')
    expect(shown.textContent).toContain('按这个选题写 3 个标题')

    for (const word of words) {
      expect(shown.textContent).toContain(word)
    }
  })

  it('「X 已删除」: the receiver is off the roster, its name kept from the start (K9)', async () => {
    relayOn()
    $handoffReceiverNames.set({ gone: '带货脚本' })
    resetHandoffsForTest([record('c', { cancelReason: 'receiver_deleted', status: 'cancelled', to: 'gone' })])

    const shown = card(await renderTranscript(APEX_THREAD), 'c')

    expect(shown.textContent).toContain('交给 带货脚本')
    expect(shown.textContent).toContain('已取消')
    expect(shown.textContent).toContain('「带货脚本」已删除，这次接力取消了。')
  })

  it('sits right after the reply it carried', async () => {
    relayOn()
    resetHandoffsForTest([record('r')])

    const container = await renderTranscript([
      ...APEX_THREAD,
      user('t2-ask', 40, '开头怎么拍？'),
      assistant('t2-answer', 41, '先拍塞满的衣柜。')
    ])

    const row = card(container, 'r').closest('[data-slot="aui_message-group"]')!

    expect(row.querySelector('[data-message-id="t1-answer"]')).not.toBeNull()
    expect(row.querySelector('[data-message-id="t2-answer"]')).toBeNull()
  })

  it('「停下」, 「再试一次」, 「不看了」 and the jumps go through hc-1086 and openBot (K7: no active-profile write)', async () => {
    relayOn()
    resetHandoffsForTest([
      record('r'),
      record('w', { status: 'waiting', to: 'cutter', waitingFor: { kind: 'approval', question: '', requestId: 'a' } }),
      record('s', { status: 'stopped' }),
      record('b', { result: { at: 0, files: [], links: [], summary: 'ok', text: '' }, status: 'returned' })
    ])

    const container = await renderTranscript(APEX_THREAD)

    await act(async () => {
      fireEvent.click(within(card(container, 'r')).getByRole('button', { name: '停下' }))
    })
    expect(handoffById('r')?.status).toBe('stopped')

    await act(async () => {
      fireEvent.click(within(card(container, 's')).getByRole('button', { name: '再试一次' }))
    })
    expect(handoffById('s')?.status).toBe('queued')

    await act(async () => {
      fireEvent.click(within(card(container, 'w')).getByRole('button', { name: '去回答' }))
    })
    expect(ensureGatewayProfile).toHaveBeenLastCalledWith('cutter')

    await act(async () => {
      fireEvent.click(within(card(container, 'b')).getByRole('button', { name: '打开小红书文案的对话' }))
    })
    expect(ensureGatewayProfile).toHaveBeenLastCalledWith('writer')

    fireEvent.click(within(card(container, 'b')).getByRole('button', { name: '不看了' }))
    expect(handoffById('b')).toBeNull()
  })

  it('a failed relay: 「重试」 runs it again; 「换个办法」 asks the same receiver through the confirm card', async () => {
    relayOn()
    resetHandoffsForTest([record('f', { failure: { kind: 'turn_error', message: '' }, status: 'failed' })])

    const container = await renderTranscript(APEX_THREAD)

    fireEvent.click(within(card(container, 'f')).getByRole('button', { name: '换个办法' }))
    expect($handoffProposal.get()?.input).toMatchObject({
      ask: '「按这个选题写 3 个标题」这一步没成功，换个办法继续。',
      from: { profile: 'default' },
      to: 'writer'
    })

    await act(async () => {
      fireEvent.click(within(card(container, 'f')).getByRole('button', { name: '重试' }))
    })
    expect(handoffById('f')?.status).toBe('queued')
  })
})

describe('the confirm card (L2, L6)', () => {
  it('says whom, what and what goes along, then 「交给它」 queues the relay', async () => {
    relayOn()
    proposeHandoff({
      ask: '按这个选题写 3 个标题',
      from: { messageId: 't1-answer', profile: 'default', storedSessionId: 'chat-a' },
      previous: {
        files: ['/Users/me/Movies/收纳素材'],
        links: ['https://www.xiaohongshu.com/explore/a'],
        text: '挑好了：租房党衣柜改造，不打孔。'
      },
      to: 'writer'
    })

    const container = await renderTranscript(APEX_THREAD)
    const shown = container.querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

    expect(shown.textContent).toContain('交给 小红书文案？')
    expect(shown.textContent).toContain('要它做按这个选题写 3 个标题')
    expect(shown.textContent).toContain('会带上：上面那条结果（16 字）、1 个文件、1 个链接和你这句话。')
    expect(shown.textContent).toContain('收纳素材')
    expect(shown.textContent).toContain('www.xiaohongshu.com')
    expect(shown.querySelector('[data-handoff-usage]')?.textContent).toBe('要多跑 1 个回合，按你的套餐额度算')
    expect(
      shown.closest('[data-slot="aui_message-group"]')?.querySelector('[data-message-id="t1-answer"]')
    ).not.toBeNull()

    fireEvent.click(within(shown).getByRole('button', { name: '交给它' }))

    expect($handoffs.get()).toHaveLength(1)
    expect(container.querySelector('[data-handoff-card="confirm"]')).toBeNull()
    expect(container.querySelector('[data-handoff-card="relay"]')).not.toBeNull()
  })

  it('waits for the first sign-in check: 「交给它」 cannot start a relay of nobody’s yet', async () => {
    relayOn()
    $authState.set({ ...$authState.get(), accountId: undefined, status: 'checking' })
    proposeHandoff({
      ask: '写标题',
      from: { messageId: null, profile: 'default', storedSessionId: 'chat-a' },
      to: 'writer'
    })

    const shown = (await renderTranscript(APEX_THREAD)).querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

    expect((within(shown).getByRole('button', { name: '交给它' }) as HTMLButtonElement).disabled).toBe(true)
    expect(shown.textContent).toContain('还在确认你登录的账号，稍等一下再交。')
  })

  it('says the usage line and its reminder; a used-up allowance holds the relay back and says why (R5)', async () => {
    relayOn()
    $planUsage.set({ accountId: 'acc-1', usage: { period: 'month', planName: '快速', usedRatio: 0.85 } })
    proposeHandoff({
      ask: '写标题',
      from: { messageId: null, profile: 'default', storedSessionId: 'chat-a' },
      to: 'writer'
    })

    let shown = (await renderTranscript(APEX_THREAD)).querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

    expect(shown.querySelector('[data-handoff-usage]')?.textContent).toBe(
      '要多跑 1 个回合，按你的套餐额度算 · 本月已用 85%'
    )
    expect(shown.querySelector('[data-handoff-usage-warning]')).not.toBeNull()
    expect(shown.querySelector('[data-handoff-usage]')?.getAttribute('data-handoff-usage')).toBe('warn')
    cleanup()

    $planUsage.set({ accountId: 'acc-1', usage: { period: 'month', planName: '快速', usedRatio: 1 } })
    shown = (await renderTranscript(APEX_THREAD)).querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

    expect((within(shown).getByRole('button', { name: '交给它' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(shown).getByRole('alert').textContent).toContain('本月额度已经用完')
    $planUsage.set(null)
  })

  it('「再试一次」 reads the usage first: used up, the relay stays where it is and says why', async () => {
    relayOn()
    $planUsage.set({ accountId: 'acc-1', usage: { period: 'month', planName: '快速', usedRatio: 1 } })
    resetHandoffsForTest([record('s', { status: 'stopped' })])

    const container = await renderTranscript(APEX_THREAD)

    await act(async () => {
      fireEvent.click(within(card(container, 's')).getByRole('button', { name: '再试一次' }))
    })

    expect(handoffById('s')?.status).toBe('stopped')
    expect(within(card(container, 's')).getByRole('alert').textContent).toContain('本月额度已经用完')
    $planUsage.set(null)
  })

  it('cannot start without a sentence, and says so', async () => {
    relayOn()
    proposeHandoff({
      ask: '  ',
      from: { messageId: null, profile: 'default', storedSessionId: 'chat-a' },
      to: 'writer'
    })

    const shown = (await renderTranscript(APEX_THREAD)).querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

    expect((within(shown).getByRole('button', { name: '交给它' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(shown).getByRole('alert').textContent).toBe('先说要它做什么。')
  })

  it('「先不」 takes it down and starts nothing', async () => {
    relayOn()
    proposeHandoff({
      ask: '写标题',
      from: { messageId: null, profile: 'default', storedSessionId: 'chat-a' },
      to: 'writer'
    })

    const container = await renderTranscript(APEX_THREAD)

    fireEvent.click(
      within(container.querySelector<HTMLElement>('[data-handoff-card="confirm"]')!).getByRole('button', {
        name: '先不'
      })
    )

    expect(container.querySelector('[data-handoff-card="confirm"]')).toBeNull()
    expect($handoffs.get()).toEqual([])
  })
})

describe('the receiver’s side (⑪)', () => {
  const HANDOVER =
    '<!-- apex:handoff v=1 id=ho_1 from=default -->\n【APEX 交来的活】\n\n要你做：\n> 按这个选题写 3 个标题\n\nAPEX 上一条结果：\n> 挑好了：租房党衣柜改造，不打孔。\n\n来源：APEX 的对话'

  const WRITER_THREAD = [
    user('w1', 30, HANDOVER),
    assistant('w1a', 31, '写好了：\n\n1. 不打孔，衣柜多出一半空间\n\n<!-- apex:handback\n3 个标题\n-->')
  ]

  it('the hand-over reads as 「APEX 交来的活」 with its source a click away; 「已交回」 under the reply; a queued one at the end', async () => {
    relayOn('writer', 'writer-root')
    resetHandoffsForTest([
      record('ho_1', {
        result: { at: at(31).getTime(), files: [], links: [], summary: '3 个标题', text: '' },
        status: 'returned'
      }),
      record('ho_2', {
        ask: '再写一版封面文案',
        from: { messageId: null, name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
        status: 'queued'
      })
    ])

    const container = await renderTranscript(WRITER_THREAD)
    const received = container.querySelector<HTMLElement>('[data-handoff-card="received"]')!

    expect(received.textContent).toContain('APEX 交来的活')
    expect(received.textContent).toContain('按这个选题写 3 个标题')
    expect(received.textContent).toContain('APEX 上一条结果')
    expect(received.textContent).toContain('从 APEX 的对话带过来的 · 做完会自动交回去')
    expect(container.textContent).not.toContain('apex:handoff')
    expect(container.textContent).not.toContain('apex:handback')
    expect(container.querySelector('[data-handoff-handed-back]')?.textContent).toBe('已交回 APEX · 09:31')
    expect(container.querySelector('[data-handoff-card="incoming"]')?.textContent).toContain('排第 1')

    fireEvent.click(within(received).getByRole('button', { name: '回到 APEX' }))
    expect(ensureGatewayProfile).toHaveBeenLastCalledWith('default')
  })

  it('with relay off the same message is the usual bubble, its header taken out', async () => {
    relayOn('writer', 'writer-root')
    setMultiBotHandoffFlagForTest(false)

    const container = await renderTranscript(WRITER_THREAD)

    expect(container.querySelector('[data-handoff-card]')).toBeNull()
    expect(container.querySelector('[data-message-id="w1"] [data-slot="aui_user-message-text"]')?.textContent).toMatch(
      /^【APEX 交来的活】/
    )
    expect(container.textContent).not.toContain('apex:')
  })
})

describe('the empty thread', () => {
  it('shows the relay a first message started', () => {
    relayOn()
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })
    $selectedStoredSessionId.set(null)
    resetHandoffsForTest([
      record('r', { from: { messageId: null, name: 'APEX', profile: 'default', storedSessionId: null } })
    ])

    const view = render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <SingleThreadEmptyState />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(view.container.querySelector('[data-handoff-card="relay"]')?.textContent).toContain('交给 小红书文案')
  })
})

describe('our @ list (L10)', () => {
  const item = (profile: string, name: string, role: string): Unstable_TriggerItem => ({
    description: role,
    id: `handoff:${profile}`,
    label: name,
    metadata: {
      display: name,
      [HANDOFF_ITEM_PROFILE]: profile,
      icon: 'simple',
      insertId: '',
      meta: role,
      rawText: `@${name}`
    },
    type: 'simple'
  })

  const ITEMS = [item('writer', '小红书文案', '写标题和文案'), item('cutter', '剪辑助手', '剪辑出片')]

  function renderList() {
    return render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ComposerTriggerPopover
          activeIndex={0}
          items={ITEMS}
          kind="@"
          loading={false}
          onHover={() => {}}
          onPick={() => {}}
        />
      </I18nProvider>
    )
  }

  it('lists the other assistants and what each handles, under 「交给哪个助手」', () => {
    relayOn()

    const list = renderList().container.querySelector<HTMLElement>('[data-handoff-picker]')!

    expect(list.textContent).toContain('交给哪个助手')
    expect([...list.querySelectorAll('[data-handoff-profile]')].map(row => row.textContent)).toEqual([
      '小红书文案写标题和文案',
      '剪辑助手剪辑出片'
    ])
    expect(list.textContent).toContain('交过去会带上：上面那条结果和你这句话')
  })

  it('says the assistant on screen cannot hand on while it works on a relay (L3)', () => {
    relayOn('writer', 'writer-root')
    resetHandoffsForTest([record('r')])

    const list = renderList().container.querySelector<HTMLElement>('[data-handoff-picker]')!

    expect(list.querySelector('[data-handoff-profile]')).toBeNull()
    expect(list.textContent).toContain('小红书文案正在帮APEX做事，接手的不能再往外交')
  })

  it('is the composer’s own list and source with relay off', () => {
    relayOn()
    setMultiBotHandoffFlagForTest(false)

    expect(renderList().container.querySelector('[data-handoff-picker]')).toBeNull()
    expect(renderHook(() => useAtCompletions({ cwd: null, gateway: null, sessionId: null })).result.current).toBe(ownAt)
  })

  it('swaps in its own source with relay on', () => {
    relayOn()

    expect(renderHook(() => useAtCompletions({ cwd: null, gateway: null, sessionId: null })).result.current).not.toBe(
      ownAt
    )
  })
})

describe('the sidebar line', () => {
  const status = (container: HTMLElement, profile: string) =>
    container.querySelector(`[data-single-thread-bot="${profile}"] [data-single-thread-status]`)?.textContent ?? null

  it('the receiver 「在帮 APEX：…」, the sender 「等小红书文案交回」', () => {
    relayOn()
    resetHandoffsForTest([record('r')])

    const { container } = renderSidebar('/chat-a', 'chat')

    expect(status(container, 'writer')).toBe('在帮 APEX：按这个选题写 3 个标题')
    expect(status(container, 'default')).toBe('等小红书文案交回')
  })

  it('says nothing of a relay with relay off (records stay on this install)', () => {
    relayOn()
    setMultiBotHandoffFlagForTest(false)
    resetHandoffsForTest([record('r')])

    const { container } = renderSidebar('/chat-a', 'chat')

    expect(container.textContent).not.toContain('在帮')
    expect(container.textContent).not.toContain('交回')
  })
})

describe('the shell part', () => {
  const registered = () =>
    registry.getArea(COMPOSER_AREAS.middleware).find(contribution => contribution.id === HANDOFF_MENTION_MIDDLEWARE_ID)

  it('registers the @ middleware ahead of the single-thread one only while relay is on', () => {
    relayOn()

    const view = renderHook(({ multiBot }) => useHandoffScreens(multiBot), { initialProps: { multiBot: true } })

    expect(registered()?.order).toBeLessThan(-100)

    act(() => setMultiBotHandoffFlagForTest(false))
    expect(registered()).toBeUndefined()

    act(() => setMultiBotHandoffFlagForTest(true))
    view.rerender({ multiBot: false })
    expect(registered()).toBeUndefined()
    view.unmount()
  })
})
