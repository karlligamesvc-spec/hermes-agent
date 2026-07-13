/**
 * Desktop update store. Tracks the connected (remote) backend's distance from
 * its target branch, surfaces it as an ambient pill, and orchestrates its
 * apply flow. Also publishes the running desktop shell's own version
 * ($desktopVersion) for the About panel.
 *
 * hc-475 follow-up: the legacy client self-rebuild plane (git-pull +
 * `hermes update` + `hermes desktop --build-only`) has been physically
 * removed from this store and its overlay — apps/desktop/electron/main.cjs
 * already hard-disables that plane for packaged builds (hc-475 F4: IS_PACKAGED
 * -> applyUpdates refuses / checkUpdates reports supported:false), and this
 * file no longer has any UI entry point that calls into it. main.cjs /
 * preload.cjs are untouched — the underlying `hermes:updates:*` IPC channels
 * still exist (dev/non-packaged use is intentionally left reachable at that
 * layer), they're just no longer wired to any renderer state or component.
 */

import { atom } from 'nanostores'

import type {
  DesktopUpdateApplyResult,
  DesktopUpdateStage,
  DesktopUpdateStatus,
  DesktopVersionInfo
} from '@/global'
import { checkHermesUpdate, getActionStatus, updateHermes } from '@/hermes'
import { translateNow } from '@/i18n'
import { persistString, storedString } from '@/lib/storage'
import { dismissNotification, notify } from '@/store/notifications'
import { $connection } from '@/store/session'
import type { BackendUpdateCheckResponse } from '@/types/hermes'

export interface UpdateApplyState {
  applying: boolean
  stage: DesktopUpdateStage
  message: string
  percent: number | null
  error: string | null
  /** When the stage is 'manual': the exact command the user should run
   *  (CLI install with no staged updater). */
  command: string | null
  log: readonly { stage: DesktopUpdateStage; message: string; at: number }[]
}

const IDLE: UpdateApplyState = {
  applying: false,
  stage: 'idle',
  message: '',
  percent: null,
  error: null,
  command: null,
  log: []
}

export const $desktopVersion = atom<DesktopVersionInfo | null>(null)
export const $updateOverlayOpen = atom<boolean>(false)

export const $backendUpdateStatus = atom<DesktopUpdateStatus | null>(null)
export const $backendUpdateApply = atom<UpdateApplyState>(IDLE)
export const $backendUpdateChecking = atom<boolean>(false)

export const setUpdateOverlayOpen = (open: boolean) => $updateOverlayOpen.set(open)

/** Open the updates overlay for the connected backend and kick off a check.
 *  The overlay only ever targets the backend now (see file header) — this is
 *  the single entry point into it, called both from the "Check for Updates…"
 *  menu path (openUpdatesWindow, gated on remote mode) and directly from the
 *  statusbar's backend-version pill (already only rendered in remote mode). */
export const openBackendUpdateOverlay = () => {
  $updateOverlayOpen.set(true)
  void checkBackendUpdates()
}

export const resetUpdateApplyState = () => {
  $backendUpdateApply.set(IDLE)
}

const UPDATE_TOAST_ID = 'desktop-update-available'
// Time-based snooze instead of per-sha dismissal: this repo lands ~100 commits
// a day, so a "don't show this exact sha again" guard re-popped the toast on
// every new commit. We instead suppress the toast for a cooldown window that
// (re)starts whenever the user closes it.
const UPDATE_TOAST_SNOOZE_KEY = 'hermes:update-toast-snooze-until'
const UPDATE_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function snoozeUpdateToast(): void {
  persistString(UPDATE_TOAST_SNOOZE_KEY, String(Date.now() + UPDATE_TOAST_COOLDOWN_MS))
}

function isUpdateToastSnoozed(): boolean {
  const until = Number(storedString(UPDATE_TOAST_SNOOZE_KEY) || 0)

  return Number.isFinite(until) && Date.now() < until
}

// Must match tui_gateway's DESKTOP_BACKEND_CONTRACT that this build was written
// against. The backend reports its own value in session runtime info; a lower
// value (or none — a pre-GUI checkout) means GUI<->backend skew.
// v2: requires the file.attach RPC (remote-gateway non-image file upload).
const REQUIRED_BACKEND_CONTRACT = 2
const SKEW_TOAST_ID = 'backend-contract-skew'
// The contract check runs on every session.resume (applyRuntimeInfo), so
// without a snooze the warning re-popped on every thread the user opened, even
// right after they closed it. Mirror the update toast: persist a cooldown when
// the user dismisses it. It still reminds again after the window if the backend
// is still behind, and clears immediately once the backend catches up.
const SKEW_TOAST_SNOOZE_KEY = 'hermes:backend-skew-toast-snooze-until'
const SKEW_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function snoozeSkewToast(): void {
  persistString(SKEW_TOAST_SNOOZE_KEY, String(Date.now() + SKEW_TOAST_COOLDOWN_MS))
}

function isSkewToastSnoozed(): boolean {
  const until = Number(storedString(SKEW_TOAST_SNOOZE_KEY) || 0)

  return Number.isFinite(until) && Date.now() < until
}

