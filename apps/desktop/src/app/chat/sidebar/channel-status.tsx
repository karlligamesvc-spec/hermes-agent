import { useNavigate } from 'react-router'

import { StatusDot } from '@/components/status-dot'
import { useI18n } from '@/i18n'

import { IM_ENTRY_ROUTE, SETTINGS_ROUTE } from '../../routes'
import { useChannelStatus } from '../scenarios/use-channel-status'

/**
 * hc-554 显化 — "渠道 · 分身在哪": a compact channel-presence group above the
 * account row (Feishu / WeChat / phone-remote). A bound leg shows a green dot +
 * its live label; an unbound one shows a muted dot + a guide label and links to
 * its connect surface. Self-gates to nothing when no channel bridge exists
 * (web build / older main), matching the footer's other self-gating pills.
 *
 * Permanent whether or not anything is bound (hc-590). It used to suppress
 * itself while the first-run ConnectionGuide banner was up, so one screen would
 * not list the same three channels twice. That banner is gone — it squatted on
 * the main content of every unconnected user — so this block is back to being
 * what it always was: the standing answer to "where does my assistant live, and
 * how do I put it somewhere else". Suppressing it now would leave a first-run
 * user with one entry point instead of two; channel-reach.test.tsx pins both.
 */
export function SidebarChannelStatus() {
  const { t } = useI18n()
  const s = t.scenarios
  const status = useChannelStatus()
  const navigate = useNavigate()

  const legs = [
    {
      boundLabel: t.imEntry.liveState.connected,
      guideLabel: s.bindCta,
      key: 'feishu',
      leg: status.feishu,
      name: t.imEntry.channels.feishu?.name ?? '飞书',
      route: IM_ENTRY_ROUTE
    },
    {
      boundLabel: t.imEntry.liveState.connected,
      guideLabel: s.bindCta,
      key: 'weixin',
      leg: status.weixin,
      name: t.imEntry.channels.weixin?.name ?? '微信',
      route: IM_ENTRY_ROUTE
    },
    {
      boundLabel: s.remoteOn,
      guideLabel: t.common.off,
      key: 'phone',
      leg: status.phoneRemote,
      name: s.phoneRemote,
      route: SETTINGS_ROUTE
    }
  ].filter(entry => entry.leg.available)

  if (legs.length === 0) {
    return null
  }

  return (
    <div className="pb-1 pt-1">
      <div className="px-1.5 pb-0.5 text-[0.625rem] uppercase tracking-[0.04em] text-(--ui-text-tertiary)">
        {s.channelsTitle}
      </div>
      {legs.map(entry => (
        <button
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-xs text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          key={entry.key}
          onClick={() => navigate(entry.route)}
          type="button"
        >
          <StatusDot tone={entry.leg.bound ? 'good' : 'muted'} />
          <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
          <span className="shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)">
            {entry.leg.bound ? entry.boundLabel : entry.guideLabel}
          </span>
        </button>
      ))}
    </div>
  )
}
