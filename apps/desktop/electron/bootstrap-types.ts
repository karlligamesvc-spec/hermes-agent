// First-launch install ("bootstrap") event types -- emitted by
// electron/bootstrap-runner.ts and observed by the renderer install overlay.
// Mirrors the event shapes emitted by runBootstrap()'s onEvent callback.

export interface DesktopBootstrapStageDescriptor {
  name: string
  title?: string
  category?: string
  needs_user_input?: boolean
}

export type DesktopBootstrapStageState = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed'

export interface DesktopBootstrapStageResult {
  state: DesktopBootstrapStageState
  durationMs: number | null
  startedAt: number | null
  // hc-569: skip_code is the installer's machine-readable "why was this stage
  // skipped" (e.g. deps_unchanged, prereq_cached); the overlay maps it to a
  // localized reason and falls back to the raw `reason` string when unknown.
  json: { ok: boolean; skipped?: boolean; reason?: string | null; skip_code?: string | null; stage: string } | null
  error: string | null
}

export interface DesktopBootstrapUnsupportedPlatform {
  platform: string
  activeRoot: string
  installCommand: string
  docsUrl: string
}

export interface DesktopBootstrapSetupChoice {
  platform: string
  activeRoot: string
}

export interface DesktopBootstrapState {
  active: boolean
  manifest: {
    type: 'manifest'
    stages: DesktopBootstrapStageDescriptor[]
    protocolVersion: number | null
    // hc-452: see DesktopBootstrapUpdateInfo below -- distinguishes an opt-in
    // runtime version update from a genuine first install.
    updateInfo: DesktopBootstrapUpdateInfo
  } | null
  stages: Record<string, DesktopBootstrapStageResult>
  error: string | null
  log: Array<{ ts: number; stage: string | null; line: string; stream?: 'stdout' | 'stderr' }>
  startedAt: number | null
  completedAt: number | null
  setupChoice: DesktopBootstrapSetupChoice | null
  unsupportedPlatform: DesktopBootstrapUnsupportedPlatform | null
}

export type DesktopBootstrapEvent =
  | { type: 'dismissed' }
  | { type: 'activity'; stage?: string | null }
  | {
      type: 'setup-choice'
      active: boolean
      platform?: string
      activeRoot?: string
    }
  | {
      type: 'manifest'
      stages: DesktopBootstrapStageDescriptor[]
      protocolVersion: number | null
      updateInfo?: DesktopBootstrapUpdateInfo
    }
  | {
      type: 'stage'
      name: string
      state: DesktopBootstrapStageState
      durationMs?: number
      json?: DesktopBootstrapStageResult['json']
      error?: string | null
    }
  | { type: 'log'; stage?: string | null; line: string; stream?: 'stdout' | 'stderr' }
  | { type: 'complete'; marker: Record<string, unknown> }
  | { type: 'failed'; stage?: string | null; error: string }
  | {
      type: 'unsupported-platform'
      platform: string
      activeRoot: string
      installCommand: string
      docsUrl: string
    }

// hc-452: distinguishes a re-bootstrap for an opt-in runtime version UPDATE
// (main.cjs's hermes:runtime:apply-update dropped the marker and re-runs the
// bootstrap against a pending pin override) from a genuine first-ever
// install (no prior runtime on disk). The install overlay uses this to show
// "updating to vX" instead of "APEX needs a one-time install" -- both are
// literally the same 10-stage bootstrap protocol underneath, but a runtime
// update is not a "one-time setup" and calling it that on every version bump
// misleads the user (hc-452 origin: Kael real-machine 2026-07-08 report).
export interface DesktopBootstrapUpdateInfo {
  isUpdate: boolean
  // The version being installed. Populated once bootstrapStamp resolves in
  // main.cjs (before that -- e.g. the eager synthetic manifest emitted while
  // the network fetch for the manifest is still in flight -- this is null).
  toVersion: string | null
  // The version being replaced, when known (from the runtime-pin override's
  // previousMarker snapshot). null for a first install, or when the prior
  // marker didn't carry a version label.
  fromVersion: string | null
}

