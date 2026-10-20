/**
 * hc-995 (Q10, Kael 2026-10-20): which in-app UI tips an APEX account gets.
 *
 * The rotation's catalog introduces a developer's Hermes: a terminal and a
 * working directory per chat, skills as instruction files, Telegram / Discord /
 * Slack, cron expressions, profiles with their own keys, slash commands, the
 * terminal pane, and a local-model campaign; several name Hermes outright. An
 * APEX account (managed path, signed in) is a creator, so its rotation offers
 * only the tips listed here, none today, and never the local-setup campaign. A
 * tip upstream adds later stays out until someone lists it here.
 *
 * Not affected: creator tips (store/creator-tips.ts) and the agent's own pointer
 * tips (the `show_tip` tool).
 */

import type { DesktopAuthState } from '@/store/auth'

import type { TipDef, TipId } from './catalog'

export const APEX_ROTATION_TIP_IDS: ReadonlySet<TipId> = new Set<TipId>()

/** The same account test the tier mode uses (store/model-tiers.ts), minus the tier switch. */
export function isApexAccount(state: Pick<DesktopAuthState, 'enabled' | 'status'>): boolean {
  return state.enabled === true && (state.status === 'signed-in' || state.status === 'expired')
}

/** The catalog tips this account's rotation may offer. */
export function rotationTips(catalog: readonly TipDef[], apexAccount: boolean): readonly TipDef[] {
  return apexAccount ? catalog.filter(tip => APEX_ROTATION_TIP_IDS.has(tip.id)) : catalog
}