/**
 * Guard against a desktop GUI talking to a backend that predates its contract
 * (e.g. a bb/gui-built app pointed at a `main` checkout). Rather than failing
 * cryptically downstream, surface a warning with a one-click align that runs
 * the normal update flow (which self-heals to the right branch).
 *
 * Runs on every session open; closing the toast snoozes it for a cooldown so it
 * doesn't nag on every thread switch.
 */
export function reportBackendContract(contract: number | undefined): void {
  if ((contract ?? 0) >= REQUIRED_BACKEND_CONTRACT) {
    dismissNotification(SKEW_TOAST_ID)
    // Backend caught up — forget any prior snooze so a future regression warns
    // immediately rather than staying silent for the rest of the window.
    persistString(SKEW_TOAST_SNOOZE_KEY, null)

    return
  }

  if (isSkewToastSnoozed()) {
    return
  }

  notify({
    action: {
      label: translateNow('notifications.updateHermes'),
      onClick: () => {
        snoozeSkewToast()
        void applyBackendUpdate()
      }
    },
    durationMs: 0,
    id: SKEW_TOAST_ID,
    kind: 'warning',
    message: translateNow('notifications.backendOutOfDateMessage'),
    onDismiss: () => snoozeSkewToast(),
    title: translateNow('notifications.backendOutOfDateTitle')
  })
}

/**
 * Fire a toast when an update is available, at most once per cooldown window.
 * Closing the toast — dismissing it or opening the updates window from it —
 * (re)starts the cooldown, so a busy upstream branch doesn't re-spam the user
 * on every new commit. The snooze is persisted, so it survives relaunches too.
 */
export function maybeNotifyUpdateAvailable(status: DesktopUpdateStatus | null) {
  if (!status || status.supported === false || status.error || !status.targetSha) {
    return
  }

  if ((status.behind ?? 0) <= 0) {
    return
  }

  if (isUpdateToastSnoozed()) {
    return
  }

  // hc-475 follow-up: this used to gate on the (now-removed) client apply
  // atom, which real packaged/backend users could never actually set — the
  // client self-rebuild plane never reached an "applying" state for them
  // (main.cjs refuses it before that point). So that check was always false
  // in practice; dropping it changes nothing observable.
  const behind = status.behind ?? 0

  notify({
    action: {
      label: translateNow('notifications.seeWhatsNew'),
      onClick: () => {
        snoozeUpdateToast()
        openUpdatesWindow()
      }
    },
    durationMs: 0,
    id: UPDATE_TOAST_ID,
    kind: 'info',
    message: translateNow('notifications.updateReadyMessage', behind),
    onDismiss: () => snoozeUpdateToast(),
    title: translateNow('notifications.updateReadyTitle')
  })
}

/** "Check for Updates…" entry point (app menu -> onOpenUpdatesRequested, see
 *  desktop-controller.tsx). Only meaningful when connected to a remote backend
 *  — the legacy local self-rebuild target is gone (see file header), so this
 *  is a no-op outside remote mode instead of opening a dead-end card. */
export function openUpdatesWindow(): void {
  if (!isRemoteMode()) {
    return
  }

  openBackendUpdateOverlay()
}

/** Re-read the running app's version from the Electron main process and
 *  publish it on `$desktopVersion`. Called when the About panel mounts, the
 *  update flow finishes, and the window regains focus, so the About text
 *  stays in sync with the just-installed binary instead of frozen at the
 *  value captured at first-load. */
export async function refreshDesktopVersion(): Promise<DesktopVersionInfo | null> {
  if (typeof window === 'undefined') {
    return null
  }

  // Best-effort UI sync: callers (startUpdatePoller, window focus handler)
  // all kick this off with `void refreshDesktopVersion()`, so any rejection
  // from the IPC bridge (e.g. main process shutting down mid-reload, or the
  // bridge not yet ready on first paint) would surface as an unhandled
  // promise rejection in the renderer. Swallow it.
  try {
    const next = await window.hermesDesktop?.getVersion?.()

    if (next) {
      $desktopVersion.set(next)
    }

    return next ?? null
  } catch {
    return null
  }
}

function isRemoteMode(): boolean {
  return $connection.get()?.mode === 'remote'
}

function mapBackendCheck(res: BackendUpdateCheckResponse): DesktopUpdateStatus {
  const behind = res.behind ?? 0

  return {
    supported: res.can_apply,
    message: res.message ?? undefined,
    behind: behind > 0 ? behind : 0,
    targetSha: res.update_available ? `backend:${res.current_version}` : undefined,
    commits: res.commits,
    fetchedAt: Date.now()
  }
}

export async function checkBackendUpdates(): Promise<DesktopUpdateStatus | null> {
  if (!isRemoteMode() || $backendUpdateChecking.get()) {
    return $backendUpdateStatus.get()
  }

  $backendUpdateChecking.set(true)

  try {
    const status = mapBackendCheck(await checkHermesUpdate(true))
    $backendUpdateStatus.set(status)
    maybeNotifyUpdateAvailable(status)

    return status
  } catch (error) {
    const fallback: DesktopUpdateStatus = {
      supported: $backendUpdateStatus.get()?.supported ?? true,
      error: 'check-failed',
      message: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now()
    }

    $backendUpdateStatus.set(fallback)

    return fallback
  } finally {
    $backendUpdateChecking.set(false)
  }
}

