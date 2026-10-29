/**
 * hc-1101: a small transcript with your messages in it, rendered the way the
 * app renders it: the real Thread with stop and restore wired, the app's
 * right-click menu mounted, Chinese copy.
 *
 * Shared by the user-message tests (copy, edit, links, start over, time,
 * 「仍在发送中」).
 */

import { AssistantRuntimeProvider, ExportedMessageRepository, type ThreadMessage } from '@assistant-ui/react'
import { act, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { expect } from 'vitest'

import { AppContextMenu } from '@/app/context-menu/app-context-menu'
import { ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider } from '@/i18n'
import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

export const SENT = '先跑 `npm test`\n再看 @file:`/Users/xiaoman/脚本 v2.md` 和 @url:`https://v.douyin.com/iRemix01/`'
export const SENT_AS_SHOWN = '先跑 `npm test`\n再看 /Users/xiaoman/脚本 v2.md 和 https://v.douyin.com/iRemix01/'

/** Sent at 09:00 on 2026-10-28, local time. */
export const SENT_AT = new Date(2026, 9, 28, 9, 0)

export type Mode = 'developer' | 'off' | 'single-thread'

export function mode(name: Mode) {
  setSingleThreadFlagForTest(name !== 'off')
  setToolViewMode(name === 'developer' ? 'technical' : 'product')
}

export function user(
  id: string,
  text: string,
  custom: Record<string, unknown> = {},
  createdAt = SENT_AT
): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt,
    id,
    metadata: { custom },
    role: 'user'
  } as ThreadMessage
}

export function assistant(id: string, running = false, text = '好。'): ThreadMessage {
  return {
    content: [{ text: running ? '' : text, type: 'text' }],
    createdAt: SENT_AT,
    id,
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: running ? { type: 'running' } : { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
}

/** A picture-only message, then your latest ask and its reply. */
export function transcript({ running = false, text = SENT, sentAt = SENT_AT } = {}): ThreadMessage[] {
  return [
    user('u-picture', '', { attachmentRefs: ['@image:`/tmp/数据截图.png`'] }),
    assistant('a-picture'),
    user('u-last', text, {}, sentAt),
    assistant('a-last', running)
  ]
}

/** A runtime that edits, as the app's does: opening the editor really opens it. */
export function EditableRuntime({ children, messages }: { children: ReactNode; messages: ThreadMessage[] }) {
  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    isRunning: false,
    messageRepository: ExportedMessageRepository.fromArray(messages),
    onCancel: async () => {},
    onEdit: async () => {},
    onNew: async () => {},
    onReload: async () => {},
    setMessages: () => {}
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}

export const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

export async function renderThread(messages = transcript(), Runtime = ThreadRuntime, onRestore = () => {}) {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <Runtime messages={messages}>
          <Thread onCancel={() => {}} onRestoreToMessage={onRestore} />
        </Runtime>
        <AppContextMenu />
      </MemoryRouter>
    </I18nProvider>
  )

  await waitFor(() =>
    expect(view.container.querySelectorAll('[data-slot="aui_user-message-root"]').length).toBeGreaterThan(0)
  )
  await settle()

  return view
}

/** The bubble roots, in order. */
export function userRoots(): HTMLElement[] {
  return [...window.document.querySelectorAll<HTMLElement>('[data-slot="aui_user-message-root"]')]
}

/** The labels of the hover rail beside a bubble (the anchor's absolute child), left to right. */
export function railLabels(root: HTMLElement): string[] {
  const rail = root.querySelector('[data-slot="popover-anchor"] > div:not([data-user-bubble])')

  return rail ? [...rail.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? '') : []
}

/** Your words: the click-to-edit button, or single-thread mode's plain block. */
export function bubble(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.composer-human-message')!
}

export function bubbleText(root: HTMLElement): HTMLElement {
  return bubble(root).querySelector<HTMLElement>('[data-slot="aui_user-inline-text"]')!
}
