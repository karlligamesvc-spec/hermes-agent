import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import type { DesktopImEntryBinding } from '@/global'
import { useI18n } from '@/i18n'
import { Link2 } from '@/lib/icons'

import { IM_ENTRY_ROUTE } from '../routes'

import { SettingsCategoryHeading } from './env-credentials'

// hc-417 收口: the /im-entry route (scan-to-bind an IM channel to this
// machine's assistant) previously had exactly one entry point — the ⌘K
// command palette's "nav-im-entry" — so most users never found it. This card
// is the discoverable entry: a read-only status summary (via the same
// window.hermesDesktop.imEntry bridge the full page uses) plus a button that
// navigates to the full page. It owns no binding logic of its own — connect /
// unbind still only happen on /im-entry.
//
// Channel-neutral by design: copy never names a specific platform (飞书 is
// merely the first channel wired end-to-end; 钉钉 / 微信 / QQ / 企微 follow).

// True only in the Electron shell where the bridge exists. The web dashboard
// build has no window.hermesDesktop.imEntry, so the card renders nothing there
// — matching FeishuSettings / LocalAgentSettings.
function imEntryBridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.imEntry : undefined
}

// Pure so the count → copy mapping is unit-testable without mounting the
// bridge. `null` means "still loading" (bridge present, first list() pending).
export function imEntrySummaryCopy(
  bound: DesktopImEntryBinding[] | null,
  copy: { boundEmpty: string; loading: string; settingsCard: { boundSummary: (count: number) => string } }
): string {
  if (bound === null) {
    return copy.loading
  }

  return bound.length > 0 ? copy.settingsCard.boundSummary(bound.length) : copy.boundEmpty
}

export function ImEntrySettings() {
  const { t } = useI18n()
  const copy = t.imEntry
  const navigate = useNavigate()
  const [bound, setBound] = useState<DesktopImEntryBinding[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const bridge = imEntryBridge()

    if (!bridge) {
      return
    }

    bridge
      .list()
      .then(result => {
        if (!cancelled) {
          setBound(result.channels)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBound([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Not the Electron shell (web build) → the bridge is absent; render nothing.
  if (!imEntryBridge()) {
    return null
  }

  return (
    <section className="mb-5 grid gap-2">
      <SettingsCategoryHeading icon={Link2} title={copy.title} />
      <p className="p5-section-intro -mt-1">{copy.intro}</p>

      <div className="flex items-center justify-between gap-3 rounded-[8px] border border-border/40 p-3">
        <span className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">
          {imEntrySummaryCopy(bound, copy)}
        </span>
        <Button onClick={() => navigate(IM_ENTRY_ROUTE)} size="sm" type="button" variant="outline">
          {copy.settingsCard.openCta}
        </Button>
      </div>
    </section>
  )
}
