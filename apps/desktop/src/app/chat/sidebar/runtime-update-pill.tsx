import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { AlertTriangle, ChevronRight, Loader2, Sparkles } from '@/lib/icons'
import { $runtimeUpdateApplying, $runtimeUpdateCheck, applyRuntimeUpdate, checkRuntimeUpdate } from '@/store/runtime-update'
import { $shellUpdate } from '@/store/shell-update'

// Silent background-check cadence. The first check waits 30s after mount so it
// never competes with app-boot work (gateway boot, session hydrate); after that
// a low-frequency 12h interval keeps long-lived windows fresh. Check failures
// are fully silent — the store normalizes them to ok:false results and the
// pill simply stays hidden.
const INITIAL_CHECK_DELAY_MS = 30_000
const RECHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

// How long the "update failed, rolled back" notice stays up before the pill
// falls back to the regular offer (the apply mechanism auto-rolls-back, so the
// offer remains valid and clickable again).
const ERROR_NOTICE_MS = 6_000

// Floor between *initial* silent checks across remounts. Collapsing/expanding
// the sidebar remounts the pill; without this every toggle would schedule a
// fresh network check 30s later. Module-level on purpose — it must survive the
// component instance.
const REMOUNT_CHECK_FLOOR_MS = 30 * 60 * 1000

let lastSilentCheckAt = 0

async function runSilentCheck(): Promise<void> {
  lastSilentCheckAt = Date.now()

  // checkRuntimeUpdate never throws (it stores ok:false results instead); the
  // guard is belt-and-braces so a future store change can't turn a background
  // timer tick into an unhandled rejection.
  try {
    await checkRuntimeUpdate()
  } catch {
    // Silent by design: a failed background check must never surface UI.
  }
}

// Sidebar-bottom engine update pill (Codex reference) — rendered directly
// above the account panel. Invisible until a silent background check reports
// updateAvailable; then a compact capsule offers a one-click apply:
//   idle      icon + 「发现新引擎」 + version + chevron  → click applies
//   applying  spinner + 「正在更新引擎…」, disabled
//   error     「更新失败,已回滚」 for a few seconds, then back to idle
// On a successful apply the window reloads (the existing opt-in update
// mechanism requires a reload to drive the bootstrap re-run). All mechanism
// lives in the runtime-update store / IPC bridge; this component only owns
// presentation and the check schedule.
export function RuntimeUpdatePill() {
  const { t } = useI18n()
  const s = t.sidebar.engineUpdate
  const check = useStore($runtimeUpdateCheck)
  const applying = useStore($runtimeUpdateApplying)
  const shellUpdate = useStore($shellUpdate)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const initial = setTimeout(() => {
      if (Date.now() - lastSilentCheckAt >= REMOUNT_CHECK_FLOOR_MS) {
        void runSilentCheck()
      }
    }, INITIAL_CHECK_DELAY_MS)

    const interval = setInterval(() => void runSilentCheck(), RECHECK_INTERVAL_MS)

    return () => {
      clearTimeout(initial)
      clearInterval(interval)
    }
  }, [])

  // Error notice auto-recovers to the regular offer after a few seconds.
  useEffect(() => {
    if (!failed) {
      return
    }

    const timer = setTimeout(() => setFailed(false), ERROR_NOTICE_MS)

    return () => clearTimeout(timer)
  }, [failed])

  // 壳更新胶囊优先:壳包 downloaded 时本胶囊让位(壳更新通常携带引擎 pin
  // bump,重启一次两者一并到位,双胶囊同促只会分流点击)。hooks 都已跑过,
  // 静默检查计划照常滴答,壳装完/让位解除后 offer 立即回来。
  // No offer → nothing at all (the effects above still run, so the silent
  // schedule keeps ticking while the pill is invisible).
  if (shellUpdate?.phase === 'downloaded' || !check?.updateAvailable || !check.latest) {
    return null
  }

  const version = check.latest.version ?? check.latest.key
  const state = applying ? 'applying' : failed ? 'error' : 'idle'

  const handleClick = async () => {
    if (applying || failed) {
      return
    }

    try {
      const result = await applyRuntimeUpdate()

      // On success the pin is re-armed; reload to drive the bootstrap re-run.
      if (result.reloadRequired) {
        window.location.reload()

        return
      }

      // Applied with no reload needed, or already current (stale offer) —
      // re-check so the pill reflects reality (it usually disappears).
      void runSilentCheck()
    } catch {
      // The apply mechanism rolls back on failure (brick-safe); show the
      // transient failure notice, then fall back to the regular offer.
      setFailed(true)
    }
  }

  return (
    <button
      aria-busy={applying || undefined}
      className="p5-update-pill"
      data-state={state}
      disabled={applying}
      onClick={() => void handleClick()}
      type="button"
    >
      <span aria-hidden className="p5-update-pill-icon">
        {applying ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : state === 'error' ? (
          <AlertTriangle className="size-3.5" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
      </span>
      <span className="p5-update-pill-text">
        <span className="p5-update-pill-title">{applying ? s.updating : state === 'error' ? s.failedRolledBack : s.found}</span>
        {state !== 'error' && version ? <span className="p5-update-pill-version">{version}</span> : null}
      </span>
      {state === 'idle' ? <ChevronRight aria-hidden className="p5-update-pill-chevron size-3.5" /> : null}
    </button>
  )
}
