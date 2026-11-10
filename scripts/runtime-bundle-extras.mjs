// hc-1170: the optional dependency extras every APEX Desktop runtime bundle installs.
//
// Upstream keeps messaging platforms and provider SDKs out of `[all]` and installs them on first
// use (`pm.ensure_import`). A Desktop engine runs from the bundle's own venv, never from a pm
// generation, so such an install lands where the running engine cannot import it and nothing
// adopts it later (`pm/environments_adopt.restart_needed`): the feature stays broken. On
// 2026-11-07 that is how a freshly bound Feishu bot never connected (lark_oapi installed into
// ~/.apexnodes/installs/…, then "requirements not met").
//
// So every extra an APEX feature needs ships in the bundle. tests/apex_overlay/
// test_desktop_bundle_extras.py classifies every lazily installed extra (shipped, deferred with a
// reason, or not used by APEX) and turns red when upstream adds one nobody looked at.

/** `[all]` plus what APEX features install on first use. */
export const DESKTOP_BUNDLE_EXTRAS = Object.freeze([
  'all',
  // The IM 入口's Feishu bot (lark-oapi, qrcode).
  'feishu',
  // Bring-your-own-key MiniMax: its default endpoints are Anthropic-compatible (anthropic_messages).
  'anthropic',
  // read_file on a PDF / Office document the user sends (anydoc). Already pulled in by another
  // dependency; named here so a dependency change upstream cannot drop it silently.
  'doc-extract',
  // web_extract through the platform's Firecrawl gateway (hc-1214, firecrawl-py). Without it the
  // provider's lazy install lands where the bundled engine cannot import it.
  'firecrawl'
])

/** The uv arguments that sync the bundle's venv, hash-verified against uv.lock unless `locked` is false. */
export function desktopBundleSyncArgs(locked = true) {
  return ['sync', ...DESKTOP_BUNDLE_EXTRAS.flatMap(extra => ['--extra', extra]), ...(locked ? ['--locked'] : [])]
}

/** The command a bundle manifest records for its venv, and the one assert/validate expects. */
export const DESKTOP_BUNDLE_SYNC = `uv ${desktopBundleSyncArgs().join(' ')}`
