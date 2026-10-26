/**
 * hc-1033: the engine version marker (`.hermes-bootstrap-complete`) and what stands in for it.
 *
 * The packaged gate replaces an installed engine only when it can prove that engine is older than the
 * one this shell ships, and the marker used to be its only proof. The marker lives inside the active
 * engine directory, so anything that drops it leaves no proof. On a colleague's Mac (2026-10-10) the
 * "repair" button on the boot-failure page deleted it; from then on every new shell logged "no proven
 * older source/version" and kept the 10-06 engine, while the app itself kept updating.
 *
 * Two changes close that:
 *   - each release lists the engines its pin descends from (`supersedes` in bundled-runtime.json, a
 *     map of full commit -> version label). An installed engine whose source stamp is listed is older
 *     whatever its marker says. The list is our own build-time data, never something read off the
 *     user's disk; bundled-runtime-package.node-test.mjs checks it (git ancestry where history exists);
 *   - a packaged build that ships its own engine keeps the marker on repair (repairEngineMarker).
 */

import fs from 'node:fs'
import path from 'node:path'

const COMMIT = /^[a-f0-9]{40}$/
const LABEL = /^v\d{4}\.\d{1,2}\.\d{1,2}-fork\.[a-f0-9]+$/

/** The release's `supersedes` map. Throws on a malformed entry so a bad descriptor never loads. */
export function releaseSupersedes(release: { runtime_commit: string; supersedes?: unknown }): ReadonlyMap<string, string> {
  const listed = release.supersedes

  if (listed === undefined) {return new Map()}

  if (!listed || typeof listed !== 'object' || Array.isArray(listed)) {
    throw new Error('The bundled engine release lists its older engines in an unreadable form.')
  }

  const entries = Object.entries(listed)

  for (const [commit, version] of entries) {
    // The label must name the same commit: a pasted label from another row is a typo, not proof.
    if (!COMMIT.test(commit) || commit === release.runtime_commit || typeof version !== 'string' ||
      !LABEL.test(version) || !version.endsWith(`.${commit.slice(0, 8)}`)) {
      throw new Error(`The bundled engine release lists an invalid older engine: ${commit}`)
    }
  }

  return new Map(entries as [string, string][])
}

/**
 * The installed engine at `root` (source stamp `commit`) is one this release replaces. A bundle's own
 * manifest must name the same commit; a source install has no manifest and only its stamp.
 */
export function supersededByRelease(root: string, commit: string | null, release: { runtime_commit: string; supersedes?: unknown }): boolean {
  if (!commit || !releaseSupersedes(release).has(commit)) {return false}
  const manifest = path.join(root, '.bundle-manifest.json')

  if (!fs.existsSync(manifest)) {return true}

  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8'))?.runtime_commit === commit
  } catch {
    return false
  }
}

/**
 * The marker half of the renderer's "repair" after a failed boot. Builds without a shipped engine drop
 * the marker so the next start re-runs the source installer. A build with one (`keepMarker`) never runs
 * that installer: the next start adopts the engine on disk and the packaged gate reads the marker only
 * as ordering proof, so dropping it there froze the machine on its engine. It keeps the marker; the
 * caller re-runs the gate, which reinstalls a broken engine by itself.
 */
export function repairEngineMarker({ markerPath, keepMarker, log }: { markerPath: string; keepMarker: boolean; log: (message: string) => void }) {
  if (keepMarker) {
    log('[bootstrap] repair requested by renderer; keeping the engine version marker, re-checking the bundled engine + clearing latched failure')

    return
  }

  log('[bootstrap] repair requested by renderer; clearing marker + latched failure')

  try {
    fs.rmSync(markerPath, { force: true })
  } catch (error: any) {
    log(`[bootstrap] failed to remove marker during repair: ${error.message}`)
  }
}
