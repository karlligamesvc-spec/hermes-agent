/**
 * Identity harness for a send made while the thread is still opening (the
 * single-thread middleware's 「正在打开对话」 exits): the real ChatBar and the
 * real single-thread shell, the user types and presses Enter, and then the
 * thread finishes opening. Recorded per step:
 *
 * - what reached the app's submit (the ChatBar's `onSubmit`, which the shell
 *   is handed too);
 * - the notices shown;
 * - what is left in the composer;
 * - what the dock above the composer shows (normalized HTML), when anything;
 *
 * right after Enter, once the opening has run past 400 ms, and once it opened.
 *
 * The four ways a thread can be opening, set up through the stores:
 * `switching` (another assistant asked for, not answering yet), `looking-up`
 * (the thread lookup running), `selecting` (the thread found, the shell on
 * its way to it) and `loading` (selected, its conversation not bound yet).
 *
 * Uses only APIs fork main 3992e465 (Desktop 0.17.72) already had — the shell
 * there takes one argument and ignores the submit — so the goldens of every
 * mode were first recorded there.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { ChatBar } from '@/app/chat/composer'
import { RICH_INPUT_SLOT } from '@/app/chat/composer/rich-editor'
import type { ChatBarState } from '@/app/chat/composer/types'
import type { RequestGateway } from '@/app/single-thread/composer-middleware'
import { useSingleThreadShell } from '@/app/single-thread/use-single-thread-shell'
import { ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider } from '@/i18n'
import { $mainThread, MAIN_THREAD_TITLE, noteMainThreadClaimed } from '@/store/main-thread'
import { $notifications } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { $botIntent } from '@/store/single-thread-bots'

export const OPENING_CASES = ['switching', 'looking-up', 'selecting', 'loading'] as const

export type OpeningCase = (typeof OPENING_CASES)[number]

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

const WORDS = '帮我写 3 个标题'

function traceGateway(): RequestGateway {
  return (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'session.list') {
      return { sessions: [{ id: `${String(params?.profile ?? 'default')}-root`, title: MAIN_THREAD_TITLE }] }
    }

    if (method === 'profiles.list') {
      return { profiles: [{ is_default: true, name: 'default' }] }
    }

    return {}
  }) as RequestGateway
}

/** React's generated ids differ by render order, the composer rotates its placeholder, held ids count up. */
function normalized(html: string): string {
  return html
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
    .replace(/data-placeholder="[^"]*"/g, 'data-placeholder="«rotating»"')
    .replace(/held-\d+/g, 'held-«n»')
}

function Shell({ request, submit }: { request: RequestGateway; submit: (text: string) => Promise<boolean> }) {
  // Fork main's shell takes the request alone; the submit is for the held messages (hc-1146).
  ;(useSingleThreadShell as (request: RequestGateway, submit: unknown) => void)(request, submit)

  return null
}

/** Let `ms` pass a few milliseconds per act() scope, so renders land between timers as in the app. */
async function tick(ms: number): Promise<void> {
  for (let passed = 0; passed < ms; passed += 5) {
    await act(async () => new Promise(resolve => window.setTimeout(resolve, 5)))
  }
}

/** The stores of a thread that is opening in the way `kase` names. */
function openingState(kase: OpeningCase): void {
  $activeGatewayProfile.set('default')

  if (kase === 'looking-up') {
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'loading', tipId: null })
    $selectedStoredSessionId.set(null)
    $activeSessionId.set(null)

    return
  }

  noteMainThreadClaimed('default', 'default-root')

  if (kase === 'switching') {
    $selectedStoredSessionId.set('default-root')
    $activeSessionId.set('rt-default')
    $botIntent.set('writer')
  } else if (kase === 'selecting') {
    $selectedStoredSessionId.set(null)
    $activeSessionId.set(null)
  } else {
    $selectedStoredSessionId.set('default-root')
    $activeSessionId.set(null)
  }
}

/** The thread open: the switch landed (its engine answers, then the click's intent clears), the thread found, selected and bound. */
function openState(kase: OpeningCase): void {
  const profile = kase === 'switching' ? 'writer' : 'default'

  $activeGatewayProfile.set(profile)
  $botIntent.set(null)
  noteMainThreadClaimed(profile, `${profile}-root`)
  $selectedStoredSessionId.set(`${profile}-root`)
  $activeSessionId.set(`rt-${profile}`)
}

/** Type `WORDS` while the thread opens, press Enter, then let it open. Returns the steps as JSON. */
export async function sendWhileOpeningTrace(kase: OpeningCase): Promise<Record<string, unknown>> {
  const request = traceGateway()
  const sent: string[] = []

  const submit = async (text: string) => {
    sent.push(text)

    return true
  }

  openingState(kase)
  $notifications.set([])

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[kase === 'looking-up' || kase === 'selecting' ? '/' : '/default-root']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <Shell request={request} submit={submit} />
            <ChatBar
              busy={false}
              disabled={false}
              onCancel={() => {}}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSteer={async () => true}
              onSubmit={submit}
              state={STATE}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  await tick(40)

  const editor = view.container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

  const step = () => {
    const dock = view.container.querySelector('[data-held-sends]')

    return {
      composer: editor.textContent ?? '',
      dock: dock ? normalized(dock.outerHTML) : null,
      notices: $notifications.get().map(notice => notice.message),
      sent: [...sent]
    }
  }

  editor.append(window.document.createTextNode(WORDS))
  fireEvent.input(editor)
  await tick(20)
  fireEvent.keyDown(editor, { key: 'Enter' })
  await tick(60)

  const afterSend = step()

  // Past the 400 ms a warm switch takes at most (hc-1146's overlay delay).
  await tick(450)

  const stillOpening = step()

  act(() => openState(kase))
  await tick(60)

  const afterOpen = step()

  cleanup()

  return { afterSend, stillOpening, afterOpen }
}
