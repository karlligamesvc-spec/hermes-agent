# apex_overlay — the ApexNodes overlay seam pattern (PILOT)

> Status: **pilot**. One seam shipped (hc-392 provider denylist). This README is
> the template later phases (`gateway/run.py`, `gateway/platforms/feishu.py`,
> `scripts/install.sh`) copy. Discipline + audit: `OVERLAY-SEAM-AUDIT.md` in the
> hermes-cloud repo.

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

### 3. A seam-test pins the patched symbol (this is mandatory)

A monkey-patch is only safe if the thing it patches still exists with a
compatible shape. Upstream renaming/moving that symbol would **silently disarm**
the seam. The seam-test (`tests/apex_overlay/test_*_seam.py`) asserts the target
function/attribute still exists and its signature is unchanged — turning a silent
disarm into a **loud CI failure**, the prerequisite for trusting monkey-patch.

## The pilot: hc-392 provider denylist

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

## Checklist for the next seam

- [ ] Move behavior into `apex_overlay/<thing>.py` with `apply()` (idempotent, fail-safe).
- [ ] Find the narrowest patch point that gives the required behavior/timing.
- [ ] Call it from `plugins/apex-overlay/__init__.py:register()`.
- [ ] Restore the upstream file to byte-for-byte upstream.
- [ ] Write a seam-test pinning every patched symbol's existence + signature.
- [ ] Verify with the CI runner (`scripts/run_tests_parallel.py`), not single pytest — per-file interpreter isolation is the real contract.
