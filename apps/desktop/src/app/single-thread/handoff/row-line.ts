/**
 * hc-1087: what a relay (接力) puts under an assistant's name in the sidebar
 * (bot-status.ts reads it first):
 *
 * - the receiver, while the relay's turn runs: 「在帮 APEX：按这个选题写 3 个标题」;
 *   while that turn waits on the user: 「在等你决定（APEX 交来的活）」;
 * - the sender, while it is otherwise quiet and a relay it sent is not back:
 *   「等小红书文案交回」.
 *
 * Null with relay off, and for a row no relay is about: the row's own line stays.
 */

import { useStore } from '@nanostores/react'

import { type SingleThreadHandoffCopy, useSingleThreadHandoffCopy } from '@/i18n/single-thread-handoff'
import { $botRoster, type ApexBot } from '@/store/single-thread-bots'
import {
  $handoffMode,
  $handoffs,
  type HandoffRecord,
  handoffsFrom,
  handoffsTo,
  isHandoffActive,
  isHandoffInTurn
} from '@/store/single-thread-handoff'
import type { ThreadPresence } from '@/store/single-thread-presence'

const nameOf = (roster: readonly ApexBot[], profile: string, fallback?: string) =>
  roster.find(bot => bot.profile === profile)?.name ?? fallback ?? profile

export function handoffRowLine(
  profile: string,
  kind: ThreadPresence['kind'],
  records: readonly HandoffRecord[],
  roster: readonly ApexBot[],
  copy: SingleThreadHandoffCopy
): null | string {
  const helping = handoffsTo(profile, records).find(isHandoffInTurn)

  if (helping) {
    const from = nameOf(roster, helping.from.profile, helping.from.name)

    return helping.status === 'waiting'
      ? copy.helpingWaiting(from)
      : copy.helping(from, helping.ask.replace(/\s+/g, ' ').trim())
  }

  const waiting = kind === 'idle' ? handoffsFrom(profile, records).find(isHandoffActive) : undefined

  return waiting ? copy.waitingFor(nameOf(roster, waiting.to)) : null
}

export function useHandoffRowLine(profile: string, kind: ThreadPresence['kind']): null | string {
  const on = useStore($handoffMode)
  const records = useStore($handoffs)
  const roster = useStore($botRoster)
  const copy = useSingleThreadHandoffCopy()

  return on ? handoffRowLine(profile, kind, records, roster, copy) : null
}
