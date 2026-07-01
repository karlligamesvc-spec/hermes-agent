import type { MessagingPlatformInfo } from '@/types/hermes'

// ApexNodes is a China-first managed product, so the 消息平台 (messaging) picker
// shows ONLY channels usable from mainland China. This is an ALLOWLIST: the
// domestic set is small and closed (the runtime Platform enum in
// gateway/config.py), while the foreign + plugin set is large and open-ended
// (Telegram / WhatsApp / Line / Google Chat / Teams / IRC / Ntfy / Simplex / …,
// several of them not even in the core enum). A denylist can't keep up — a new
// foreign/plugin platform silently leaks in — so we list the keepers instead:
// anything not enumerated here (including future foreign platforms) is hidden.
//
// Kept: domestic IMs (钉钉 / 飞书·Lark / 企业微信 ×2 / 个人微信 / QQ / 元宝) plus
// the region-neutral endpoints (Email / API server / Webhook) that work anywhere.
//
// Display-only: the runtime platform adapters (gateway/platforms/*.py) are
// untouched — a hidden platform is simply not offered in the desktop UI.
//
// Ids are the runtime Platform enum values (gateway/config.py); matched
// case-insensitively against the id the desktop receives. To surface a new
// domestic platform, add its runtime id here.
export const DOMESTIC_PLATFORM_IDS: ReadonlySet<string> = new Set([
  'dingtalk', // 钉钉
  'feishu', // 飞书 / Lark
  'wecom', // 企业微信 (群机器人)
  'wecom_callback', // 企业微信 (应用)
  'weixin', // 个人微信 WeChat (Personal)
  'qqbot', // QQ Bot
  'yuanbao', // 元宝 (腾讯)
  'email', // region-neutral
  'api_server', // region-neutral programmatic endpoint
  'webhook' // region-neutral programmatic endpoint
])

/** True when a messaging platform is usable from mainland China and should show
 *  in the picker (i.e. it is on the domestic allowlist). Matched
 *  case-insensitively on the runtime id. */
export function isDomesticPlatform(id: string): boolean {
  return DOMESTIC_PLATFORM_IDS.has(String(id || '').trim().toLowerCase())
}

/** Keep only the messaging platforms the China-first picker should show. Order
 *  is preserved; runtime adapters for hidden platforms remain fully intact. */
export function filterDomesticPlatforms(
  platforms: MessagingPlatformInfo[]
): MessagingPlatformInfo[] {
  return platforms.filter(platform => isDomesticPlatform(platform.id))
}
