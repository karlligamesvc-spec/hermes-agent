/**
 * hc-1077 identity guard harness. Renders every single-thread surface that
 * names the assistant or reads the one thread — the sidebar, the header pill,
 * the composer, a running turn's activity line, an approval (inline and as the
 * floating bar), the 「记下了」 line and the empty thread — exactly the way the
 * goldens beside this file were recorded on fork main 50a50d1bf7, before any
 * multi-bot code existed. It must keep using only APIs that main already had:
 * the same file recorded the goldens there.
 *
 * The caller sets the switches (single_thread, tool view); this file only
 * seeds the state each surface reads and returns its normalized HTML.
 */
// First: the recording time zone, before any app module or fixture (time-zone.ts).
import '../single-thread-shell/time-zone'

import { type ThreadMessage } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect } from 'vitest'

import { ChatBar } from '@/app/chat/composer'
import type { ChatBarState } from '@/app/chat/composer/types'
import type { AppView } from '@/app/routes'
import { SingleThreadEmptyState } from '@/app/single-thread/thread-empty'
import { SingleThreadHeader } from '@/app/single-thread/thread-header'
import type { ClientSessionState } from '@/app/types'
import { ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { PendingApprovalFallback } from '@/components/assistant-ui/tool/approval'
import { I18nProvider } from '@/i18n'
import type { DesktopMemoryLedger } from '@/lib/memory-ledger'
import { $authState } from '@/store/auth'
import { clearSessionDraft } from '@/store/composer'
import { $mainThread, noteMainThreadClaimed } from '@/store/main-thread'
import { $memoryLedger } from '@/store/memory-ledger'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { $threadSeenReplyId } from '@/store/single-thread-presence'
import { $threadActivity, $threadInCall } from '@/store/thread-signals'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'
import { EDITING_APPROVAL_CODE, editingApprovalTurn } from '@/test/editing-turn'
import { remixRunningTurn } from '@/test/remix-turn'

import { normalized, renderSidebar, seedShellState } from '../single-thread-shell/render'

export { normalized }

const SESSION = 'session-multi-bot-identity'
const ACCOUNT = 'acc-multi-bot'

const settle = (ms = 30) =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })

/** The shell's seed (fixed clock, zh, two stored sessions, a signed-in account) plus the per-surface stores. */
export function seedProductState(): void {
  seedShellState()
  $authState.set({ ...$authState.get(), accountId: ACCOUNT })
  $activeSessionId.set(SESSION)
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  clearAllPrompts()
  clearSessionDraft(null)
  $threadActivity.set(null)
  $threadInCall.set(false)
  $threadSeenReplyId.set(null)
  $sessionStates.set({})
  $memoryLedger.set({ accountId: null, ledger: null, status: 'idle' })
}

export function clearProductState(): void {
  cleanup()
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
  clearAllPrompts()
  $threadActivity.set(null)
  $threadInCall.set(false)
  $threadSeenReplyId.set(null)
  $sessionStates.set({})
}

const reply = (id: string, text: string) => ({ id, parts: [{ text, type: 'text' }], role: 'assistant' })

/** The thread's runtime session, holding one reply (and, when working, a turn in flight). */
function seedThread(working: boolean): void {
  noteMainThreadClaimed('default', 'chat-a')
  $sessionStates.set({
    runtime: {
      busy: working,
      messages: [reply('reply-new', '标题写好了 3 个，要哪个？')],
      needsInput: false,
      storedSessionId: 'chat-a'
    } as unknown as ClientSessionState
  })
}

/**
 * The sidebar with the thread in one of two states:
 * - `idle`: a reply came in while the user was on another page (status line + unread dot);
 * - `working`: the activity line is on screen naming the step in progress.
 */
export function sidebarHtml(state: 'idle' | 'working'): string {
  seedThread(state === 'working')

  let view: AppView = 'chat'

  if (state === 'idle') {
    $threadSeenReplyId.set('reply-old')
    view = 'settings'
  } else {
    $threadActivity.set({ text: '正在剪辑… 第 2 步', waiting: false })
  }

  return normalized(renderSidebar('/chat-a', view).container.innerHTML) + '\n'
}

/** The header over the thread: the pill with the assistant's face and name. */
export function headerHtml(): string {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <SingleThreadHeader />
    </I18nProvider>
  )

  return normalized(view.container.innerHTML) + '\n'
}

const COMPOSER_STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

