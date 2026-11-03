/**
 * hc-1107 「等你确认」: whether an assistant's thread in single-thread product
 * mode waits on the user, and for what — read from the prompts this window has
 * parked for its sessions.
 *
 * Every blocking question a turn raises (a question card, an approval, sudo, a
 * secret, the vault's three, an MCP setup) is parked per runtime session by the
 * request handlers (server-requests.ts) — for a session in the background too,
 * since every profile's socket funnels into them. It is parked again when the
 * engine re-delivers it (a reconnect, a resume), and cleared the moment it is
 * answered (the card, the notification's buttons), withdrawn or the turn is
 * stopped. So the parked prompts are exactly what the user can answer now.
 *
 * The session's own `needsInput` flag is not: it stays up after an approval
 * was answered until the next tool finishes, so a long command kept the row
 * reading 「等你决定」 for minutes. Developer mode's session list still reads it.
 */

import { computed, type ReadableAtom } from 'nanostores'

import type { ClientSessionState } from '@/app/types'

import { $clarifyRequests } from './clarify'
import type { MainThreadState } from './main-thread'
import { $mcpSetupRequests } from './mcp-setup'
import {
  $approvalRequests,
  $secretRequests,
  $sudoRequests,
  $vaultCodeRequests,
  $vaultSaveLoginRequests,
  $vaultUnlockRequests
} from './prompts'
import type { WaitingAsk } from './thread-signals'

export type { WaitingAsk }

type Parked = Readonly<Record<string, unknown>>

/** Per runtime session id: what its parked prompt asks. A yes/no outranks a choice. */
export const $parkedAsks = computed(
  [
    $clarifyRequests,
    $approvalRequests,
    $sudoRequests,
    $secretRequests,
    $vaultUnlockRequests,
    $vaultSaveLoginRequests,
    $vaultCodeRequests,
    $mcpSetupRequests
  ],
  (choices: Parked, ...confirms: Parked[]) => {
    const asks: Record<string, WaitingAsk> = {}

    for (const [key, request] of Object.entries(choices)) {
      if (request) {
        asks[key] = 'choose'
      }
    }

    for (const parked of confirms) {
      for (const [key, request] of Object.entries(parked)) {
        if (request) {
          asks[key] = 'confirm'
        }
      }
    }

    return asks
  }
)

/** What any of `runtimeIds` waits on the user for (a yes/no first); null when none has a prompt parked. */
export function parkedAsk(asks: Readonly<Record<string, WaitingAsk>>, runtimeIds: Iterable<string>): null | WaitingAsk {
  let found: null | WaitingAsk = null

  for (const id of runtimeIds) {
    if (asks[id] === 'confirm') {
      return 'confirm'
    }

    found ??= asks[id] ?? null
  }

  return found
}

/** The runtime sessions this window holds on `thread` (on any of its stored ids). */
export function threadRuntimeIds(
  states: Readonly<Record<string, ClientSessionState>>,
  thread: MainThreadState | undefined
): string[] {
  if (thread?.status !== 'found') {
    return []
  }

  return Object.entries(states)
    .filter(([, state]) => state.storedSessionId !== null && thread.ids.includes(state.storedSessionId))
    .map(([id]) => id)
}

/** One runtime session's ask (the turn on screen's, for its activity line). */
export function sessionWaitingAsk(sessionId: null | string): ReadableAtom<null | WaitingAsk> {
  return computed($parkedAsks, asks => (sessionId ? (asks[sessionId] ?? null) : null))
}
