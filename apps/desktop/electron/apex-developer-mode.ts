/**
 * apex-developer-mode.ts — hc-1131: tells the local engine whether developer mode is on.
 *
 * The switch (Settings › 外观, `$toolViewMode`) lives in the renderer's localStorage, and
 * the engine needs it when it builds a session's prompt: product mode's rule against
 * writing local paths into replies (apex_overlay/result_delivery_prompt.py) stays out of
 * developer-mode sessions. The renderer reports the switch at every launch and on every
 * flip; this keeps a marker in the root shared by every local profile, the same way the
 * creator profile mirrors its prompt segment.
 */

import fs from 'fs'
import path from 'path'

export function developerModeMarkerPath(hermesHome: string): string {
  return path.join(hermesHome, 'apex', 'developer-mode')
}

/** Create the marker while developer mode is on, remove it otherwise. Never throws. */
export function syncDeveloperModeMarker(hermesHome: string, on: boolean, log: (line: string) => void): void {
  const target = developerModeMarkerPath(hermesHome)

  try {
    if (!on) {
      fs.rmSync(target, { force: true })

      return
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '1\n', { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    log(`[developer-mode] marker update failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
