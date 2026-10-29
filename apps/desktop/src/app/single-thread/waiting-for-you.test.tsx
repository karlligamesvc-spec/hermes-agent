/**
 * hc-1107 「等你确认」: an assistant waiting on the user shows it on its face, in
 * its sidebar row (the words and a lit dot) and at the foot of its
 * conversation — whether it is the one on screen or one in the background —
 * and stops the moment the user answers. The same row also says 「正在回…」
 * while it writes its answer and 「发送失败」 when the send did not go through.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import type { AppView } from '@/app/routes'
import type { ClientSessionState } from '@/app/types'
import { APEX_AVATAR_SHAPES, ApexAvatar } from '@/components/apex-avatar'
import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { SidebarProvider } from '@/components/ui/sidebar'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { relayWaitingChip, relayWaitingNote, SINGLE_THREAD_HANDOFF_COPY } from '@/i18n/single-thread-handoff'
import type { ChatMessage } from '@/lib/chat-messages'
import { $authState } from '@/store/auth'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { $mainThreadsByProfile, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { clearMcpSetupRequest, setMcpSetupRequest } from '@/store/mcp-setup'
import { $activeGatewayProfile } from '@/store/profile'
import {
  clearAllPrompts,
  clearApprovalRequest,
  setApprovalRequest,
  setSecretRequest,
  setSudoRequest,
  setVaultCodeRequest,
  setVaultSaveLoginRequest,
  setVaultUnlockRequest
} from '@/store/prompts'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import {
  $handoffs,
  type HandoffRecord,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest
} from '@/store/single-thread-handoff'
import { $handoffProposal, dismissHandoffProposal } from '@/store/single-thread-handoff-confirm'
import { resetThreadPresenceForTest } from '@/store/single-thread-presence'
import { setToolViewMode } from '@/store/tool-view'
import { $parkedAsks, parkedAsk } from '@/store/waiting-for-you'
import { remixRunningTurn } from '@/test/remix-turn'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const noop = () => {}

const ACTIONS: SidebarActions = {
  onArchiveSession: noop,
  onBranchSession: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onManageCronJob: noop,
  onNavigate: noop,
  onNewSessionInWorkspace: noop,
  onNewSessionSplit: noop,
  onResumeSession: noop,
  onTriggerCronJob: noop
}

let root: HTMLElement

function renderSidebar(view: AppView = 'settings') {
  root = render(
    <MemoryRouter initialEntries={['/apex-root']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={ACTIONS} currentView={view} />
        </SidebarProvider>
      </I18nProvider>
    </MemoryRouter>
  ).container
}

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'scripts', ui_meta: { apex: { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' } } }
]

const say = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
  id,
  parts: [{ text, type: 'text' }],
  role
})

const ASKED = [say('a-0', 'assistant', '挑好了：不打孔。'), say('u-1', 'user', '按这个写 3 个标题')]

function session(storedSessionId: null | string, extra: Partial<ClientSessionState> = {}): ClientSessionState {
  return {
    busy: true,
    messages: ASKED,
    needsInput: false,
    storedSessionId,
    ...extra
  } as unknown as ClientSessionState
}

/** Each blocking prompt the request handlers park, by what it asks. */
const PARK: Record<string, (sessionId: string) => void> = {
  approval: sessionId => setApprovalRequest({ command: 'ffmpeg -i a.mp4 b.mp4', description: 'ffmpeg', sessionId }),
  clarify: sessionId =>
    setClarifyRequest({
      choices: ['竖版', '横版'],
      multiSelect: false,
      question: '竖版还是横版？',
      requestId: `q-${sessionId}`,
      sessionId
    }),
  mcpSetup: sessionId =>
    setMcpSetupRequest({
      action: 'install',
      reason: '连飞书',
      requestId: `m-${sessionId}`,
      server: 'feishu',
      sessionId
    }),
  secret: sessionId =>
    setSecretRequest({ envVar: 'KEY', prompt: '填一下 key', requestId: `s-${sessionId}`, sessionId }),
  sudo: sessionId => setSudoRequest({ requestId: `p-${sessionId}`, sessionId }),
  vaultCode: sessionId => setVaultCodeRequest({ hint: '', requestId: `c-${sessionId}`, sessionId, site: 'a.com' }),
  vaultSaveLogin: sessionId =>
    setVaultSaveLoginRequest({ origin: 'https://a.com', requestId: `l-${sessionId}`, sessionId, site: 'a.com' }),
  vaultUnlock: sessionId =>
    setVaultUnlockRequest({ backend: 'op', displayName: '1Password', requestId: `u-${sessionId}`, sessionId })
}

