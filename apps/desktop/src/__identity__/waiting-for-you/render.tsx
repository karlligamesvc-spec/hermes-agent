/**
 * hc-1107 identity harness: the surfaces that say whether an assistant waits on
 * the user, is replying, or did not get the send through — the sidebar (every
 * mode's own: the session list with the switch off or in developer mode, the
 * assistant rows in product mode) and a running turn's foot in the thread.
 * Uses only APIs fork main 91b2f71eaf already has, so the same file records
 * the goldens there and checks them on the branch.
 *
 * The caller sets the switches (single_thread, multi_bot, relay, tool view);
 * this file only seeds the state each surface reads and returns its
 * normalized HTML.
 */
// First: the recording time zone, before any app module or fixture (time-zone.ts).
import '../single-thread-shell/time-zone'

import { type ThreadMessage } from '@assistant-ui/react'
import { act, render, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

import type { AppView } from '@/app/routes'
import type { ClientSessionState } from '@/app/types'
import { ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { $authState } from '@/store/auth'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { $mainThreadsByProfile, noteMainThreadClaimed } from '@/store/main-thread'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { $botLastSessions, type BotProfileRow, botRosterFrom } from '@/store/single-thread-bots'
import { $handoffs, type HandoffRecord, resetHandoffsForTest } from '@/store/single-thread-handoff'
import { $handoffProposal } from '@/store/single-thread-handoff-confirm'
import { $botSeenReplyIds, $threadSeenReplyId } from '@/store/single-thread-presence'
import { $threadActivity, $threadInCall } from '@/store/thread-signals'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'
import { remixRunningTurn } from '@/test/remix-turn'

import { normalized, renderSidebar, seedShellState } from '../single-thread-shell/render'

export { normalized }

export const ACCOUNT = 'acc-waiting'

/** The thread's runtime session (the one on screen). */
export const APEX_RUNTIME = 'runtime-apex'

/** A thread on screen in each state hc-1107 names, and the quiet one around them. */
export const THREAD_STATES = ['approval', 'clarify', 'answered', 'replying', 'failed', 'quiet'] as const
export type ThreadStateName = (typeof THREAD_STATES)[number]

const settle = (ms = 30) =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })

/** The shell's seed (fixed clock, zh, two stored sessions, a signed-in account) with nothing parked or running. */
export function seedWaitingState(): void {
  seedShellState()
  $authState.set({ ...$authState.get(), accountId: ACCOUNT })
  $activeSessionId.set(APEX_RUNTIME)
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  clearAllPrompts()
  clearClarifyRequest()
  $threadActivity.set(null)
  $threadInCall.set(false)
  $threadSeenReplyId.set(null)
  $botSeenReplyIds.set({})
  $botLastSessions.set({})
  $sessionStates.set({})
  $handoffProposal.set(null)
  resetHandoffsForTest()
}

export function clearWaitingState(): void {
  clearAllPrompts()
  clearClarifyRequest()
  $activeSessionId.set(null)
  $threadActivity.set(null)
  $sessionStates.set({})
  $handoffProposal.set(null)
  resetHandoffsForTest()
}

const T = new Date(2026, 9, 21, 11, 50).getTime() / 1000

const user = (id: string, text: string, at = T): ChatMessage => ({
  id,
  parts: [{ text, type: 'text' }],
  role: 'user',
  timestamp: at
})

const reply = (id: string, text: string, at = T): ChatMessage => ({
  completedAt: at + 5,
  id,
  parts: [{ text, type: 'text' }],
  role: 'assistant',
  timestamp: at
})

const EARLIER: ChatMessage[] = [user('u-0', '这周想做收纳'), reply('a-0', '挑好了：租房党衣柜改造，不打孔。')]

/** A turn that ran one step and is now writing its answer. */
const WRITING: ChatMessage = {
  id: 'a-1',
  parts: [
    {
      args: { query: '免打孔 收纳' },
      argsText: '{"query":"免打孔 收纳"}',
      result: '{"ok":true}',
      toolCallId: 'call-search',
      toolName: 'web_search',
      type: 'tool-call'
    },
    { text: '找到 3 个角度，先说第一个：', type: 'text' }
  ] as ChatMessage['parts'],
  role: 'assistant',
  timestamp: T + 60
}

/** The send `prompt.submit` refused: the error bubble the submit path appends, and nothing else. */
const SEND_FAILED: ChatMessage = {
  completedAt: T + 61,
  error: '没发出去：网络断了',
  id: 'assistant-error-1',
  parts: [],
  role: 'assistant',
  timestamp: T + 61
}

export function threadSession(name: ThreadStateName, storedSessionId = 'chat-a'): ClientSessionState {
  const ask = user('u-1', '按这个写 3 个标题', T + 60)
  const busy = name !== 'failed' && name !== 'quiet'

  const messages =
    name === 'replying'
      ? [...EARLIER, ask, WRITING]
      : name === 'failed'
        ? [...EARLIER, ask, SEND_FAILED]
        : name === 'quiet'
          ? EARLIER
          : [...EARLIER, ask]

  return {
    awaitingResponse: false,
    busy,
    messages,
    // The engine's own flag: still up just after an approval was answered, until the next tool finishes.
    needsInput: name === 'approval' || name === 'clarify' || name === 'answered',
    storedSessionId,
    turnLive: busy
  } as unknown as ClientSessionState
}

