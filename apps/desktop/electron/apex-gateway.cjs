/**
 * apex-gateway.cjs
 *
 * Pure, electron-free helpers for the hc-417 messaging-gateway lifecycle — the
 * real-machine P0 fix for "IM 入口 绑定后飞书永不连接".
 *
 * ── Root cause ──────────────────────────────────────────────────────────────
 * The desktop app spawns a `hermes dashboard` backend, which runs the web /
 * JSON-RPC server + cron ticker but NO live messaging adapters
 * (hermes_cli/web_server.py: "no live adapters; delivery falls back to the
 * per-platform send path"). The Feishu / WeChat inbound WS adapters light up
 * ONLY inside `hermes gateway run`. So injecting the bound FEISHU_* / WEIXIN_*
 * credential into the dashboard process (which the desktop already did) enabled
 * outbound sends + lark tools but never an inbound WS — the bound channel sits
 * on "连接中…" forever, and a phone message gets no reply. Worse, on the repro
 * machine the launchd gateway service (ai.hermes.gateway.plist) was
 * "stale + not loaded" and carried no FEISHU_* env, so nothing hosted the
 * adapter at all.
 *
 * ── Fix (option a: electron-managed foreground gateway) ─────────────────────
 * Run a real messaging gateway ALONGSIDE the desktop dashboard — exactly the
 * topology a server uses (`hermes dashboard` + `hermes gateway run` share one
 * HERMES_HOME; the cron `.tick.lock` already makes them cooperate). electron
 * spawns/stops it across the app lifecycle (same style as the hc-533 daemon and
 * the dashboard backend) and injects the SAME just-in-time credential env
 * fragment the dashboard receives, so the adapter actually connects. The
 * gateway writes its per-platform WS state to the runtime status file, which
 * /api/messaging/platforms already surfaces — so the IM 入口 page flips from
 * "连接中…" to "已连接" on its own once the WS is live (no renderer change; the
 * old green was fake precisely because the gateway never ran).
 *
 * Credential boundary: the secret reaches the gateway ONLY through the child
 * process env (decrypted just in time in main.cjs), never a plist, never a
 * repo-path config.yaml, never a log line — identical treatment to the
 * dashboard spawn.
 *
 * Kept standalone (no `require('electron')`) so it unit-tests with `node --test`,
 * same pattern as apex-im-entry.cjs / apex-daemon.cjs. main.cjs owns the
 * electron-coupled glue (spawn, lifecycle, env injection).
 */

/**
 * Build the `hermes … gateway run` CLI args for the desktop-managed messaging
 * gateway.
 *
 * `--replace` reaps any stale foreground gateway PID left by a previous app
 * session before starting (idempotent (re)start) and skips the
 * existing-process guard, because the desktop OWNS this gateway's lifecycle.
 *
 * We deliberately do NOT pass `--force`: the supervised-gateway guard
 * (hermes_cli/gateway.py::_guard_supervised_gateway_conflict) must still refuse
 * to stack a second dispatcher on top of an actively-RUNNING systemd/launchd/s6
 * service — two dispatchers on one HERMES_HOME are the documented cause of
 * multi-writer SQLite WAL corruption (upstream issue #35240). That guard only
 * fires when the service is installed AND running; on the repro machine the
 * launchd service is "not loaded", so it does not fire and the foreground
 * gateway starts cleanly. If a real service ever is running, refusing (and
 * surfacing the channel's live status) is the correct, safe outcome rather than
 * risking corruption.
 *
 * The optional `profile` is passed as the global `--profile` flag (parsed
 * before the subcommand), which re-homes HERMES_HOME exactly as the dashboard
 * spawn does — so both processes resolve the same home and see the same
 * credential + sessions.
 *
 * @param {string | null | undefined} profile the desktop's active profile name
 * @returns {string[]} argv for `python -m hermes_cli.main …`
 */
function buildGatewayRunArgs(profile) {
  const args = ['gateway', 'run', '--replace']
  const name = typeof profile === 'string' ? profile.trim() : ''
  if (name) {
    args.unshift('--profile', name)
  }
  return args
}

/**
 * True when the normalized IM 入口 store (the map keyed by channel id that
 * resolveImEntryStore() returns) has at least one usable channel binding — i.e.
 * there is an adapter for the messaging gateway to host. When false the gateway
 * should be stopped (nothing to connect) rather than run idle.
 *
 * Defensive against a malformed/partial entry: a binding only counts when it
 * carries at least one field value (the same gate normalizeStoredImEntry uses on
 * read, so a decrypt-blanked record never keeps a ghost gateway alive).
 *
 * @param {Record<string, { fields?: Record<string, string> }> | null | undefined} store
 * @returns {boolean}
 */
function imEntryStoreHasBinding(store) {
  if (!store || typeof store !== 'object') {
    return false
  }
  return Object.values(store).some(
    binding =>
      binding &&
      typeof binding === 'object' &&
      binding.fields &&
      typeof binding.fields === 'object' &&
      Object.keys(binding.fields).length > 0
  )
}

module.exports = {
  buildGatewayRunArgs,
  imEntryStoreHasBinding
}
