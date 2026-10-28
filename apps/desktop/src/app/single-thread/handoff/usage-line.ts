/**
 * hc-1087 / hc-1090 (多助手二期 R2 / R5): the confirm card's usage line (L6):
 * 「剪辑助手要多跑 1 个回合，按你的套餐额度算 · 本月已用 18%」, a reminder past
 * 80%, and no relay once the allowance is used up.
 *
 * R5 owns what this says; until its line lands this is the placeholder the
 * card reads: the turns only, nothing withheld.
 */

import { useSingleThreadHandoffCopy } from '@/i18n/single-thread-handoff'

export interface HandoffUsageLine {
  text: string
  /** 'warn': past 80% this month; 'blocked': used up — the card cannot start the relay. */
  tone: 'blocked' | 'normal' | 'warn'
  /** Why the relay cannot start (shown when `tone` is 'blocked'). */
  blockedReason: null | string
}

export function useHandoffUsageLine(turns: number, receiverName: string): HandoffUsageLine | null {
  const copy = useSingleThreadHandoffCopy()

  return { blockedReason: null, text: copy.turnsLine(receiverName, turns), tone: 'normal' }
}
