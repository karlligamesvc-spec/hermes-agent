import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { DesktopFeishuStatus } from '@/global'
import { useI18n } from '@/i18n'
import { AlertTriangle, Check, ExternalLink, Loader2, MessageCircle, RefreshCw, Trash2 } from '@/lib/icons'
import { notify } from '@/store/notifications'

import { SettingsCategoryHeading } from './env-credentials'

// hc-444: "Connect Feishu" card. The cloud Feishu line is complete (each user
// self-registers their own Feishu app; the credential lives in the cloud). This
// card is the desktop hop: it mirrors the signed-in user's OWN credential down to
// the local runtime so the Feishu adapter + lark doc/drive tools light up.
//
// Three states, driven by main-process status:
//   • not signed in  → prompt to sign in first (sync needs the login JWT).
//   • no cloud entry → open the web binding flow, then sync.
//   • connected      → show the bound agent + a re-sync / disconnect control.
//
// No secret ever reaches this component — status carries only display fields, and
// sync/disconnect happen entirely in the main process.

// True only in the Electron shell where the bridge exists. The web dashboard
// build has no window.hermesDesktop.feishu, so the card renders nothing there.
function feishuBridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.feishu : undefined
}

// hc-190 verdicts that mean the mirrored credential is already known-dead.
const FAILED_STATUSES = new Set(['expired', 'invalid'])

export function FeishuSettings() {
  const { t } = useI18n()
  const copy = t.settings.feishu
  const [status, setStatus] = useState<DesktopFeishuStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const bridge = feishuBridge()

    if (!bridge) {
      setStatus(null)

      return
    }

    try {
      setStatus(await bridge.status())
    } catch {
      // A status read failure just leaves the card in its loading shell — never
      // block the settings page over it.
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Sync fetches + persists the cloud credential and (on success) restarts the
  // backend in the main process, which reloads this window — so we don't need to
  // re-read status here on the connected path. On has_entry=false we open the web
  // binding flow; on needsSignIn we surface the sign-in prompt.
  const handleSync = useCallback(async () => {
    const bridge = feishuBridge()

    if (!bridge || busy) {
      return
    }

    setBusy(true)

    try {
      const result = await bridge.sync()

      if (result.ok && result.hasEntry) {
        notify({ kind: 'success', title: copy.syncedTitle, message: copy.syncedMessage })

        // The main process is tearing down + reloading; keep the spinner until
        // the reload lands.
        return
      }

      if (result.needsSignIn) {
        await refresh()
        notify({ kind: 'info', title: copy.signInFirstTitle, message: copy.signInFirst })

        return
      }

      if (result.ok && !result.hasEntry) {
        // No cloud binding yet — open the web flow and refresh the card.
        await bridge.openBind()
        await refresh()

        return
      }

      notify({ kind: 'error', title: copy.title, message: copy.syncFailed })
    } catch {
      notify({ kind: 'error', title: copy.title, message: copy.syncFailed })
    } finally {
      setBusy(false)
    }
  }, [busy, copy, refresh])

  const handleOpenBind = useCallback(async () => {
    const bridge = feishuBridge()

    if (!bridge) {
      return
    }

    await bridge.openBind()
  }, [])

  const handleDisconnect = useCallback(async () => {
    const bridge = feishuBridge()

    if (!bridge || busy) {
      return
    }

    if (!window.confirm(copy.disconnectConfirm)) {
      return
    }

    setBusy(true)

    try {
      await bridge.disconnect()
      notify({ kind: 'info', title: copy.disconnectedTitle, message: copy.disconnectedMessage })
      // Backend is restarting + reloading the window; spinner stays until then.
    } catch {
      setBusy(false)
    }
  }, [busy, copy])

  // Not the Electron shell (web build) → the bridge is absent; render nothing.
  if (!feishuBridge()) {
    return null
  }

  const connected = Boolean(status?.connected)
  const signedIn = Boolean(status?.signedIn)
  const staleCredential = connected && FAILED_STATUSES.has(status?.credentialStatus ?? '')

  return (
    <section className="mb-5 grid gap-2">
      <SettingsCategoryHeading icon={MessageCircle} title={copy.title} />
      <p className="p5-section-intro -mt-1">{copy.intro}</p>

      {connected ? (
        <div className="grid gap-2 rounded-[8px] border border-border/40 p-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex shrink-0 items-center gap-1 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <Check className="size-3" />
              {copy.connectedTitle}
            </span>
            {staleCredential && (
              <span className="inline-flex shrink-0 items-center gap-1 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                <AlertTriangle className="size-3" />
                {status?.credentialStatus === 'expired' ? copy.statusExpired : copy.statusInvalid}
              </span>
            )}
          </div>
          <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">
            {status?.agentName ? copy.connectedTo(status.agentName) : copy.connectedGeneric}
          </p>
          {staleCredential && (
            <p className="text-[0.68rem] leading-5 text-destructive/80">{copy.statusStale}</p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button disabled={busy} onClick={() => void handleSync()} size="sm" type="button" variant="outline">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {copy.resync}
            </Button>
            <Button
              className="hover:text-destructive"
              disabled={busy}
              onClick={() => void handleDisconnect()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
              {copy.disconnect}
            </Button>
          </div>
        </div>
      ) : !signedIn ? (
        <div className="grid gap-1.5 rounded-[8px] border border-border/40 p-3">
          <div className="text-[length:var(--conversation-text-font-size)] font-medium">{copy.signInFirstTitle}</div>
          <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.signInFirst}</p>
        </div>
      ) : (
        <div className="grid gap-2 rounded-[8px] border border-border/40 p-3">
          <div className="text-[length:var(--conversation-text-font-size)] font-medium">{copy.noEntryTitle}</div>
          <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.noEntry}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button onClick={() => void handleOpenBind()} size="sm" type="button" variant="outline">
              <ExternalLink className="size-3.5" />
              {copy.openBind}
            </Button>
            <Button disabled={busy} onClick={() => void handleSync()} size="sm" type="button" variant="textStrong">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {copy.afterBind}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
