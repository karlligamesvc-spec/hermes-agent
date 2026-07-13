/**
 * Pure copy-selection for the updates overlay's "available" state.
 *
 * Degrades honestly when there's no commit changelog to show (e.g. a pip /
 * non-git backend where `git log` yields nothing) instead of generic filler.
 *
 * Extracted from updates-overlay.tsx so the wording logic is unit-testable.
 *
 * hc-475 follow-up: this used to also select between "client" (local desktop
 * self-rebuild) and "backend" (connected remote backend) copy. The overlay
 * only ever targets the backend now — the client plane's renderer entry
 * points were physically removed — so the target branch is gone too.
 */

export interface UpdateCopyStrings {
  availableTitleBackend: string
  availableBodyBackend: string
  availableBodyNoChangelog: string
}

export interface ResolveUpdateCopyInput {
  /** Number of commit rows actually shown in the changelog. 0 → no notes. */
  shownItems: number
  copy: UpdateCopyStrings
}

export interface UpdateCopyResult {
  title: string
  body: string
}

export function resolveUpdateCopy({ shownItems, copy }: ResolveUpdateCopyInput): UpdateCopyResult {
  const title = copy.availableTitleBackend
  const body = shownItems === 0 ? copy.availableBodyNoChangelog : copy.availableBodyBackend

  return { title, body }
}
