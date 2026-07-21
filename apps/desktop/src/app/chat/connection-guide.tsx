import { useNavigate } from 'react-router-dom'

import { StatusDot } from '@/components/status-dot'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { IM_ENTRY_ROUTE, SETTINGS_ROUTE } from '../routes'

import { useChannelStatus } from './scenarios/use-channel-status'

// hc-555 显化 — connection-guidance for the not-yet-connected. A fuller
// counterpart to the compact sidebar / zero-state strips (#145): when the user
// has connected NO channel yet, it lists each connectable channel with its
// tagline + a connect CTA into the full binding flow (/im-entry, or /settings
// for phone-remote). It self-gates to nothing the moment any channel is
// connected — or when no channel bridge has answered (web / older main / still
// loading) — so it is pure first-run onboarding and never nags a connected user.

export function ConnectionGuide() {
  const { t } = useI18n()
  const s = t.scenarios
  const status = useChannelStatus()
  const navigate = useNavigate()

  const legs = [
    {
      key: 'feishu',
      leg: status.feishu,
      name: t.imEntry.channels.feishu?.name ?? '飞书',
      route: IM_ENTRY_ROUTE,
      tagline: t.imEntry.channels.feishu?.tagline ?? ''
    },
    {
      key: 'weixin',
      leg: status.weixin,
      name: t.imEntry.channels.weixin?.name ?? '微信',
      route: IM_ENTRY_ROUTE,
      tagline: t.imEntry.channels.weixin?.tagline ?? ''
    },
    {
      key: 'phone',
      leg: status.phoneRemote,
      name: s.phoneRemote,
      route: SETTINGS_ROUTE,
      tagline: s.remoteOn
    }
  ]

  const available = legs.filter(entry => entry.leg.available)
  const anyBound = available.some(entry => entry.leg.bound)
  // The IM bridge is the authoritative "connected?" signal; wait for it before
  // showing so a fast daemon reply can't flash the guide at a user who in fact
  // has an IM channel bound (whose bound state the IM bridge hasn't reported yet).
  const imAnswered = status.feishu.available || status.weixin.available

  // Onboarding only: shown only once the IM bridge has answered and reports no
  // channel connected — hidden on web / older main and the moment any is bound.
  if (!imAnswered || available.length === 0 || anyBound) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-4 py-3">
      <div className="text-xs font-medium text-(--ui-text-secondary)">{s.guideTitle}</div>
      <div className="flex flex-col gap-1">
        {available.map(entry => (
          <button
            className={cn(
              'flex items-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) px-2.5 py-1.5 text-left',
              'hover:border-(--ui-stroke-secondary) hover:text-foreground'
            )}
            key={entry.key}
            onClick={() => navigate(entry.route)}
            type="button"
          >
            <StatusDot tone="muted" />
            <span className="shrink-0 text-xs font-medium text-(--ui-text-secondary)">{entry.name}</span>
            <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-(--ui-text-tertiary)">
              {entry.tagline}
            </span>
            <span className="shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)">{s.bindCta}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
