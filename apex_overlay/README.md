# apex_overlay — the ApexNodes overlay seam pattern

> Status: **production**. The bundled `apex-overlay` plugin applies every seam
> below, each independently tested. Each seam keeps ApexNodes behavior outside
> hot upstream files so version upgrades remain reviewable. Discipline and the
> original audit live in `OVERLAY-SEAM-AUDIT.md` in the hermes-cloud repo.

## The problem this solves

We run a **fork-free overlay** on top of NousResearch Hermes: take upstream tags
as-is, layer ApexNodes behavior on top. The dominant source of merge pain is
**in-place edits to hot upstream files**. Every line we add to e.g.
`hermes_cli/model_switch.py` (8 upstream commits since our fork point) is a line
that can conflict on the next bump.

`apex_overlay/` removes that conflict surface. **Upstream will never create a
package with this name**, so anything here has a zero-conflict merge surface.

Seam tier preference (most preferred first):

```
config  >  plugin / boot-import (this package)  >  upstream PR  >  in-place (last resort)
```

## The pattern (3 parts)

### 1. Behavior lives in `apex_overlay/<thing>.py`, not in the upstream file

Move the logic out of the hot file into a small module here. Keep the data part
in config when it already is one (the hc-392 denylist stays in
`cli-config.yaml.example` under `model.disabled_providers` — that was already a
perfect data seam).

Expose:
- a small pure helper surface (e.g. `disabled_provider_set()`, `is_disabled()`)
- an idempotent, fail-safe `apply()` that installs the seam onto upstream.

### 2. Wire it in via a bundled plugin (`plugins/apex-overlay/`)

`plugins/apex-overlay/__init__.py`'s `register(ctx)` calls each seam's `apply()`.
Enable it once via the **config tier**: `plugins.enabled: [apex-overlay]` in
`cli-config.yaml.example`. No code edit to any hot upstream file.

Why a plugin over an in-place `import`:
- Plugin discovery runs early in both entrypoints — `cli.py` deferred startup
  (before the `/model` picker cache prewarm) and `gateway/run.py` boot — so a
  startup-timing-sensitive seam (like "skip provider before its catalog fetch")
  applies in time.
- It keeps every upstream file byte-for-byte upstream. The only non-code touch
  is one line in the config example.

> **Monkey-patch vs. one-line hook.** Prefer a clean monkey-patch in `apply()`
> (zero in-place). Fall back to a single `apex_overlay.<mod>.apply(...)` hook
> line in the upstream file **only** if no clean patch point exists — still far
> less than re-inlining the whole change.

> **Never import a `gateway.*` target from `apply()` (hc-989).** `register()`
> runs inside plugin discovery. On the gateway that is the `plugin-discovery`
> thread, holding the discovery lock, while the main thread imports
> `gateway.run` — whose module body bridges `auxiliary:` config through
> discovery and so waits for that lock. A seam that imports `gateway.run` there
> waits for the main thread's import lock: neither thread can move, and the
> gateway hangs before it binds a port (cloud image v2026.8.31, 2026-10-20; with
> the 10 s plugin-load deadline, apex-overlay is dropped instead). Patch gateway
> modules through `post_import.when_imported(module, install)`: it patches at
> once if the module is fully imported, otherwise on the importing thread right
> after the module body finishes, before `import` returns, so nothing sees the
> module unpatched. Every gateway seam has a case in
> `tests/apex_overlay/test_discovery_import_deadlock.py`. The hc-989 audit of
> every module the overlay touches during discovery found three whose own import
> runs discovery: `gateway.run`, `model_tools` and `run_agent`. No seam may
> import them from `apply()`.

### 3. A seam-test pins the patched symbol (this is mandatory)

A monkey-patch is only safe if the thing it patches still exists with a
compatible shape. Upstream renaming/moving that symbol would **silently disarm**
the seam. The seam-test (`tests/apex_overlay/test_*_seam.py`) asserts the target
function/attribute still exists and its signature is unchanged — turning a silent
disarm into a **loud CI failure**, the prerequisite for trusting monkey-patch.

## Current seam inventory

