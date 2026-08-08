import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'
import { formatEngineDisplayVersion } from '@/lib/engine-display'
import { CheckCircle2, Download, Loader2 } from '@/lib/icons'
import { $desktopUpdateProgress, applyDesktopUpdates } from '@/store/desktop-update'
import { $runtimeUpdateCheck, checkRuntimeUpdate } from '@/store/runtime-update'
import { $shellUpdate, initShellUpdateSubscription } from '@/store/shell-update'

const INITIAL_CHECK_DELAY_MS = 30_000
const RECHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
const REMOUNT_CHECK_FLOOR_MS = 30 * 60 * 1000

let lastSilentCheckAt = 0

function displayAppVersion(raw: string | null | undefined): string {
  if (!raw) {
    return ''
  }

  return raw.startsWith('v') ? raw : `v${raw}`
}

function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.min(100, Math.round(value)))
}

async function runSilentRuntimeCheck(): Promise<void> {
  lastSilentCheckAt = Date.now()

  try {
    await checkRuntimeUpdate()
  } catch {
    // Update discovery remains silent and fail-open in the sidebar.
  }
}

export function DesktopUpdatePill() {
  const { t } = useI18n()
  const copy = t.sidebar.desktopUpdate
  const shell = useStore($shellUpdate)
  const runtime = useStore($runtimeUpdateCheck)
  const progress = useStore($desktopUpdateProgress)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    initShellUpdateSubscription()

    const initial = window.setTimeout(() => {
      if (Date.now() - lastSilentCheckAt >= REMOUNT_CHECK_FLOOR_MS) {
        void runSilentRuntimeCheck()
      }
    }, INITIAL_CHECK_DELAY_MS)

    const interval = window.setInterval(() => void runSilentRuntimeCheck(), RECHECK_INTERVAL_MS)

    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [])

  const shellPreparing = shell?.phase === 'available' || shell?.phase === 'downloading'
  const shellReady = shell?.phase === 'downloaded'
  const runtimeReady = Boolean(runtime?.updateAvailable)
  const runtimeWaitsForShell = Boolean(runtime?.desktopUpgradeRequired)
  const shellVersion = displayAppVersion(shell?.version)
  const rawRuntimeVersion = runtime?.latest?.version ?? runtime?.latest?.key ?? ''

  const runtimeVersion = rawRuntimeVersion
    ? formatEngineDisplayVersion(rawRuntimeVersion, null, t.common.engineVersionPrefix)
    : ''

  if (shellPreparing) {
    const percent = clampPercent(shell?.percent)

    return (
      <div className="p5-update-pill p5-update-pill--stack" data-state="downloading" data-testid="desktop-update-pill">
        <div className="p5-update-pill-row">
          <span aria-hidden className="p5-update-pill-icon">
            {shell?.phase === 'downloading' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
          </span>
          <span className="p5-update-pill-text">
            <span className="p5-update-pill-title">{copy.preparingTitle(shellVersion)}</span>
            <span className="p5-update-pill-notes">
              {percent === null ? t.sidebar.shellUpdate.downloadingInBackground : copy.downloadedPercent(percent)}
            </span>
          </span>
        </div>
        <div
          aria-hidden
          className="p5-update-pill-progress"
          data-indeterminate={percent === null ? 'true' : undefined}
          data-testid="desktop-update-progress"
        >
          <span className="p5-update-pill-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
        </div>
      </div>
    )
  }

  const actionable = shellReady || runtimeReady

  if (!actionable || (runtimeWaitsForShell && !shellReady)) {
    return null
  }

  const detail = shellReady && (runtimeReady || runtimeWaitsForShell)
    ? copy.appAndEngine(shellVersion, runtimeVersion)
    : shellReady
      ? copy.appOnly(shellVersion)
      : copy.engineOnly(runtimeVersion)

  return (
    <>
      <div className="p5-update-pill p5-update-pill--stack" data-state="ready" data-testid="desktop-update-pill">
        <div className="p5-update-pill-row">
          <span aria-hidden className="p5-update-pill-icon p5-update-pill-icon--ready">
            <CheckCircle2 className="size-3.5" />
          </span>
          <span className="p5-update-pill-text">
            <span className="p5-update-pill-title">{copy.readyTitle}</span>
            <span className="p5-update-pill-notes">{detail}</span>
          </span>
        </div>
        <Button
          aria-busy={progress.active || undefined}
          className="w-full"
          disabled={progress.active}
          onClick={() => setConfirmOpen(true)}
          size="sm"
          type="button"
        >
          {progress.active ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {progress.active ? copy.installing : copy.installRestart}
        </Button>
      </div>

      <ConfirmDialog
        busyLabel={copy.installing}
        cancelLabel={t.common.cancel}
        confirmLabel={copy.confirmApply}
        description={copy.confirmBody}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => applyDesktopUpdates()}
        open={confirmOpen}
        title={copy.confirmTitle}
      />
    </>
  )
}
