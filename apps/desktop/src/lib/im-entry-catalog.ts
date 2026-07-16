// hc-417 "IM 入口" channel catalog — the structural facts about each IM platform
// the user can connect their local agent to. Display strings (name / tagline /
// binding copy) live in i18n (t.imEntry.channels[id]); this holds ONLY structure
// so a channel is described in exactly one place.
//
// `id` matches the runtime Platform enum value (gateway/config.py) so the live
// connection state from /api/messaging/platforms lines up by id, and the same id
// is what the main-process pipeline (electron/apex-im-entry.cjs) binds/injects.
//
// ── Rollout (per the hc-417 spike / PM) ─────────────────────────────────────
// 飞书 (hc-417) and 个人微信 (hc-538) are available: the cloud issues an
// INDEPENDENT bot per channel via a device-code / QR flow, whose delivery fits a
// local agent with no public IP. 钉钉 / QQ / 企业微信 follow. Until a channel is
// wired end-to-end it stays `available:false` ("即将支持", disabled) so the page
// never offers a flow that can't complete.

// Two binding templates, chosen per channel:
//   • 'device-code' — scan a QR (or open a link) and confirm; zero fields typed.
//   • 'paste-code'  — paste one code the platform gives you (advanced fields are
//                     tucked behind a disclosure so the default stays one action).
export type ImEntryBindingKind = 'device-code' | 'paste-code'

export interface ImEntryChannel {
  /** Runtime Platform id — the join key across UI, pipeline and live status. */
  id: string
  /** Brand id for PlatformAvatar (reuses messaging/platform-icon.tsx glyphs). */
  brand: string
  /** Which binding template this channel uses when it becomes available. */
  bindingKind: ImEntryBindingKind
  /** True once the channel is wired end-to-end; false renders "即将支持". */
  available: boolean
}

// Order = the rollout priority the cards render in (available first: 飞书 → 个微,
// then the coming-soon queue in PM's stated order: 钉钉 → QQ → 企微).
export const IM_ENTRY_CHANNELS: readonly ImEntryChannel[] = [
  { id: 'feishu', brand: 'feishu', bindingKind: 'device-code', available: true },
  { id: 'weixin', brand: 'weixin', bindingKind: 'device-code', available: true },
  { id: 'dingtalk', brand: 'dingtalk', bindingKind: 'paste-code', available: false },
  { id: 'qqbot', brand: 'qqbot', bindingKind: 'device-code', available: false },
  { id: 'wecom', brand: 'wecom', bindingKind: 'paste-code', available: false }
] as const

const CHANNEL_BY_ID: ReadonlyMap<string, ImEntryChannel> = new Map(
  IM_ENTRY_CHANNELS.map(channel => [channel.id, channel])
)

/** The channel descriptor for an id, or undefined for an unknown id. */
export function imEntryChannel(id: string): ImEntryChannel | undefined {
  return CHANNEL_BY_ID.get(id)
}

/** True when a channel is wired end-to-end and can start a real binding flow. */
export function isImEntryChannelAvailable(id: string): boolean {
  return Boolean(CHANNEL_BY_ID.get(id)?.available)
}