/** Park the prompt a state waits on, under `runtimeId`. */
export function parkPrompt(name: ThreadStateName, runtimeId: string): void {
  if (name === 'approval') {
    setApprovalRequest({
      command: 'ffmpeg -i 收纳.mp4 -vf scale=1080:-2 out.mp4',
      description: 'ffmpeg 转码',
      requestId: `approval-${runtimeId}`,
      sessionId: runtimeId
    })
  }

  if (name === 'clarify') {
    setClarifyRequest({
      choices: ['竖版 9:16', '横版 16:9'],
      multiSelect: false,
      question: '要竖版还是横版？',
      receivedAt: T + 70,
      requestId: `clarify-${runtimeId}`,
      sessionId: runtimeId
    })
  }
}

/** One assistant: the thread in `name`, read from another page (`settings`) or from the conversation (`chat`). */
export function sidebarHtml(name: ThreadStateName, view: AppView = 'settings'): string {
  noteMainThreadClaimed('default', 'chat-a')
  $sessionStates.set({ [APEX_RUNTIME]: threadSession(name) })
  parkPrompt(name, APEX_RUNTIME)
  $threadSeenReplyId.set('a-0')

  return normalized(renderSidebar('/chat-a', view).container.innerHTML) + '\n'
}

// ── several assistants ───────────────────────────────────────────────────────

export const ROSTER_ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'scripts', ui_meta: { apex: { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' } } },
  { name: 'cutter', ui_meta: { apex: { color: 'teal', created: 3, name: '剪辑', shape: 'drop' } } }
]

export const roster = () => botRosterFrom(ROSTER_ROWS, () => true)

const found = (profile: string, id: string) => ({
  ids: [id],
  profile,
  rootId: id,
  status: 'found' as const,
  tipId: id
})

const RELAY_AT = new Date(2026, 9, 21, 11, 55).getTime()

/** A relay 带货脚本 is working on for APEX, its turn stopped on an approval this window never parked. */
export function waitingRelay(over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    ask: '按这个选题写一版口播',
    attempts: 1,
    baton: 1,
    cancelReason: null,
    carry: { files: [], links: [], text: '挑好了：租房党衣柜改造，不打孔。', truncated: false },
    chainId: 'relay-1',
    createdAt: RELAY_AT,
    failure: null,
    finishedAt: null,
    from: { messageId: 'a-0', name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
    id: 'relay-1',
    notBefore: null,
    owner: ACCOUNT,
    queueReason: null,
    result: null,
    startedAt: RELAY_AT,
    status: 'waiting',
    to: 'scripts',
    turn: {
      requestText: '【APEX 交来的活】',
      runtimeSessionId: 'runtime-scripts-relay',
      storedSessionId: 'scripts-root',
      submittedAt: RELAY_AT
    },
    updatedAt: RELAY_AT,
    waitingFor: { kind: 'approval', question: 'ffmpeg 转码', requestId: 'approval-relay' },
    ...over
  }
}

/**
 * Four assistants, APEX on screen and quiet:
 * - 小红书文案 in the background, its turn stopped on an approval (parked here);
 * - 带货脚本 on a relay for APEX, stopped on an approval only the relay's poll saw;
 * - 剪辑 in the background, its last send refused.
 * With `proposal`, APEX's relay confirm card (「交给小红书文案？」) is up as well.
 */
export function severalSidebarHtml({ proposal = false }: { proposal?: boolean } = {}): string {
  $mainThreadsByProfile.set({
    cutter: found('cutter', 'cutter-root'),
    default: found('default', 'chat-a'),
    scripts: found('scripts', 'scripts-root'),
    writer: found('writer', 'writer-root')
  })
  noteMainThreadClaimed('default', 'chat-a')
  $selectedStoredSessionId.set('chat-a')
  $sessionStates.set({
    [APEX_RUNTIME]: threadSession('quiet'),
    'runtime-cutter': threadSession('failed', 'cutter-root'),
    'runtime-writer': threadSession('approval', 'writer-root')
  })
  parkPrompt('approval', 'runtime-writer')
  $handoffs.set([waitingRelay()])
  $botSeenReplyIds.set({ default: 'a-0' })

  if (proposal) {
    $handoffProposal.set({
      id: 'proposal-1',
      input: {
        ask: '按这个选题写 3 个标题',
        from: { messageId: 'a-0', profile: 'default', storedSessionId: 'chat-a' },
        to: 'writer'
      },
      origin: 'next_step',
      refusal: null
    })
  }

  return normalized(renderSidebar('/chat-a', 'settings').container.innerHTML) + '\n'
}

// ── the thread's foot ────────────────────────────────────────────────────────

/** Every assistant row of the transcript, in order. */
function messageArea(container: HTMLElement): string {
  return (
    normalized(
      [...container.querySelectorAll('[data-slot="aui_assistant-message-root"]')].map(node => node.outerHTML).join('\n')
    ) + '\n'
  )
}

/** A running turn whose foot waits on the user: the activity line in product mode, the process rows elsewhere. */
export async function runningTurnHtml(name: 'approval' | 'clarify'): Promise<string> {
  parkPrompt(name, APEX_RUNTIME)

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={remixRunningTurn() as ThreadMessage[]}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelector('[data-role="assistant"]')).not.toBeNull())
  await settle()

  return messageArea(view.container)
}
