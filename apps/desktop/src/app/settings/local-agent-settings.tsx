import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { DesktopDaemonStatus } from '@/global'
import { useI18n } from '@/i18n'
import { AlertTriangle, Cpu, Loader2, Trash2 } from '@/lib/icons'
import { notify } from '@/store/notifications'
import { $runtimeVersion, loadRuntimeVersion } from '@/store/runtime-update'

import { SettingsCategoryHeading } from './env-credentials'

// hc-533 本机 Agent 调度 — the A2A daemon leg's minimal control surface. A single
// block: a toggle (default OFF / dormant), a device-name field, a one-line
// connection status, and an unregister button. No device list / management panel
// (极简纪律: the user never sees a "device manager"). The daemon itself lives in
// the main process (electron/apex-daemon.cjs + main.cjs); this only reads status
// and relays the four control actions. No secret ever reaches this component.

// True only in the Electron shell where the bridge exists; the web dashboard
// build has no window.hermesDesktop.daemon, so the block renders nothing there.
function daemonBridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.daemon : undefined
}

export function LocalAgentSettings() {
  const { t } = useI18n()
  const copy = t.settings.localAgent
  const [status, setStatus] = useState<DesktopDaemonStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  // hc-532 (gate 1): the daemon's tool leg silently fails on an engine older
  // than THIS shell's declared minimum (the A-10 failure mode). Read the
  // installed engine version (local marker, no network) and surface an explicit
  // error-tone warning here so the silent failure becomes visible — especially
  // once the toggle is on. meetsMinEngine fails open (false only when positively
  // behind); a missing bridge / older marker leaves it undefined = no warning.
  const runtimeVersion = useStore($runtimeVersion)
  const engineOutdated = runtimeVersion?.meetsMinEngine === false
  const minEngineVersion = runtimeVersion?.minEngineVersion ?? null

  useEffect(() => {
    void loadRuntimeVersion()
  }, [])

  const applyStatus = useCallback((next: DesktopDaemonStatus | null) => {
    setStatus(next)

    if (next) {
      setNameDraft(next.deviceName)
    }
  }, [])

  const refresh = useCallback(async () => {
    const bridge = daemonBridge()

    if (!bridge) {
      setStatus(null)

      return
    }

    try {
      applyStatus(await bridge.status())
    } catch {
      // A status read failure just leaves the block in its loading shell.
      setStatus(null)
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Live status pushed from main on connection transitions (connecting → online
  // → offline …). Keeps the one-line status honest without polling.
  useEffect(() => {
    const bridge = daemonBridge()

    if (!bridge?.onStatus) {
      return
    }

    return bridge.onStatus(next => {
      setStatus(next)
    })
  }, [])

  const handleToggle = useCallback(
    async (on: boolean) => {
      const bridge = daemonBridge()

      if (!bridge || busy) {
        return
      }

      setBusy(true)

      try {
        const result = await bridge.setEnabled(on)
        applyStatus(result.snapshot)

        if (!result.ok && result.message === 'KEYCHAIN_UNAVAILABLE') {
          notify({ kind: 'error', title: copy.title, message: copy.enableFailed })
        }
      } catch {
        notify({ kind: 'error', title: copy.title, message: copy.enableFailed })
      } finally {
        setBusy(false)
      }
    },
    [applyStatus, busy, copy]
  )

  const handleSaveName = useCallback(async () => {
    const bridge = daemonBridge()

    if (!bridge) {
      return
    }

    const trimmed = nameDraft.trim()

    if (!trimmed || trimmed === status?.deviceName) {
      return
    }

    try {
      const result = await bridge.setDeviceName(trimmed)
      applyStatus(result.snapshot)
      notify({ kind: 'success', title: copy.title, message: copy.saved })
    } catch {
      // Non-fatal — the field keeps the draft; the user can retry.
    }
  }, [applyStatus, copy, nameDraft, status])

  const handleUnregister = useCallback(async () => {
    const bridge = daemonBridge()

    if (!bridge || busy) {
      return
    }

    if (!window.confirm(copy.unregisterConfirm)) {
      return
    }

    setBusy(true)

    try {
      const result = await bridge.unregister()
      applyStatus(result.snapshot)
    } catch {
      // best effort
    } finally {
      setBusy(false)
    }
  }, [applyStatus, busy, copy])

  const statusLine = useMemo(() => {
    switch (status?.status) {
      case 'online':
        return { text: copy.statusOnline, tone: 'text-primary' }

      case 'connecting':
        return { text: copy.statusConnecting, tone: 'text-muted-foreground' }

      case 'offline':
        return { text: copy.statusOffline, tone: 'text-muted-foreground' }

      case 'error':
        return { text: copy.statusError, tone: 'text-destructive' }

      default:
        return { text: copy.statusDormant, tone: 'text-muted-foreground' }
    }
  }, [copy, status])

  // Not the Electron shell (web build) → the bridge is absent; render nothing.
  if (!daemonBridge()) {
    return null
  }

  const enabled = Boolean(status?.enabled)

  return (
    <section className="mb-5 grid gap-2">
      <SettingsCategoryHeading icon={Cpu} title={copy.title} />
      <p className="p5-section-intro -mt-1">{copy.intro}</p>

      <div className="grid gap-3 rounded-[8px] border border-border/40 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <div className="text-[length:var(--conversation-text-font-size)] font-medium">{copy.enableLabel}</div>
            <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.enableHint}</p>
          </div>
          <Switch aria-label={copy.enableLabel} checked={enabled} disabled={busy} onCheckedChange={on => void handleToggle(on)} />
        </div>

        {engineOutdated && minEngineVersion && (
          <div
            className="flex items-start gap-2 rounded-[6px] border border-destructive/40 px-3 py-2 text-destructive"
            data-testid="daemon-engine-outdated"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p className="text-[length:var(--conversation-caption-font-size)]">{copy.engineOutdated(minEngineVersion)}</p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.statusLabel}:</span>
          <span className={`text-[length:var(--conversation-caption-font-size)] font-medium ${statusLine.tone}`}>
            {busy ? <Loader2 className="mr-1 inline size-3.5 animate-spin" /> : null}
            {statusLine.text}
          </span>
        </div>

        <label className="grid gap-1">
          <span className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.deviceNameLabel}</span>
          <Input
            onBlur={() => void handleSaveName()}
            onChange={event => setNameDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            placeholder={copy.deviceNamePlaceholder}
            value={nameDraft}
          />
        </label>

        {status?.registered ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              className="hover:text-destructive"
              disabled={busy}
              onClick={() => void handleUnregister()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
              {copy.unregister}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
