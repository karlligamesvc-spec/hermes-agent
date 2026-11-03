import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { DesktopShellUpdateState } from '@/global'
import { useI18n } from '@/i18n'
import { useDesktopUpdateCopy } from '@/i18n/desktop-update'
import { formatEngineDisplayVersion } from '@/lib/engine-display'
import { CheckCircle2, Download, Loader2 } from '@/lib/icons'
import { $desktopUpdateProgress, applyDesktopUpdates } from '@/store/desktop-update'
import { $runtimeUpdateCheck, checkRuntimeUpdate } from '@/store/runtime-update'
import { $shellUpdate, initShellUpdateSubscription } from '@/store/shell-update'
import { $runtimeUpdateWait, desktopUpdateWait } from '@/store/update-wait'

import { DesktopUpdateConfirmDialog } from './desktop-update-confirm'
import { EngineHoldersNote, waitHolders } from './engine-holders-note'

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

/** hc-1030: while a requested install waits for idle, say what it waits for. */
function DesktopUpdateDeferredNote({ shell }: { shell: DesktopShellUpdateState | null }) {
  const copy = useDesktopUpdateCopy()
  // hc-1117: an engine switch that waits says so here too, like the app install.
  const wait = desktopUpdateWait(shell, useStore($runtimeUpdateWait))
  // hc-1094: engine holders the gate named are said by kind, and APEX's own leftovers can be ended.
  const holders = waitHolders(wait)

  if (holders) {
    return (
      <EngineHoldersNote
        className="p5-update-pill-deferred"
        holders={holders}
        onEnded={() => applyDesktopUpdates()}
        then="install"
      />
    )
  }

  if (!wait) {
    return null
  }

  return (
    <span className="p5-update-pill-deferred" data-testid="desktop-update-deferred">
      {copy.deferred[wait.reason]}
    </span>
  )
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
            <DesktopUpdateDeferredNote shell={shell} />
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

      <DesktopUpdateConfirmDialog apply={applyDesktopUpdates} onClose={() => setConfirmOpen(false)} open={confirmOpen} />
    </>
  )
}
