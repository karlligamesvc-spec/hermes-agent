/**
 * hc-1087: where each relay card sits in the thread on screen.
 *
 * - The sender's relay card: right after the reply whose result it carried
 *   (`from.messageId`); without that message (a reloaded transcript with new
 *   ids, a relay with nothing carried), after the last message older than the
 *   relay. Before the transcript's first loaded message: not shown.
 * - The confirm card and the receiver's queued relays: after the last message.
 * - 「已交回 X」: after the receiver's turn that answered the hand-over.
 *
 * Only in an assistant's own 「APEX 主线」 while relay is on: an earlier
 * conversation, developer mode and the switch off have no slot items at all,
 * so the rows render exactly what they did.
 */

import { computed } from 'nanostores'

import { parseHandoffHeader } from '@/lib/handoff-text'
import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { normalizeProfileKey } from '@/store/profile'
import { $selectedStoredSessionId, $sessions } from '@/store/session'
import { $currentBotProfile } from '@/store/single-thread-bots'
import { $handoffMode, $handoffs } from '@/store/single-thread-handoff'
import { $handoffProposal } from '@/store/single-thread-handoff-confirm'

export type HandoffSlotKind = 'handed_back' | 'incoming' | 'proposal' | 'sent'

export interface HandoffSlotItem {
  key: string
  kind: HandoffSlotKind
  /** The relay's id (the proposal's for a confirm card). */
  id: string
  /** Placed after this message when it is in the transcript. */
  messageId: null | string
  /** Else after the last message no newer than this (epoch ms). */
  at: number
  /** After the user message carrying this hand-over header id instead. */
  headerId: null | string
  /** After the last message, whatever its time. */
  tail: boolean
}

/** The assistant whose own thread is on screen, while relay is on; null anywhere else. */
export const $handoffThreadProfile = computed(
  [$handoffMode, $currentBotProfile, $mainThread, $selectedStoredSessionId, $sessions],
  (on, profile, thread, storedId, sessions): null | string => {
    if (!on || normalizeProfileKey(thread.profile ?? '') !== profile) {
      return null
    }

    if (thread.status === 'absent') {
      return storedId ? null : profile
    }

    return isMainThreadStoredId(storedId, thread, sessions) ? profile : null
  }
)

const NO_ITEMS: readonly HandoffSlotItem[] = []

/** Every card the thread on screen holds, oldest relay first, the confirm card last. */
export const $handoffSlotItems = computed(
  [$handoffThreadProfile, $handoffs, $handoffProposal],
  (profile, records, proposal): readonly HandoffSlotItem[] => {
    if (!profile) {
      return NO_ITEMS
    }

    const items: HandoffSlotItem[] = []
    const base = { headerId: null, messageId: null, tail: false }

    for (const record of records) {
      if (record.from.profile === profile) {
        items.push({
          ...base,
          at: record.createdAt,
          id: record.id,
          key: `sent:${record.id}`,
          kind: 'sent',
          messageId: record.from.messageId
        })
      } else if (record.to === profile && record.status === 'queued') {
        items.push({
          ...base,
          at: record.createdAt,
          id: record.id,
          key: `incoming:${record.id}`,
          kind: 'incoming',
          tail: true
        })
      } else if (record.to === profile && record.status === 'returned') {
        items.push({
          ...base,
          at: record.createdAt,
          headerId: record.id,
          id: record.id,
          key: `handed_back:${record.id}`,
          kind: 'handed_back'
        })
      }
    }

    if (proposal && normalizeProfileKey(proposal.input.from.profile) === profile) {
      items.push({
        ...base,
        at: Date.now(),
        id: proposal.id,
        key: `proposal:${proposal.id}`,
        kind: 'proposal',
        tail: true
      })
    }

    return items.length ? items : NO_ITEMS
  }
)

export interface SlotMessage {
  id: string
  role: string
  createdAt?: unknown
  content?: unknown
}

function millis(createdAt: unknown): null | number {
  return createdAt instanceof Date && Number.isFinite(createdAt.getTime()) ? createdAt.getTime() : null
}

function userText(message: SlotMessage): string {
  const content = message.content

  if (typeof content === 'string') {
    return content
  }

  return Array.isArray(content)
    ? content.map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text ?? '') : '')).join('')
    : ''
}

/** The message index an item sits after; -1: not in this transcript. */
export function slotIndex(messages: readonly SlotMessage[], item: HandoffSlotItem): number {
  if (!messages.length) {
    return -1
  }

  if (item.tail) {
    return messages.length - 1
  }

  if (item.headerId) {
    const at = messages.findIndex(
      message => message.role === 'user' && parseHandoffHeader(userText(message))?.id === item.headerId
    )

    return at
  }

  const own = item.messageId ? messages.findIndex(message => message.id === item.messageId) : -1

  if (own >= 0) {
    return own
  }

  let found = -1

  for (let index = 0; index < messages.length; index += 1) {
    const time = millis(messages[index]!.createdAt)

    if (time !== null && time <= item.at) {
      found = index
    }
  }

  return found
}

const placed = new WeakMap<readonly SlotMessage[], WeakMap<readonly HandoffSlotItem[], Map<string, number>>>()

/** Every item's index, worked out once per transcript and item list (each row asks). */
export function slotIndexes(
  messages: readonly SlotMessage[],
  items: readonly HandoffSlotItem[]
): ReadonlyMap<string, number> {
  let byItems = placed.get(messages)

  if (!byItems) {
    byItems = new WeakMap()
    placed.set(messages, byItems)
  }

  let indexes = byItems.get(items)

  if (!indexes) {
    indexes = new Map(items.map(item => [item.key, slotIndex(messages, item)]))
    byItems.set(items, indexes)
  }

  return indexes
}

/** The keys of the items a turn row holds (its message indices), in item order, joined: '' for none. */
export function rowSlotKeys(
  messages: readonly SlotMessage[],
  items: readonly HandoffSlotItem[],
  indices: readonly number[]
): string {
  if (!items.length) {
    return ''
  }

  // A turn row's cards go after its last message: every index in the row counts as the row.
  const indexes = slotIndexes(messages, items)

  return items
    .filter(item => indices.includes(indexes.get(item.key) ?? -1))
    .map(item => item.key)
    .join('\n')
}