const rowOf = (profile?: string) =>
  root.querySelector<HTMLElement>(
    profile ? `[data-single-thread-bot="${profile}"]` : '[data-single-thread-nav="thread"]'
  )!

function look(profile?: string) {
  const row = rowOf(profile)

  return {
    dot: row.querySelector('[data-waiting-dot]')?.getAttribute('aria-label') ?? null,
    face: row.querySelector('svg[data-apex-avatar]')!.getAttribute('data-apex-avatar'),
    line: row.querySelector('[data-single-thread-status]')?.textContent ?? null,
    state: row.getAttribute('data-state')
  }
}

const found = (profile: string, id: string) => ({ ids: [id], profile, rootId: id, status: 'found' as const, tipId: id })

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  resetMainThreadForTest()
  noteMainThreadClaimed('default', 'apex-root')
  $selectedStoredSessionId.set('apex-root')
  $authState.set({ ...$authState.get(), accountId: 'acc-1', status: 'signed-in' })
})

afterEach(() => {
  cleanup()
  clearAllPrompts()
  clearClarifyRequest()
  clearMcpSetupRequest()
  resetHandoffsForTest()
  dismissHandoffProposal()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  resetThreadPresenceForTest()
  $activeGatewayProfile.set('default')
  $activeSessionId.set(null)
  $sessionStates.set({})
  $selectedStoredSessionId.set(null)
})

describe('what a parked prompt asks', () => {
  it.each([
    ['approval', 'confirm'],
    ['sudo', 'confirm'],
    ['secret', 'confirm'],
    ['vaultUnlock', 'confirm'],
    ['vaultSaveLogin', 'confirm'],
    ['vaultCode', 'confirm'],
    ['mcpSetup', 'confirm'],
    ['clarify', 'choose']
  ] as const)('%s: %s, under its own session only', (kind, ask) => {
    PARK[kind]!('runtime-a')

    expect($parkedAsks.get()).toEqual({ 'runtime-a': ask })
    expect(parkedAsk($parkedAsks.get(), ['runtime-b'])).toBeNull()
  })

  it('a yes/no outranks a choice across the thread’s sessions', () => {
    PARK.clarify!('runtime-a')
    PARK.approval!('runtime-b')

    expect(parkedAsk($parkedAsks.get(), ['runtime-a', 'runtime-b'])).toBe('confirm')
    expect(parkedAsk($parkedAsks.get(), ['runtime-a'])).toBe('choose')
  })
})

describe('one assistant (APEX’s row)', () => {
  it.each([
    ['approval', '等你确认'],
    ['clarify', '等你决定'],
    ['sudo', '等你确认'],
    ['mcpSetup', '等你确认']
  ])('%s parked for the thread: %s, the face looks up, the dot is lit', (kind, line) => {
    $sessionStates.set({ 'runtime-apex': session('apex-root', { needsInput: true }) })
    PARK[kind]!('runtime-apex')
    renderSidebar()

    expect(look()).toEqual({ dot: line, face: 'waiting', line, state: 'waiting' })
  })

  it('answered: back to working at once, though needsInput stays up until the next tool finishes', () => {
    $sessionStates.set({ 'runtime-apex': session('apex-root', { needsInput: true }) })
    PARK.approval!('runtime-apex')
    renderSidebar()
    act(() => clearApprovalRequest('runtime-apex'))

    expect(look()).toEqual({ dot: null, face: 'working', line: '在做事…', state: 'working' })
  })

  it('the dot stays lit with the conversation on screen: waiting is not news', () => {
    $sessionStates.set({ 'runtime-apex': session('apex-root') })
    PARK.approval!('runtime-apex')
    renderSidebar('chat')

    expect(look().dot).toBe('等你确认')
  })

  it('a prompt parked for a session that is not the thread’s says nothing', () => {
    $sessionStates.set({ 'runtime-apex': session('apex-root'), other: session('older-chat') })
    PARK.approval!('other')
    renderSidebar()

    expect(look()).toEqual({ dot: null, face: 'working', line: '在做事…', state: 'working' })
  })

  it('正在回… while it writes its answer', () => {
    $sessionStates.set({
      'runtime-apex': session('apex-root', { messages: [...ASKED, say('a-1', 'assistant', '好，第一个：')] })
    })
    renderSidebar()

    expect(look()).toMatchObject({ face: 'working', line: '正在回…', state: 'working' })
  })

  it('发送失败 in red when the send failed; the next send clears it', () => {
    const failed = { error: '没发出去', id: 'assistant-error-1', parts: [], role: 'assistant' } as ChatMessage

    $sessionStates.set({ 'runtime-apex': session('apex-root', { busy: false, messages: [...ASKED, failed] }) })
    renderSidebar()

    expect(look()).toEqual({ dot: null, face: 'idle', line: '发送失败', state: 'failed' })
    expect(rowOf().querySelector('[data-single-thread-status]')!.className).toContain('text-destructive')

    act(() =>
      $sessionStates.set({
        'runtime-apex': session('apex-root', { messages: [...ASKED, failed, say('u-2', 'user', '再发一次')] })
      })
    )

    expect(look()).toMatchObject({ line: '在做事…', state: 'working' })
  })

  it('an answer that came with an error is not a failed send', () => {
    const partial = { ...say('a-1', 'assistant', '写了一半'), error: '中途断了' }

    $sessionStates.set({ 'runtime-apex': session('apex-root', { busy: false, messages: [...ASKED, partial] }) })
    renderSidebar()

    expect(look().state).toBe('idle')
  })
})

