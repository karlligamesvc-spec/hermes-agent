import { useEffect, useState } from 'react'

import type { DesktopDaemonStatus } from '@/global'
import { useI18n } from '@/i18n'

// hc-555 显化 — the phone-remote (/cc) direct-connect banner. When the desktop
// daemon is actively online (a phone is remote-controlling this machine via a
// Feishu /cc session), a persistent live strip sits at the top of the
// conversation so the control session "has a name and a face". It self-gates to
// nothing when the daemon bridge is absent (web / older main) or not online, so
// the common path renders zero extra chrome and a normal chat can never regress.

function daemonBridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.daemon : undefined
}

export function DirectConnectBanner() {
  const { t } = useI18n()
  const s = t.scenarios
  const [status, setStatus] = useState<DesktopDaemonStatus | null>(null)

  useEffect(() => {
    const bridge = daemonBridge()
    let cancelled = false

    const apply = (next: DesktopDaemonStatus | null) => {
      if (!cancelled) {
        setStatus(next)
      }
    }

    if (bridge?.status) {
      void bridge.status().then(apply).catch(() => undefined)
    }

    const unsubscribe = bridge?.onStatus?.(apply)

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  // Only surface while a phone is actively controlling this machine right now —
  // an enabled-but-dormant daemon stays silent (the sidebar dot covers that).
  if (status?.status !== 'online') {
    return null
  }

  const device = status.deviceName?.trim()

  return (
    <div
      className="flex items-center gap-2 border-b border-(--ui-stroke-tertiary) bg-primary/5 px-4 py-1.5 text-xs text-(--ui-text-secondary)"
      role="status"
    >
      <span
        aria-hidden="true"
        className="inline-block size-1.5 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse"
      />
      <span aria-hidden="true">📱</span>
      <span className="min-w-0 truncate">
        {s.remoteBannerTitle}
        {device ? ` · ${device}` : ''}
      </span>
      <span className="shrink-0 text-(--ui-text-tertiary)">· {s.remoteBannerApproval}</span>
    </div>
  )
}