const BACKEND_RETURN_POLL_MS = 1500
const BACKEND_RETURN_MAX_ATTEMPTS = 40

async function waitForBackendReturn(): Promise<boolean> {
  for (let attempt = 0; attempt < BACKEND_RETURN_MAX_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => globalThis.setTimeout(resolve, BACKEND_RETURN_POLL_MS))
    try {
      await checkHermesUpdate()

      return true
    } catch {
      continue
    }
  }

  return false
}

function finishBackendApply(returned: boolean): DesktopUpdateApplyResult {
  if (returned) {
    $backendUpdateApply.set(IDLE)
    setUpdateOverlayOpen(false)
    void checkBackendUpdates()

    return { ok: true, message: 'Backend update applied.' }
  }

  $backendUpdateApply.set({
    ...$backendUpdateApply.get(),
    applying: false,
    stage: 'error',
    error: 'apply-failed',
    message: translateNow('updates.applyStatus.noReturn')
  })

  return { ok: false, error: 'apply-failed', message: 'Backend did not come back online.' }
}

export async function applyBackendUpdate(): Promise<DesktopUpdateApplyResult> {
  dismissNotification(UPDATE_TOAST_ID)
  $backendUpdateApply.set({ ...IDLE, applying: true, stage: 'prepare', message: translateNow('updates.applyStatus.preparing') })

  try {
    const started = await updateHermes()

    if (!started.ok) {
      const message = (started as { message?: string }).message || translateNow('updates.applyStatus.notAvailable')
      const command = (started as { update_command?: string }).update_command || 'hermes update'
      $backendUpdateApply.set({ ...IDLE, applying: false, stage: 'manual', message, command })

      return { ok: false, error: 'manual', manual: true, message, command }
    }

    $backendUpdateApply.set({ ...IDLE, applying: true, stage: 'pull', message: translateNow('updates.applyStatus.pulling') })

    let last: Awaited<ReturnType<typeof getActionStatus>> | null = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => globalThis.setTimeout(resolve, 1500))
      try {
        last = await getActionStatus(started.name, 200)
      } catch {
        // The dashboard restarts mid-update, dropping this connection — expected, not a failure.
        $backendUpdateApply.set({
          ...$backendUpdateApply.get(),
          applying: true,
          stage: 'restart',
          message: translateNow('updates.applyStatus.restarting')
        })

        return finishBackendApply(await waitForBackendReturn())
      }

      if (last && !last.running) {
        break
      }
    }

    const ok = !!last && (last.exit_code ?? 1) === 0
    if (ok) {
      $backendUpdateApply.set({ ...$backendUpdateApply.get(), applying: true, stage: 'restart', message: translateNow('updates.applyStatus.restarting') })

      return finishBackendApply(await waitForBackendReturn())
    }

    $backendUpdateApply.set({
      ...$backendUpdateApply.get(),
      applying: false,
      stage: 'error',
      error: 'apply-failed',
      message: translateNow('updates.applyStatus.failed')
    })

    return { ok: false, error: 'apply-failed', message: 'Backend update failed.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $backendUpdateApply.set({ ...$backendUpdateApply.get(), applying: false, stage: 'error', error: 'apply-failed', message })

    return { ok: false, error: 'apply-failed', message }
  }
}

let pollerStarted = false
let backgroundTimer: ReturnType<typeof setInterval> | null = null
let lastFocusAt = 0
let connectionUnsub: (() => void) | null = null
let lastConnectionMode: string | undefined

/** Wire up background polling for the backend update check + desktop version
 *  refresh. Idempotent. */
export function startUpdatePoller(): void {
  if (pollerStarted || typeof window === 'undefined' || !window.hermesDesktop) {
    return
  }

  pollerStarted = true
  void checkBackendUpdates()
  void refreshDesktopVersion()

  // The poller starts at mount, before the gateway connects — so the first
  // backend check above sees mode≠remote and no-ops. Re-check once the
  // connection resolves to remote.
  connectionUnsub = $connection.subscribe(conn => {
    if (conn?.mode === lastConnectionMode) {
      return
    }
    lastConnectionMode = conn?.mode
    if (conn?.mode === 'remote') {
      void checkBackendUpdates()
    }
  })

  window.addEventListener('focus', onFocus)
  backgroundTimer = setInterval(() => {
    void checkBackendUpdates()
  }, 30 * 60 * 1000)
}

export function stopUpdatePoller(): void {
  if (backgroundTimer !== null) {
    clearInterval(backgroundTimer)
    backgroundTimer = null
  }

  connectionUnsub?.()
  connectionUnsub = null
  lastConnectionMode = undefined
  window.removeEventListener('focus', onFocus)
  pollerStarted = false
}

function onFocus() {
  const now = Date.now()

  if (now - lastFocusAt < 5 * 60 * 1000) {
    return
  }

  lastFocusAt = now
  void checkBackendUpdates()
  void refreshDesktopVersion()
}