describe('several assistants: on screen and in the background', () => {
  beforeEach(() => {
    setMultiBotFlagForTest(true)
    setMultiBotHandoffFlagForTest(true)
    resetBotRosterForTest(botRosterFrom(ROWS, () => true))
    $mainThreadsByProfile.set({
      default: found('default', 'apex-root'),
      scripts: found('scripts', 'scripts-root'),
      writer: found('writer', 'writer-root')
    })
  })

  it('a background assistant’s approval lights its row; answered, it is working again at once', () => {
    $sessionStates.set({ 'runtime-writer': session('writer-root', { needsInput: true }) })
    PARK.approval!('runtime-writer')
    renderSidebar('chat')

    expect(look('writer')).toEqual({ dot: '等你确认', face: 'waiting', line: '等你确认', state: 'waiting' })
    expect(look('default').dot).toBeNull()

    act(() => clearApprovalRequest('runtime-writer'))

    expect(look('writer')).toMatchObject({ dot: null, face: 'working', state: 'working' })
  })

  it('the assistant on screen waiting on a choice', () => {
    $activeGatewayProfile.set('writer')
    $sessionStates.set({ 'runtime-writer': session('writer-root') })
    PARK.clarify!('runtime-writer')
    renderSidebar('chat')

    expect(look('writer')).toEqual({ dot: '等你决定', face: 'waiting', line: '等你决定', state: 'waiting' })
  })

  const relay = (over: Partial<HandoffRecord> = {}): HandoffRecord => ({
    ask: '写一版口播',
    attempts: 1,
    baton: 1,
    cancelReason: null,
    carry: { files: [], links: [], text: '挑好了：不打孔。', truncated: false },
    chainId: 'relay-1',
    createdAt: 1,
    failure: null,
    finishedAt: null,
    from: { messageId: 'a-0', name: 'APEX', profile: 'default', storedSessionId: 'apex-root' },
    id: 'relay-1',
    notBefore: null,
    owner: 'acc-1',
    queueReason: null,
    result: null,
    startedAt: 1,
    status: 'running',
    to: 'scripts',
    turn: {
      requestText: '【APEX 交来的活】',
      runtimeSessionId: 'runtime-relay',
      storedSessionId: 'scripts-root',
      submittedAt: 1
    },
    updatedAt: 1,
    waitingFor: null,
    ...over
  })

  it('a relay turn only the relay poll saw stop (this window holds no session for it): 在等你确认', () => {
    $handoffs.set([
      relay({ status: 'waiting', waitingFor: { kind: 'approval', question: 'ffmpeg', requestId: 'a-1' } })
    ])
    renderSidebar('chat')

    expect(look('scripts')).toEqual({
      dot: '在等你确认（APEX 交来的活）',
      face: 'waiting',
      line: '在等你确认（APEX 交来的活）',
      state: 'waiting'
    })
  })

  it('a relay turn whose question is parked here (under the relay’s own session): 在等你决定', () => {
    $sessionStates.set({ 'runtime-relay': session(null) })
    PARK.clarify!('runtime-relay')
    $handoffs.set([relay()])
    renderSidebar('chat')

    expect(look('scripts')).toMatchObject({ dot: '在等你决定（APEX 交来的活）', face: 'waiting', state: 'waiting' })
  })

  it('answered in this window: the row helps again before the relay poll catches up', () => {
    $sessionStates.set({ 'runtime-relay': session(null) })
    $handoffs.set([
      relay({ status: 'waiting', waitingFor: { kind: 'approval', question: 'ffmpeg', requestId: 'a-1' } })
    ])
    renderSidebar('chat')

    expect(look('scripts')).toMatchObject({ dot: null, line: '在帮 APEX：写一版口播' })
    expect(look('scripts').face).not.toBe('waiting')
  })

  it('the relay confirm card up: the sender waits on a yes/no until it is answered', () => {
    $sessionStates.set({ 'runtime-apex': session('apex-root', { busy: false }) })
    $handoffProposal.set({
      id: 'proposal-1',
      input: {
        ask: '写 3 个标题',
        from: { messageId: 'a-0', profile: 'default', storedSessionId: 'apex-root' },
        to: 'writer'
      },
      origin: 'next_step',
      refusal: null
    })
    renderSidebar('chat')

    expect(look('default')).toEqual({ dot: '等你确认', face: 'waiting', line: '等你确认', state: 'waiting' })
    expect(look('writer').state).toBe('idle')

    act(() => dismissHandoffProposal())

    expect(look('default')).toMatchObject({ dot: null, state: 'idle' })
  })

  it('relay off: a stored relay record and a card left over say nothing', () => {
    setMultiBotHandoffFlagForTest(false)
    $handoffs.set([
      relay({ status: 'waiting', waitingFor: { kind: 'approval', question: 'ffmpeg', requestId: 'a-1' } })
    ])
    $handoffProposal.set({
      id: 'proposal-1',
      input: {
        ask: '写 3 个标题',
        from: { messageId: 'a-0', profile: 'default', storedSessionId: 'apex-root' },
        to: 'writer'
      },
      origin: 'next_step',
      refusal: null
    })
    renderSidebar('chat')

    expect([look('default').state, look('scripts').state]).toEqual(['idle', 'idle'])
  })
})

