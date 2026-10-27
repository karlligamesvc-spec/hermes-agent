/**
 * hc-1077: what an assistant working in the background is doing, for its
 * sidebar row. The activity line names the step only for the conversation on
 * screen (store/thread-signals.ts); an assistant the user switched away from
 * keeps running in its own engine, and its session state keeps streaming in.
 * Its turn is folded here the way the activity line folds the one on screen
 * (the same plain-words steps, the same status line), so its row says
 * 「正在剪辑…」 instead of only 在做事….
 */

import type { ClientSessionState } from '@/app/types'
import { statusLine } from '@/components/assistant-ui/process/process-block'
import { buildTurnProcess, buildTurnSteps, type TurnPart } from '@/components/assistant-ui/process/turn-process'
import type { ThreadActivity } from '@/store/thread-signals'

type ProcessCopy = Parameters<typeof statusLine>[1]

/** The running turn's line, or null while the session is not working. Waiting on the user is the presence's own. */
export function backgroundActivity(state: ClientSessionState | null, copy: ProcessCopy): null | ThreadActivity {
  if (!state?.busy || state.needsInput) {
    return null
  }

  const turnStart = state.messages.findLastIndex(message => message.role === 'user') + 1

  const parts = state.messages
    .slice(turnStart)
    .filter(message => message.role === 'assistant' && !message.hidden)
    .flatMap(message => message.parts as readonly TurnPart[])

  const process = buildTurnProcess(parts, true, undefined, buildTurnSteps(parts, true, true))

  return { text: statusLine(process, copy).text, waiting: false }
}
