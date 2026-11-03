/**
 * hc-1087 多助手二期 R2: the confirm card every relay (接力) goes through
 * before it starts (L2, L6). Both entries call {@link proposeHandoff} instead
 * of `startHandoff`:
 *
 * - our `@` picker (a send that names another assistant, mention.ts);
 * - R4's 「交给 X」 button under a reply (components/assistant-ui/next-steps.tsx).
 *
 * The card (app/single-thread/handoff/cards.tsx) shows whom it goes to,
 * what it is asked, the files and links that go along and the usage line; only
 * 「交给它」 calls `startHandoff` (hc-1086). One card at a time: a new proposal
 * replaces one not yet answered. Nothing here runs while relay is off.
 */

import { atom } from 'nanostores'

import { readJson, writeJson } from '@/lib/storage'

import { normalizeProfileKey } from './profile'
import { $botRoster } from './single-thread-bots'
import {
  type HandoffRecord,
  isHandoffMode,
  startHandoff,
  type StartHandoffInput,
  type StartHandoffRefusal,
  type StartHandoffResult
} from './single-thread-handoff'

export type HandoffProposalOrigin = 'mention' | 'next_step'

export interface HandoffProposal {
  id: string
  origin: HandoffProposalOrigin
  /** Exactly what `startHandoff` gets on 「交给它」. */
  input: StartHandoffInput
  /** A refusal from the last 「交给它」 (the card says why and stays). */
  refusal: null | StartHandoffRefusal
}

export interface ProposeHandoffOptions {
  origin?: HandoffProposalOrigin
  /** Once the relay is queued (R4 marks its row used; the `@` send clears the composer). */
  onStarted?: (record: HandoffRecord) => void
}

/** The card waiting for an answer, if any. */
export const $handoffProposal = atom<HandoffProposal | null>(null)

const NAMES_KEY = 'apex.single-thread.handoff-names.v1'

/**
 * The receivers' names as they were when relays to them started, so a card can
 * still say 「X 已删除」 once X is off the roster (K9). Written only on 「交给它」.
 */
export const $handoffReceiverNames = atom<Readonly<Record<string, string>>>(
  readJson<Record<string, string>>(NAMES_KEY) ?? {}
)

function rememberReceiverName(profile: string): void {
  const key = normalizeProfileKey(profile)
  const name = $botRoster.get().find(bot => bot.profile === key)?.name

  if (name && $handoffReceiverNames.get()[key] !== name) {
    const next = { ...$handoffReceiverNames.get(), [key]: name }

    $handoffReceiverNames.set(next)
    writeJson(NAMES_KEY, next)
  }
}

const started = new Map<string, (record: HandoffRecord) => void>()
let serial = 0

/** Show the confirm card for a relay. False while relay is off: the caller does nothing. */
export function proposeHandoff(input: StartHandoffInput, options: ProposeHandoffOptions = {}): boolean {
  if (!isHandoffMode()) {
    return false
  }

  const id = `proposal-${++serial}`

  started.clear()

  if (options.onStarted) {
    started.set(id, options.onStarted)
  }

  $handoffProposal.set({ id, input, origin: options.origin ?? 'next_step', refusal: null })

  return true
}

/** 「交给它」: start the relay. Null when no card is up. A refusal keeps the card up and says why. */
export function confirmHandoffProposal(): null | StartHandoffResult {
  const proposal = $handoffProposal.get()

  if (!proposal) {
    return null
  }

  rememberReceiverName(proposal.input.to)

  const result = startHandoff(proposal.input)

  if (!result.ok) {
    $handoffProposal.set({ ...proposal, refusal: result.reason })

    return result
  }

  const onStarted = started.get(proposal.id)

  started.delete(proposal.id)
  $handoffProposal.set(null)

  try {
    onStarted?.(result.handoff)
  } catch (error) {
    console.error('[handoff] onStarted failed', error)
  }

  return result
}

/** 「先不」: the card goes away, nothing starts. */
export function dismissHandoffProposal(): void {
  started.clear()
  $handoffProposal.set(null)
}