/** The composer's `<form>`: placeholder, accessible name, mic and the round button. */
export async function composerHtml(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <ChatBar
              busy={false}
              disabled={false}
              onCancel={() => {}}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSubmit={async () => true}
              state={COMPOSER_STATE}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  await settle(40)

  const form = view.container.querySelector('form')

  return normalized(form?.outerHTML ?? '').replace(/data-placeholder="[^"]*"/g, 'data-placeholder="«rotating»"') + '\n'
}

async function renderThread(messages: ThreadMessage[]): Promise<HTMLElement> {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelector('[data-role="assistant"]')).not.toBeNull())
  await settle()

  return view.container
}

/** Every assistant row of the transcript, in order. */
function messageArea(container: HTMLElement): string {
  return (
    normalized(
      [...container.querySelectorAll('[data-slot="aui_assistant-message-root"]')].map(node => node.outerHTML).join('\n')
    ) + '\n'
  )
}

/** A turn still running: the activity line (its label, the face looking down, 「停」). */
export async function runningTurnHtml(): Promise<string> {
  return messageArea(await renderThread(remixRunningTurn()))
}

function requestApproval(): void {
  setApprovalRequest({
    command: EDITING_APPROVAL_CODE,
    description:
      'execute_code script execution. The script can spawn subprocesses or mutate files without passing through terminal command approval; approval is one-shot for this run.',
    sessionId: SESSION
  })
}

/** Code waiting on the user's approval, inline under its turn with the command opened. */
export async function approvalInlineHtml(): Promise<string> {
  requestApproval()

  const container = await renderThread(editingApprovalTurn())

  await waitFor(() => expect(container.querySelector('[data-slot="tool-approval-inline"]')).not.toBeNull())
  fireEvent.click(
    within(container.querySelector<HTMLElement>('[data-slot="tool-approval-inline"]')!).getByRole('button', {
      name: '命令'
    })
  )
  await settle()

  return messageArea(container)
}

/** The same approval as the floating bar. */
export async function approvalFloatingHtml(): Promise<string> {
  requestApproval()

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <PendingApprovalFallback />
    </I18nProvider>
  )

  await settle()

  return normalized(view.container.innerHTML) + '\n'
}

const LEDGER: DesktopMemoryLedger = {
  aboutYou: [],
  limits: { aboutYouMax: 30, contentMaxChars: 100, recentKeepDays: 30, recentMax: 50 },
  recent: []
}

function notedTurn(): ThreadMessage[] {
  const createdAt = new Date(2026, 4, 1, 9, 0)
  const t = createdAt.getTime() / 1000

  const result = JSON.stringify({
    action: 'add',
    created: true,
    entry: {
      content: '不露脸，只拍手',
      id: '3f2a9c1d-0000-4000-8000-000000000077',
      kind: 'about_you',
      ref: '3f2a9c1d'
    },
    ok: true
  })

  return [
    {
      attachments: [],
      content: [{ text: '我从来不露脸', type: 'text' }],
      createdAt,
      id: 'user-noted',
      metadata: { custom: { timelineTimestamp: t } },
      role: 'user'
    },
    {
      content: [
        {
          args: { action: 'add', content: '不露脸，只拍手', kind: 'about_you' },
          argsText: '{}',
          result,
          toolCallId: 'call-noted',
          toolName: 'apex_memory',
          type: 'tool-call'
        },
        { completedAt: t + 0.5, text: '好，以后都只拍手部。', timestamp: t + 0.1, type: 'text' }
      ],
      createdAt,
      id: 'assistant-noted',
      metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' }
    }
  ] as unknown as ThreadMessage[]
}

/** A reply under which the assistant remembered something: in product mode 「✓ … 记下了：… · 撤销」. */
export async function memoryNotedHtml(): Promise<string> {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    managed: { memoryLedger: async () => ({ ledger: LEDGER, ok: true }) }
  }
  $memoryLedger.set({ accountId: ACCOUNT, ledger: LEDGER, status: 'ready' })

  const container = await renderThread(notedTurn())

  // Product mode draws the line under the reply; developer mode never does.
  await settle(60)

  return messageArea(container)
}

/** The thread before its first message, signed out (so no intake card or idea loads): greeting and tip. */
export async function emptyThreadHtml(): Promise<string> {
  $authState.set({ ...$authState.get(), status: 'signed-out' })
  $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })

  const view = render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SingleThreadEmptyState />
      </I18nProvider>
    </MemoryRouter>
  )

  await settle()

  return normalized(view.container.innerHTML) + '\n'
}
