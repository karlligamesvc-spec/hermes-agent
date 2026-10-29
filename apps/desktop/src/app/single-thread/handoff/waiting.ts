/**
 * hc-1107 「等你确认」: what relay (接力) adds to an assistant waiting on the
 * user, for its sidebar row (bot-status.ts). Null with relay off.
 *
 * - The confirm card (「交给 X？」, its usage line saying what it spends) is up
 *   for a relay this assistant would send: it waits on a yes/no.
 * - A relay this assistant is working on runs in its own session; a prompt
 *   that turn raises is parked under that session's id, which may be one the
 *   row's thread does not list yet (`runtimeIds`, read with the rest).
 * - When this window does not hold that session at all (no session state for
 *   it), only the relay runner's poll knows the turn stopped on the user:
 *   then its `waiting` stands in. A held session's parked prompts are the
 *   truth — they clear the moment the user answers, the poll a few seconds
 *   later.
 */

import { useStore } from '@nanostores/react'

import type { ClientSessionState } from '@/app/types'
import { normalizeProfileKey } from '@/store/profile'
import { $handoffMode, $handoffs, type HandoffRecord, handoffsTo, isHandoffInTurn } from '@/store/single-thread-handoff'
import { $handoffProposal, type HandoffProposal } from '@/store/single-thread-handoff-confirm'
import type { WaitingAsk } from '@/store/waiting-for-you'

export interface RelayWaiting {
  /** Waiting on the user for relay's own reasons (the confirm card, or a turn only the poll saw stop). */
  ask: null | WaitingAsk
  /** The sessions of the relays this assistant is working on: their parked prompts are its own. */
  runtimeIds: string[]
}

const NONE: RelayWaiting = { ask: null, runtimeIds: [] }

export function relayWaiting(
  profile: string,
  records: readonly HandoffRecord[],
  proposal: HandoffProposal | null,
  states: Readonly<Record<string, ClientSessionState>>
): RelayWaiting {
  const inTurn = handoffsTo(profile, records).filter(isHandoffInTurn)
  const runtimeIds = inTurn.flatMap(record => (record.turn?.runtimeSessionId ? [record.turn.runtimeSessionId] : []))

  if (proposal && normalizeProfileKey(proposal.input.from.profile) === profile) {
    return { ask: 'confirm', runtimeIds }
  }

  const unheld = inTurn.find(
    record => record.status === 'waiting' && !(record.turn?.runtimeSessionId && states[record.turn.runtimeSessionId])
  )

  return { ask: unheld ? (unheld.waitingFor?.kind === 'clarify' ? 'choose' : 'confirm') : null, runtimeIds }
}

export function useRelayWaiting(profile: string, states: Readonly<Record<string, ClientSessionState>>): RelayWaiting {
  const on = useStore($handoffMode)
  const records = useStore($handoffs)
  const proposal = useStore($handoffProposal)

  return on ? relayWaiting(profile, records, proposal, states) : NONE
}
