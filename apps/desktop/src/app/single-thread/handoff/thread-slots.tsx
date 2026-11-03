/**
 * hc-1087: the relay cards inside the thread (slots.ts says where).
 *
 * - {@link HandoffRowSlot}: after a turn row's messages (list.tsx TurnRow).
 * - {@link HandoffEmptySlot}: the thread before its first message
 *   (thread-empty.tsx): a relay started from an empty thread shows there.
 * - {@link UserMessage}: the thread's user-message component (thread/index.tsx
 *   imports it from here): a hand-over message in the receiver's own thread
 *   reads as 「X 交来的活」 (⑪); every other message is the usual bubble.
 *
 * With relay off, in developer mode or on an earlier conversation there are
 * no slot items: each renders nothing, or the usual bubble, so the transcript's
 * DOM is what it was (handoff-ui-identity.test.tsx).
 */

import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import type { ComponentProps } from 'react'

import { messageContentText } from '@/components/assistant-ui/thread/content'
import { UserMessage as ThreadUserMessage } from '@/components/assistant-ui/thread/user-message'
import { parseHandoffHeader } from '@/lib/handoff-text'
import { $handoffs, handoffById } from '@/store/single-thread-handoff'
import { $handoffProposal } from '@/store/single-thread-handoff-confirm'

import {
  HandoffConfirmCard,
  HandoffHandedBackLine,
  HandoffIncomingCard,
  HandoffReceivedCard,
  HandoffRelayCard
} from './cards'
import { parseHandoffRequest, requestViewFromRecord } from './request-view'
import { $handoffSlotItems, $handoffThreadProfile, type HandoffSlotItem, rowSlotKeys } from './slots'

function SlotCard({ item }: { item: HandoffSlotItem }) {
  const records = useStore($handoffs)
  const proposal = useStore($handoffProposal)

  if (item.kind === 'proposal') {
    return proposal?.id === item.id ? <HandoffConfirmCard proposal={proposal} /> : null
  }

  const record = handoffById(item.id, records)

  if (!record) {
    return null
  }

  return item.kind === 'sent' ? (
    <HandoffRelayCard record={record} />
  ) : item.kind === 'incoming' ? (
    <HandoffIncomingCard record={record} />
  ) : (
    <HandoffHandedBackLine record={record} />
  )
}

/** The cards that sit after a turn row (its message indices). */
export function HandoffRowSlot({ indices }: { indices: readonly number[] }) {
  const items = useStore($handoffSlotItems)
  const keys = useAuiState(s => rowSlotKeys(s.thread.messages, items, indices))

  if (!keys) {
    return null
  }

  return keys.split('\n').map(key => {
    const item = items.find(candidate => candidate.key === key)

    return item ? <SlotCard item={item} key={key} /> : null
  })
}

/** The thread before its first message: every card it holds, in order. */
export function HandoffEmptySlot() {
  const items = useStore($handoffSlotItems)

  return items.filter(item => item.kind !== 'handed_back').map(item => <SlotCard item={item} key={item.key} />)
}

type UserMessageProps = ComponentProps<typeof ThreadUserMessage>

/** A hand-over in the receiver's own thread reads as 「X 交来的活」; any other message is the usual bubble. */
export function UserMessage(props: UserMessageProps) {
  const profile = useStore($handoffThreadProfile)
  const records = useStore($handoffs)
  const text = useAuiState(s => (profile ? messageContentText(s.message.content) : ''))
  const header = profile ? parseHandoffHeader(text) : null
  const record = header ? handoffById(header.id, records) : null
  const view = record ? requestViewFromRecord(record) : header ? parseHandoffRequest(text) : null

  if (!header || !view) {
    return <ThreadUserMessage {...props} />
  }

  return (
    <MessagePrimitive.Root
      className="flex w-full min-w-0 flex-col items-stretch"
      data-handoff-id={header.id}
      data-role="user"
      data-slot="aui_user-message-root"
    >
      <HandoffReceivedCard fromProfile={record?.from.profile ?? header.from} view={view} />
    </MessagePrimitive.Root>
  )
}
