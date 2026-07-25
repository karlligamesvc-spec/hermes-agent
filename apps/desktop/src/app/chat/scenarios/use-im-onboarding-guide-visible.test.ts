import { describe, expect, it } from 'vitest'

import type { ChannelStatus } from './use-channel-status'
import { useImOnboardingGuideVisible } from './use-im-onboarding-guide-visible'

function leg(available: boolean, bound: boolean) {
  return { available, bound }
}

function statusOf(overrides: Partial<ChannelStatus>): ChannelStatus {
  return {
    feishu: leg(false, false),
    weixin: leg(false, false),
    phoneRemote: leg(false, false),
    ...overrides
  }
}

// Pure derivation over ChannelStatus — no hooks involved, so calling it
// directly (outside a component) exercises every branch precisely.
describe('useImOnboardingGuideVisible', () => {
  it('is false before the IM bridge answers, even if the daemon already reports an available/bound leg', () => {
    // hc589 acceptance state ③: boot instant — neither feishu nor weixin
    // available yet. Must stay false regardless of phoneRemote so neither
    // ConnectionGuide nor the negated SidebarChannelStatus gate flashes.
    expect(useImOnboardingGuideVisible(statusOf({ phoneRemote: leg(true, true) }))).toBe(false)
    expect(useImOnboardingGuideVisible(statusOf({ phoneRemote: leg(true, false) }))).toBe(false)
  })

  it('is true once the IM bridge answers with channels available and none bound', () => {
    // hc589 acceptance state ①: zero binds, bridge answered.
    expect(useImOnboardingGuideVisible(statusOf({ feishu: leg(true, false), weixin: leg(true, false) }))).toBe(true)
    // Answered via weixin alone is enough to count as "answered".
    expect(useImOnboardingGuideVisible(statusOf({ weixin: leg(true, false) }))).toBe(true)
  })

  it('is false once any available leg is bound, regardless of which one', () => {
    // hc589 acceptance state ②: any channel bound.
    expect(useImOnboardingGuideVisible(statusOf({ feishu: leg(true, true), weixin: leg(true, false) }))).toBe(false)
    expect(
      useImOnboardingGuideVisible(
        statusOf({ feishu: leg(true, false), weixin: leg(true, false), phoneRemote: leg(true, true) })
      )
    ).toBe(false)
  })

  it('is false when nothing is available anywhere (default/INITIAL status)', () => {
    // Degenerate case: bridge object present yet nothing available anywhere —
    // imAnswered requires feishu/weixin availability, so this cannot happen in
    // practice, but the function must still resolve to false rather than throw.
    expect(useImOnboardingGuideVisible(statusOf({}))).toBe(false)
  })
})
