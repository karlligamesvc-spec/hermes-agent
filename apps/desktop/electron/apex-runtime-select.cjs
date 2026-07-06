'use strict'

/**
 * apex-runtime-select.cjs
 *
 * Startup RESILIENCE for the "which runtime do we start the gateway with?"
 * decision. Pure, electron-free, unit-testable helpers; main.cjs supplies the
 * live filesystem probe and wires the outcome into resolveHermesBackend() /
 * ensureRuntime().
 *
 * WHY THIS EXISTS (2026-07-06 incident)
 * -------------------------------------
 * The cloud R3 endpoint (GET /api/v1/runtime/latest) advertised a version whose
 * COS source tarball was NOT actually published yet:
 *
 *     [runtime-latest] resolved admin latest: version=v2026.7.1-fork.f9da5169
 *                      key=462c8b02...
 *
 * apex-runtime-latest.cjs faithfully resolved that pin (the server said it was
 * installable), the bootstrap runner then tried to fetch the missing tarball,
 * install.sh's CN path 404'd, and — because the *only* backend resolution that
 * had been reached was `bootstrap-needed` — the whole local gateway refused to
 * start. The user saw "APEX 无法启动 / 后台网关没有启动" even though a perfectly
 * usable runtime was already extracted on disk at ~/.apexnodes/hermes-agent.
 *
 * The correct behavior is FAIL-OPEN: a runtime-latest resolution or a package
 * download that fails must never brick a machine that already has a runnable
 * runtime on disk. The desktop must self-heal against a wrong/ahead server
 * answer (the cloud is separately fixing "don't advertise unpublished
 * versions", but the client cannot assume the server is always right).
 *
 * TWO DECISIONS, BOTH PURE
 * ------------------------
 *  1. resolvePreBootstrapDecision — BEFORE we ever touch the network / bootstrap
 *     runner. If a usable runtime is already on disk but the bootstrap-complete
 *     marker is absent/stale (an interrupted install, a dropped marker, a legacy
 *     install predating the marker, a COS-tarball extract that was never on
 *     PATH), adopt the on-disk runtime directly instead of blindly re-running
 *     the network resolve + installer. This is the root-cause fix: it stops the
 *     incident from being reached at all.
 *
 *  2. resolveBootstrapFailureFallback — AFTER a bootstrap attempt fails
 *     (download 404 / network / checksum). If a usable runtime is on disk,
 *     degrade to it (warning, gateway starts) instead of latching a fatal
 *     failure. This is the safety net for the genuine first-install-with-a-prior-
 *     runtime case and for any failure that slips past decision (1).
 *
 * An in-flight OPT-IN update (R5, a persisted pin override the user explicitly
 * asked for) is treated differently: the user deliberately chose a new version,
 * so we must NOT silently adopt the old on-disk runtime and no-op their request.
 * Both helpers therefore hand the update-pending case back to the normal
 * bootstrap/rollback machinery (which already has its own don't-brick guard:
 * a failed opt-in re-bootstrap rolls the override back to the previous marker).
 */

/**
 * Decide whether a runtime already extracted on disk is runnable enough to start
 * the gateway with — i.e. the source tree has the Python entrypoint AND some
 * Python interpreter (a co-located venv, or a usable system Python) resolved.
 *
 * This is the same pair of facts isBootstrapComplete() checks, minus the marker:
 * "is there actually something we can spawn `-m hermes_cli.main` against?"
 *
 * @param {object} probe
 * @param {boolean} probe.sourcePresent  hermes_cli/main.py exists under the root
 * @param {boolean} probe.pythonPresent  a runnable interpreter resolved for the root
 * @returns {boolean}
 */
function canUseOnDiskRuntime(probe) {
  if (!probe || typeof probe !== 'object') return false
  return Boolean(probe.sourcePresent) && Boolean(probe.pythonPresent)
}

/**
 * BEFORE bootstrap: choose between adopting the on-disk runtime and running the
 * (network-touching) bootstrap flow.
 *
 * @param {object} opts
 * @param {boolean} opts.markerComplete   isBootstrapComplete() — install is
 *   already attested good; the normal fast path owns it (we return 'bootstrap'
 *   so the caller keeps its existing marker-complete handling; this helper does
 *   not duplicate that branch).
 * @param {boolean} opts.onDiskUsable     canUseOnDiskRuntime(probe)
 * @param {boolean} opts.updatePending    a persisted opt-in pin override exists
 *   (R5) — the user asked for a specific new version; never silently keep the old.
 * @returns {'use-installed' | 'bootstrap'}
 *   'use-installed' — a usable runtime is on disk with no attesting marker and no
 *     pending update; adopt it directly (skip the network resolve + installer).
 *   'bootstrap' — proceed with the normal bootstrap resolution (marker already
 *     complete, an opt-in update is pending, or nothing usable is on disk).
 */
function resolvePreBootstrapDecision({ markerComplete, onDiskUsable, updatePending } = {}) {
  // An explicit opt-in update must drive the bootstrap so the new pin installs;
  // adopting the on-disk (old) runtime here would no-op the user's request.
  if (updatePending) return 'bootstrap'
  // Marker already attests a good install — the caller's normal fast path
  // handles it; we don't second-guess it here.
  if (markerComplete) return 'bootstrap'
  // The heart of the fix: usable runtime on disk, but no marker -> adopt it
  // rather than re-running a network resolve + installer that a wrong/ahead
  // server answer (unpublished version) can turn into a brick.
  if (onDiskUsable) return 'use-installed'
  // Nothing usable on disk -> we genuinely must bootstrap.
  return 'bootstrap'
}

/**
 * AFTER a failed bootstrap attempt: decide whether to fail-open onto an on-disk
 * runtime or surface the failure as fatal.
 *
 * @param {object} opts
 * @param {boolean} opts.onDiskUsable   canUseOnDiskRuntime(probe), re-evaluated
 *   after the failed attempt (the installer may have torn a partial extract down;
 *   only fall open when something runnable actually remains).
 * @param {boolean} opts.updatePending  a persisted opt-in pin override exists —
 *   let the caller's rollback machinery handle it (it restores the previous
 *   marker so the OLD runtime boots next launch) rather than adopting silently.
 * @returns {'fallback-to-disk' | 'fatal'}
 */
function resolveBootstrapFailureFallback({ onDiskUsable, updatePending } = {}) {
  // Opt-in update failures go through rollbackRuntimePinOverride() in the caller,
  // which re-points at the previous marker; don't short-circuit that here.
  if (updatePending) return 'fatal'
  // First-install / marker-repair bootstrap failed, but a usable runtime is on
  // disk (e.g. a prior good extract, or the download 404'd on an unpublished
  // version) -> start the gateway with what we have instead of bricking.
  if (onDiskUsable) return 'fallback-to-disk'
  return 'fatal'
}

module.exports = {
  canUseOnDiskRuntime,
  resolvePreBootstrapDecision,
  resolveBootstrapFailureFallback
}
