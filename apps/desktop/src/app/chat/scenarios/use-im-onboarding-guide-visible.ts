import type { ChannelStatus } from './use-channel-status'

// hc-554/hc-555 去重 — ConnectionGuide(聊天区顶部「连接一个渠道,分身随处可达」
// 横幅)与 SidebarChannelStatus(侧栏「渠道 · 分身在哪」)在「一个渠道都没绑」的
// 零态下内容重复:同样三个渠道(飞书/微信/手机遥控)、同样的扫码绑定动作,
// 一屏出现两次。两者应互斥:引导横幅显示时侧栏那块隐藏;一旦绑定任意渠道,
// 横幅自动消失、侧栏转为展示真实连接状态(那才是它该做的事)。
//
// 这是两边共用的唯一判据来源——ConnectionGuide 直接用其结果作为显示条件,
// SidebarChannelStatus 取反后叠加在自己原有的 `legs.length === 0` 自闭合之上。
// 别各写一套条件,否则容易出现「两个都不显示」或「又都显示」的缝。
//
// 接收调用方已持有的 ChannelStatus(而不是自己再调一次 useChannelStatus),
// 这样两个组件各自原有的单次桥订阅保持不变,不会因为共享这份判定逻辑而多
// 订阅一次 imEntry.list()/daemon.status()。
export function useImOnboardingGuideVisible(status: ChannelStatus): boolean {
  const legs = [status.feishu, status.weixin, status.phoneRemote]
  const available = legs.filter(leg => leg.available)
  const anyBound = available.some(leg => leg.bound)
  // The IM bridge is the authoritative "connected?" signal; wait for it before
  // deciding so a fast daemon reply can't flash the guide (or hide the sidebar
  // block) for a user who in fact has an IM channel bound, whose bound state
  // the IM bridge hasn't reported yet. Mirrors ConnectionGuide's original gate
  // (see its git history) so extraction doesn't change the anti-flicker timing.
  const imAnswered = status.feishu.available || status.weixin.available

  return imAnswered && available.length > 0 && !anyBound
}