describe('the foot of the conversation (the activity line)', () => {
  const RUNTIME = 'runtime-on-screen'

  async function activityLine() {
    $activeSessionId.set(RUNTIME)

    const view = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={remixRunningTurn() as ThreadMessage[]}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    )

    const line = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-single-thread-activity] [role="status"]')!
    )

    return {
      face: line.querySelector('svg[data-apex-avatar]')!.getAttribute('data-apex-avatar'),
      shimmer: Boolean(line.querySelector('.shimmer')),
      text: line.querySelector('span.truncate')!.textContent
    }
  }

  it.each([
    ['approval', '等你确认'],
    ['clarify', '等你决定'],
    ['mcpSetup', '等你确认']
  ])('%s parked for the turn on screen: %s, looking up at the user', async (kind, text) => {
    PARK[kind]!(RUNTIME)

    expect(await activityLine()).toEqual({ face: 'waiting', shimmer: false, text })
  })

  it('nothing parked: the step, looking down at the work', async () => {
    expect(await activityLine()).toEqual({ face: 'working', shimmer: true, text: '正在识别语音…' })
  })
})

describe('the relay cards in the sender’s thread say the same words', () => {
  const copy = SINGLE_THREAD_HANDOFF_COPY.zh

  it.each([
    [{ kind: 'approval', question: ' 转码 ', requestId: 'a' }, '在等你确认', '带货脚本在等你确认：转码'],
    [
      { kind: 'clarify', question: '竖版还是横版？', requestId: 'q' },
      '在等你决定',
      '带货脚本在等你决定：竖版还是横版？'
    ],
    [null, '在等你决定', '带货脚本在等你决定。']
  ] as const)('%o', (prompt, chip, note) => {
    expect([relayWaitingChip(copy, prompt), relayWaitingNote(copy, '带货脚本', prompt)]).toEqual([chip, note])
  })

  it('no card reads the 「决定」 words directly (every waiting chip and note goes through the split)', () => {
    const SRC = join(__dirname, '..', '..')

    const files = (readdirSync(SRC, { recursive: true }) as string[])
      .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter(file => /\.(waitingChip|waitingNote)\b/.test(readFileSync(join(SRC, file), 'utf8')))

    expect(files).toEqual(['i18n/single-thread-handoff.ts'])
  })
})

describe('the face (hc-1064’s figure)', () => {
  it.each(APEX_AVATAR_SHAPES)('%s: waiting, the eyes rise 2.5 above idle', shape => {
    const eyes = (mood: 'idle' | 'waiting') =>
      [...render(<ApexAvatar mood={mood} shape={shape} />).container.querySelectorAll('rect')].map(rect =>
        Number(rect.getAttribute('y'))
      )

    const idle = eyes('idle')

    cleanup()
    expect(eyes('waiting')).toEqual(idle.map(y => y - 2.5))
  })

  it('the hop and the lit dot are still under reduced motion', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'components', 'apex-avatar.css'), 'utf8')
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'))

    expect(css).toMatch(/\[data-apex-avatar='waiting'\]\s*\{\s*animation: apex-avatar-nudge/)
    expect(reduced).toMatch(/\.apex-avatar,\s*\.apex-avatar rect,\s*\.apex-waiting-dot\s*\{\s*animation: none;/)
  })
})
