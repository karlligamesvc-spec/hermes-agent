/**
 * user-data-dir.cjs
 *
 * Pure resolver for the desktop app's userData directory pin.
 *
 * Why this exists: the user-visible product name is "APEX" (package.json
 * productName), but Electron derives the DEFAULT userData directory from that
 * name. Existing installs predate the rename and keep all their state under
 * the old "ApexNodes" directory (~/Library/Application Support/ApexNodes on
 * macOS, %APPDATA%\ApexNodes on Windows): connection.json, updates.json,
 * active-profile.json and — critically — apex-managed.json, the signed-in
 * user's managed-LLM relay key. A bare rename would silently point every one
 * of those reads at an empty "APEX" directory and log everyone out.
 *
 * So main.cjs pins userData to the historical location at startup, before any
 * app.getPath('userData') use. Verified on Electron 40: app.setPath('userData')
 * also re-points sessionData (cookies / localStorage), so the single pin keeps
 * remote-gateway sessions alive too.
 *
 * Kept standalone (no `require('electron')`) so it unit-tests with
 * `node --test` — same pattern as connection-config.cjs / desktop-uninstall.cjs.
 */

const path = require('node:path')

// The pre-rename userData dirname (Electron derived it from the old
// productName "ApexNodes"). Every shipped install stores its config there.
// Do NOT rename this without a data migration for existing installs.
const LEGACY_USER_DATA_DIRNAME = 'ApexNodes'

/**
 * Resolve the userData directory to pin at startup.
 *   - `override` (HERMES_DESKTOP_USER_DATA_DIR) wins when set and non-blank —
 *     tests and sandboxed runs rely on it.
 *   - otherwise: <appData>/ApexNodes, the historical location.
 */
function resolveUserDataDir(appDataDir, override) {
  const trimmed = typeof override === 'string' ? override.trim() : ''
  if (trimmed) return path.resolve(trimmed)
  return path.join(appDataDir, LEGACY_USER_DATA_DIRNAME)
}

module.exports = { LEGACY_USER_DATA_DIRNAME, resolveUserDataDir }
