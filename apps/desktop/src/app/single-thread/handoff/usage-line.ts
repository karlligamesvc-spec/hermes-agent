/**
 * hc-1087 / hc-1090 (多助手二期 R2 / R5): the confirm card's usage line (L6):
 * 「要多跑 1 个回合，按你的套餐额度算 · 本月已用 18%」, a reminder past 80%, and
 * no relay once the allowance is used up. The words and the number are R5's
 * (store/handoff-usage.ts); this only maps them onto the card. Null with relay
 * off, as R5's hook is.
 *
 * A used-up allowance is held back only here and before 「再试一次」
 * ({@link handoffRetryBlocked}): hc-1086's startHandoff and retryHandoff do not
 * look at usage.
 */

import { checkHandoffUsage, type HandoffUsageHint, useHandoffUsageHint } from '@/store/handoff-usage'

export interface HandoffUsageLine {
  text: string
  /** 'warn': past 80% this month (or week); 'blocked': used up — the card cannot start the relay. */
  tone: 'blocked' | 'normal' | 'warn'
  /** Why the relay cannot start (shown when `tone` is 'blocked'). */
  blockedReason: null | string
  /** Past 80%: one sentence under the line. */
  warning: null | string
}

export function usageLineFrom(hint: HandoffUsageHint | null): HandoffUsageLine | null {
  if (!hint) {
    return null
  }

  return {
    blockedReason: hint.start ? null : hint.reason,
    text: hint.line,
    tone: !hint.start ? 'blocked' : hint.level === 'near' ? 'warn' : 'normal',
    warning: hint.warning
  }
}

/** The card's line for a relay of `turns` more turns (its receiver is in the card's title). */
export function useHandoffUsageLine(turns: number): HandoffUsageLine | null {
  return usageLineFrom(useHandoffUsageHint(turns))
}

/**
 * 「再试一次」 runs the relay's turn again without a card: the usage line is read
 * first, and a used-up allowance keeps the relay where it is. The reason, or null
 * to go ahead (relay off: hc-1086 refuses the retry itself).
 */
export async function handoffRetryBlocked(): Promise<null | string> {
  const hint = await checkHandoffUsage(1)

  return hint && !hint.start ? hint.reason : null
}