| Seam | Contract |
|---|---|
| `provider_filter` | Do not probe or show disabled providers (hc-392/hc-621). |
| `managed_model_catalog` | Allow a 15-second cold-cache relay catalog probe; retain upstream credential-scoped caching. |
| `model_catalog_dedupe` | Collapse managed-sentinel and live bare model IDs into one picker row (hc-512). |
| `picker_probe_widening` | Preserve the full platform catalog for virtual/custom main providers. |
| `custom_base_url_guard` | Preserve the managed relay address while switching custom-provider models. |
| `custom_row_dedupe` | Remove the duplicate unauthenticated “Custom endpoint” row (hc-598). |
| `models_dev_fast` | Keep the model picker responsive while the large models.dev catalog refreshes. |
| `gateway_bootstrap` | Start slow platform adapters in the background without delaying conversation readiness (hc-384/hc-385). |
| `feishu_supervisor` | Reconnect Feishu after failures instead of relying on the SDK's single-shot path (hc-384). |
| `web_tools_extract` | Gate extraction by extraction capability, not the broader web-search key check (hc-401). |
| `stt_no_lazy_install` | Prevent managed containers from OOMing on an in-request STT dependency install (hc-401). |
| `first_turn_ack` | Acknowledge long first turns on the native China IM channels (hc-401). |
| `cn_im_messages` | Localize gateway control/status messages for China IM channels (hc-401). |
| `cn_im_banners` | On WeChat, WeCom, DingTalk, QQ and Feishu, replace the runtime's session-reset notice with one plain sentence and drop the ◆ session lines, in any catalog language (hc-976; was hc-457/hc-964 in-place in `weixin.py`). |
| `cn_mirror_env` | Route runtime dependency downloads through China mirrors when configured (hc-476). |
| `im_passthrough` | Route `/cc` and `/codex` into direct coding-agent sessions (hc-539). |
| `region` | Provide the shared region-policy helpers used by the China-specific seams. |
| `post_import` | Patch a module once it has finished importing, without importing it; every `gateway.*` seam goes through it so plugin discovery never waits on a gateway import (hc-989). |
| `relay_stream_liveness` | A platform-relay chat stream whose bytes stop arriving is retried after max(45 s, 6 relay heartbeats) instead of the 600 s reasoning stale floor; relay sockets carry TCP keepalive; each logical call carries `X-APEX-Call-Id` so the relay can replay a finished stream to its retry unbilled (hc-1032). |
| `vision_answer` | When `vision_analyze` uses the auxiliary model, it asks a short, direct question in the response language, and only the visible answer comes back: never the model's reasoning, and a cut-off answer says so. Routing (native or auxiliary) stays upstream's (hc-1065). |
| `packaged_engine` | An engine installed by APEX Desktop never builds a frontend, and `hermes --tui` runs its shipped TUI on the bundled Node (hc-954). Hooked in place from `source_build.py` and `main_tui_launch.py`: plugin discovery runs too late on those paths. |

`plugins/apex-overlay/__init__.py` is the authoritative registration order.
Every behavioral seam has a matching test under `tests/apex_overlay/` that
pins the upstream symbol or contract it depends on.

## Example: hc-392 provider denylist

`apex_overlay/provider_filter.py`. Contract: disabled providers (e.g. GitHub
Copilot) make **no** startup network call and never appear in the `/model`
picker — even if a stray `GH_TOKEN` is on the box.

Two monkey-patches in `apply()`:

| Patched symbol | Why |
|---|---|
| `hermes_cli.models.cached_provider_model_ids` | The single shared helper every provider's model list flows through. For copilot it fans out to `fetch_github_model_catalog()` (a GitHub call). Short-circuit disabled providers to `[]` here → **the fetch never fires** (the "no network call" guarantee). |
| `hermes_cli.model_switch.list_authenticated_providers` | Drop disabled-provider rows from the picker result by slug. (A disabled provider could otherwise still emit a row from its curated static fallback once the live list is empty.) |

Both read the denylist fresh per call and are **no-ops when the denylist is
empty** → on a box with nothing disabled, behavior is identical to upstream.

Seam-test: `tests/apex_overlay/test_provider_filter_seam.py`.

## Checklist for a new seam

- [ ] Move behavior into `apex_overlay/<thing>.py` with `apply()` (idempotent, fail-safe).
- [ ] Find the narrowest patch point that gives the required behavior/timing.
- [ ] Call it from `plugins/apex-overlay/__init__.py:register()`.
- [ ] Restore the upstream file to byte-for-byte upstream.
- [ ] Write a seam-test pinning every patched symbol's existence + signature.
- [ ] A `gateway.*` target goes through `post_import.when_imported`, never `importlib.import_module` in `apply()`, and gets a case in `test_discovery_import_deadlock.py`.
- [ ] Verify with the CI runner (`scripts/run_tests_parallel.py`), not single pytest — per-file interpreter isolation is the real contract.

## Default narration (hc-906)

`doubao_tts` registers the `doubao` TTS provider and makes it the APEX default
when the active profile has not explicitly selected another provider. It also
handles configs cached with upstream's Edge default before plugin discovery.
The profile's own platform key authenticates to Scheduler
`/api/v1/tools/v1/tts/synthesize`; vendor speech credentials stay server-side.
Foreign profiles never borrow the process profile's key or private endpoint.

The service returns a complete MP3 which is atomically saved before delivery.
Long-form text uses the runtime's ordered 2,000-character chunking. Missing
plugins, network errors and invalid audio fail without silently switching to
Edge or OS speech. An explicitly configured provider remains respected.
The APEX real-time Qwen voice transport is a separate feature.

hc-1007: while Doubao is the active provider, the model reads a Chinese
`text_to_speech` description (`NARRATION_DESCRIPTION`): every voice-over,
narration and read-aloud goes through this tool, and the model must not write
its own edge-tts / gTTS / pyttsx3 / macOS `say` code instead. Upstream's text
names Edge and OpenAI; on 0.17.58 a model cutting a video did exactly that
(2026-10-21). The wrapper sits on the registry entry's
`dynamic_schema_overrides`, so an explicit BYOK provider still shows
upstream's description. Speed is clamped to the 0.5–2.0 the Scheduler route
accepts.

Requires the companion Scheduler route before rollout. This change alone does
not publish a Desktop installer or change the production runtime pin.

Validation: `scripts/run_tests.sh tests/apex_overlay/test_doubao_tts.py tests/tools/test_tts_plugin_dispatch.py tests/tools/test_tts_long_form_chunking.py -q`.
