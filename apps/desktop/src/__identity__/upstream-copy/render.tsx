/**
 * hc-1116 identity harness for the engine's failure wording on screen: a
 * thread whose replies failed live (the error card prints the engine's
 * English), and a transcript the engine closed with its failed-turn rows
 * (what a reopened conversation shows). Uses only APIs fork main already has
 * before hc-1116, so the same file records the goldens there and checks them
 * on the branch.
 *
 * The caller sets the switches (single_thread, tool view); this file only
 * returns the normalized HTML and the hydrated rows.
 */
// First: the recording time zone, before any app module or fixture (time-zone.ts).
import '../single-thread-shell/time-zone'

import { type ThreadMessage } from '@assistant-ui/react'

import { toChatMessages } from '@/lib/chat-messages'
import type { SessionMessage } from '@/types/hermes'

import { renderTranscript, transcriptHtml } from '../single-thread-shell/render'

const at = (hour: number, minute = 0) => new Date(2026, 9, 21, hour, minute)
const seconds = (hour: number, minute = 0) => at(hour, minute).getTime() / 1000

/** agent/turn_failure_copy.py exhausted_copy for a relay that stayed busy, as the card received it. */
export const ENGINE_EXHAUSTED_TEXT =
  'Custom reported it was overloaded on all 3 attempts — it looks temporarily unavailable. Wait a minute and ' +
  'send /retry, or switch models with /model. To avoid this in future, add a backup provider with `hermes ' +
  'fallback add`.\n\nProvider said: 模型服务繁忙，请稍后再试。'

/** tui_gateway/user_messages.py turn_error_text when the engine names no layer. */
export const ENGINE_TURN_ERROR_TEXT =
  'Hermes could not finish this turn. Your message was not answered.\nDetails: RuntimeError: worker exited\n' +
  'Send it again; if it keeps happening, run `hermes doctor`.'

function ask(id: string, text: string, hour: number): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: at(hour),
    id,
    metadata: { custom: {} },
    role: 'user'
  } as ThreadMessage
}

function failedReply(id: string, error: string, hour: number, errorSurface?: Record<string, unknown>): ThreadMessage {
  return {
    content: [],
    createdAt: at(hour, 1),
    id,
    metadata: {
      custom: errorSurface ? { errorSurface } : {},
      steps: [],
      unstable_annotations: [],
      unstable_data: [],
      unstable_state: null
    },
    role: 'assistant',
    status: { error, reason: 'error', type: 'incomplete' }
  } as unknown as ThreadMessage
}

/** Two replies that failed live: the relay stayed busy (provider layer), and an engine failure with no layer. */
export const FAILED_REPLIES: ThreadMessage[] = [
  ask('f1-ask', '把这段素材剪成 30 秒竖屏', 10),
  failedReply('f1-answer', ENGINE_EXHAUSTED_TEXT, 10, { code: 'overloaded', layer: 'provider', retryable: true }),
  ask('f2-ask', '再试一次', 11),
  failedReply('f2-answer', ENGINE_TURN_ERROR_TEXT, 11)
]

export async function failedRepliesHtml(): Promise<string> {
  return transcriptHtml(await renderTranscript(FAILED_REPLIES)) + '\n'
}

/** A transcript the engine closed twice: once before any step ran, once after a step ran. */
export const FAILED_TURN_HISTORY: SessionMessage[] = [
  { content: '把这段素材剪成 30 秒竖屏', role: 'user', timestamp: seconds(10) },
  {
    content: 'Your request was not processed. Send it again if you still want me to carry it out.',
    display_kind: 'failed_turn',
    role: 'assistant',
    timestamp: seconds(10, 1)
  },
  { content: '再试一次', role: 'user', timestamp: seconds(11) },
  {
    content: 'This turn did not complete. Some actions may already have run; verify their effects before resending.',
    display_kind: 'failed_turn',
    role: 'assistant',
    timestamp: seconds(11, 1)
  }
] as SessionMessage[]

export function failedTurnHistoryJson(): string {
  return JSON.stringify(toChatMessages(FAILED_TURN_HISTORY), null, 2) + '\n'
}
