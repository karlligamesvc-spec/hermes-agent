// hc-591: user-facing display formatting for the ApexNodes ENGINE (runtime)
// version. The bootstrap/update system pins the engine by an internal
// calver+fork string -- e.g. `v2026.7.25-fork.b0a720a5` (see
// electron/apex-runtime-latest.ts's engineMeetsMinVersion doc: "Engine
// versions are calver+fork"). The `-fork.<sha>` segment is an internal ops
// key (which fork commit this build was cut from) that a consumer-facing
// update dialog / pill / settings panel must never show verbatim -- Kael
// flagged the update overlay reading "正在更新到 v2026.7.25-fork.b0a720a5" as
// exposing an internal ops key, the same "terminology invisibility" concern
// that already governs the rest of the platform's user-facing copy.
//
// This module is DISPLAY-ONLY. It never touches how the engine version is
// stored, compared (parseSemver / compareSemver / engineMeetsMinVersion in
// apex-runtime-latest.ts are unchanged and keep comparing the raw strings),
// or gated (min_desktop_version / min_engine_version behavior is unaffected).
// It only decides what STRING a renderer shows a human, at the point where
// that string is about to be interpolated into copy.
import { translateNow } from '@/i18n'

// Matches the calver core of an engine version, with an optional
// `-fork.<key>` suffix (the internal ops segment we hide). Anchored on both
// ends on purpose: a string carrying anything we don't explicitly recognize
// here (a different prerelease suffix, a raw commit sha, a branch name,
// "dev", an empty string, …) must NOT match, so it falls through to the
// fail-open branch below instead of being silently truncated or mangled.
const ENGINE_CALVER_RE = /^v?(\d{4}\.\d{1,2}\.\d{1,2})(?:-fork\.\S+)?$/

/**
 * Format an engine (runtime) version string for display to the end user.
 *
 * - `displayName`, when a non-empty string, wins outright and `version` is
 *   ignored entirely. This is reserved for a future cloud-provided override
 *   (RuntimeVersion.display_name does not exist yet as of hc-591 -- this leg
 *   is desktop-only, no hermes-cloud change). No current caller has a real
 *   value to pass, so every call site today either omits the argument or
 *   passes `null`/`undefined`.
 * - Otherwise, an internal calver(+fork) string such as
 *   `v2026.7.25-fork.b0a720a5` (or a bare `v2026.7.25` with no fork suffix)
 *   becomes `"<enginePrefix> 2026.7.25"` -- the `-fork.<sha>` ops segment is
 *   dropped and the leading `v` is stripped. The prefix noun itself comes
 *   from `common.engineVersionPrefix` (i18n; see i18n/types.ts), so it reads
 *   "Engine 2026.7.25" / "引擎 2026.7.25" / "エンジン 2026.7.25" per the active
 *   locale.
 * - Anything that does not match that exact shape (a raw commit sha, a
 *   branch name, a plain semver like the hermes-agent package version, an
 *   empty string, …) is returned COMPLETELY UNCHANGED -- fail-open, so an
 *   unrecognized format is never mangled and never throws.
 *
 * Callers are expected to guard `null`/not-yet-resolved versions themselves
 * (the existing call sites already do -- see about-settings.tsx's
 * `currentVersion ? a.engineVersion(...) : a.engineVersionUnavailable`
 * pattern), mirroring how `version` is typed as a definite `string` here.
 */
export function formatEngineDisplayVersion(
  version: string,
  displayName?: string | null,
  localizedPrefix?: string
): string {
  if (typeof displayName === 'string' && displayName.trim() !== '') {
    return displayName
  }

  // Defensive: keep this fail-open even if a caller's `any`/IPC-sourced value
  // slips past the `string` type at runtime -- never throw on a weird input.
  if (typeof version !== 'string') {
    return version
  }

  const match = ENGINE_CALVER_RE.exec(version.trim())

  if (!match) {
    return version
  }

  return `${localizedPrefix || translateNow('common.engineVersionPrefix')} ${match[1]}`
}
