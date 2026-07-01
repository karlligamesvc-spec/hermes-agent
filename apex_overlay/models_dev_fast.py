"""China-first non-blocking models.dev catalog fetch — a zero-in-place seam.

What this fixes
===============
The desktop ``/model`` picker shows a 7-15s white screen on cold start. Root
cause: the runtime enriches provider/model metadata from the community
``models.dev`` catalog (``https://models.dev/api.json``, ~2.4 MB), fetched live
from the US. From mainland China that request takes ~10s. Upstream
``agent.models_dev.fetch_models_dev()`` will make that fetch **synchronously on
the caller path** whenever the on-disk cache (``$HERMES_HOME/models_dev_cache.json``)
is older than its 1h TTL — so every session that opens the picker an hour after
the last one blocks the whole picker for ~10s.

But models.dev is **pure metadata enrichment**. The APEX relay's own models are
local; nothing about opening the picker actually *needs* a fresh models.dev.
So this catalog fetch must **never** block the picker.

The seam
========
We monkey-patch ``agent.models_dev.fetch_models_dev`` (from ``apply()``, wired
by the ``apex-overlay`` plugin) with a wrapper that is **cache-first and
non-blocking** for the implicit picker path, while leaving the explicit
user-triggered refresh untouched:

* ``force_refresh=True`` (``hermes config refresh`` / "refresh model catalog"):
  delegate to the original **unchanged** — the user explicitly asked for fresh
  data and is willing to wait. (This also keeps every upstream
  ``test_models_dev`` force-refresh test green.)

* ``force_refresh=False`` (the picker / cold-start path):
    1. Fresh in-memory cache  -> return it (upstream stage-1 hot path, untouched).
    2. Any disk cache exists   -> load it (EVEN IF STALE), populate the in-mem
       cache, return **immediately**. If it is stale past the effective
       threshold, kick a background thread to refresh — the caller never waits.
    3. No disk cache at all    -> return ``{}`` immediately and refresh in the
       background. A first-ever cold start gets an un-enriched picker for a few
       seconds instead of a ~10s white screen; the next open is fully enriched.

  The background refresh just calls the **original** ``fetch_models_dev(force_refresh=True)``
  once, off the caller path, which does the real network fetch + disk write +
  in-mem update exactly as upstream would have.

CN-mode longer TTL
==================
models.dev only changes when a provider adds a model — the data is stable over
days. In CN mode (``apex_overlay.region.is_cn_mode()``) a fresh session an hour
later should not re-pay a ~10s trans-Pacific fetch, so we raise the *effective
staleness threshold* to :data:`_CN_STALE_THRESHOLD` (7 days). Below that the disk
cache is served with **no** background refresh at all. Outside CN we keep
upstream's 1h behavior (serve stale immediately, refresh in the background).

Note this only relaxes *when we bother refreshing*; the picker is served
instantly from disk in every case where a cache exists, CN or not.

Safety
======
Mirrors ``provider_filter.py``'s defensive style: ``apply()`` is idempotent and
fail-safe (a missing target logs + returns False, never raises — the seam-test
turns a silent disarm into loud CI). The background thread is a daemon and
swallows all exceptions, and the whole wrapper falls back to the original
function if anything in our fast path misfires. On a box where nothing can be
served from cache and the network is down, behavior is identical to upstream
(``{}``), just without the block.
"""

from __future__ import annotations

import functools
import logging
import threading
import time
from typing import Any, Callable, Dict

logger = logging.getLogger(__name__)

# The upstream attribute we monkey-patch. Centralized so the seam-test can pin
# it — an upstream rename/move then breaks BOTH the patch and the test, loudly.
_TARGET_MODULE = "agent.models_dev"
_TARGET_FN = "fetch_models_dev"

# Idempotency guard + marker so we never double-wrap across boot paths.
_APPLIED = False
_MARK = "_apex_overlay_models_dev_fast"

# CN-mode effective staleness threshold. Below this age the on-disk cache is
# served with no background refresh; models.dev is stable enough that a 7-day
# window is safe and it spares mainland sessions the ~10s trans-Pacific fetch.
_CN_STALE_THRESHOLD = 7 * 24 * 3600  # 7 days, seconds

# Serialize background refreshes so overlapping picker opens spawn at most one
# in-flight network fetch instead of a thread per call.
_refresh_lock = threading.Lock()
_refresh_in_flight = False


def _effective_stale_threshold() -> float:
    """Age (seconds) past which a disk cache is considered worth refreshing.

    CN mode: :data:`_CN_STALE_THRESHOLD`. Otherwise upstream's in-mem/disk TTL
    (read live from the target module so we track any upstream change to it).
    Fail-safe: any error falls back to the upstream TTL, then to 3600.
    """
    try:
        from apex_overlay.region import is_cn_mode

        if is_cn_mode():
            return float(_CN_STALE_THRESHOLD)
    except Exception:
        pass
    try:
        import agent.models_dev as md

        return float(getattr(md, "_MODELS_DEV_CACHE_TTL", 3600))
    except Exception:
        return 3600.0


def _spawn_background_refresh(orig: Callable) -> None:
    """Run ``orig(force_refresh=True)`` once, off the caller path.

    At most one refresh is in flight at a time. The thread is a daemon so it
    never blocks interpreter shutdown, and it swallows everything — a failed
    background refresh must never surface to the picker.
    """
    global _refresh_in_flight
    with _refresh_lock:
        if _refresh_in_flight:
            return
        _refresh_in_flight = True

    def _run() -> None:
        global _refresh_in_flight
        try:
            orig(force_refresh=True)
            logger.debug("apex_overlay.models_dev_fast: background refresh done")
        except Exception as exc:  # never propagate from a daemon thread
            logger.debug(
                "apex_overlay.models_dev_fast: background refresh failed: %s", exc
            )
        finally:
            with _refresh_lock:
                _refresh_in_flight = False

    try:
        threading.Thread(
            target=_run,
            name="apex-modelsdev-refresh",
            daemon=True,
        ).start()
    except Exception as exc:
        # Could not even start the thread — reset the flag so a later call can
        # retry, and don't raise into the picker.
        logger.debug(
            "apex_overlay.models_dev_fast: could not start refresh thread: %s", exc
        )
        with _refresh_lock:
            _refresh_in_flight = False


def _wrap_fetch_models_dev(orig: Callable) -> Callable:
    """Cache-first, non-blocking wrapper around ``fetch_models_dev``."""

    @functools.wraps(orig)
    def wrapper(force_refresh: bool = False, *args, **kwargs) -> Dict[str, Any]:
        # Explicit refresh: the user asked for fresh data and will wait.
        # Delegate untouched (also preserves upstream force-refresh tests).
        # Any unexpected extra args/kwargs also go straight through so the
        # overlay never changes the shape of a non-default call.
        if force_refresh:
            return orig(True, *args, **kwargs)
        if args or kwargs:
            return orig(force_refresh, *args, **kwargs)

        try:
            import agent.models_dev as md

            # Stage 1 (untouched hot path): a fresh in-mem cache always wins.
            if (
                md._models_dev_cache
                and (time.time() - md._models_dev_cache_time)
                < md._MODELS_DEV_CACHE_TTL
            ):
                return md._models_dev_cache

            disk_age = md._disk_cache_age_seconds()

            # Stage 2: any disk cache — serve it IMMEDIATELY, even if stale.
            if disk_age is not None:
                disk_data = md._load_disk_cache()
                if disk_data:
                    md._models_dev_cache = disk_data
                    # Anchor the in-mem TTL to the disk age (matches upstream)
                    # so we don't extend an already-aging cache by a full hour.
                    md._models_dev_cache_time = time.time() - disk_age
                    # Only refresh (in the background) if it's stale enough.
                    needs_refresh = disk_age >= _effective_stale_threshold()
                    logger.debug(
                        "apex_overlay.models_dev_fast: served disk cache "
                        "(%d providers, age=%.0fs, bg_refresh=%s)",
                        len(disk_data), disk_age, needs_refresh,
                    )
                    if needs_refresh:
                        # Spawn AFTER capturing what we return: the daemon may
                        # replace md._models_dev_cache with fresh data mid-call.
                        _spawn_background_refresh(orig)
                    # Return the stable local, never the thread-shared module
                    # attribute, so a fast background refresh can't change what
                    # THIS caller sees.
                    return disk_data

            # Stage 3: nothing to serve. Return empty NOW and refresh async —
            # never the ~10s synchronous network block on the picker path.
            logger.debug(
                "apex_overlay.models_dev_fast: no cache; returning empty + "
                "background refresh (picker stays non-blocking)"
            )
            _spawn_background_refresh(orig)
            return {}
        except Exception as exc:
            # Anything unexpected in our fast path → fall back to upstream so
            # the overlay can never make things worse than stock behavior.
            logger.debug(
                "apex_overlay.models_dev_fast: fast path misfired (%s); "
                "falling back to upstream fetch_models_dev",
                exc,
            )
            return orig(force_refresh=False)

    setattr(wrapper, _MARK, True)
    return wrapper


def apply() -> bool:
    """Install the non-blocking models.dev fetch seam onto upstream. Idempotent.

    Returns ``True`` if the patch is applied (or already present), ``False`` if
    the target symbol is missing (which the seam-test turns into a hard CI
    failure). Safe to call from any boot path; a no-op after the first success.
    """
    global _APPLIED
    if _APPLIED:
        return True

    import importlib

    try:
        md = importlib.import_module(_TARGET_MODULE)
        orig = getattr(md, _TARGET_FN)
        if not getattr(orig, _MARK, False):
            setattr(md, _TARGET_FN, _wrap_fetch_models_dev(orig))
    except (ImportError, AttributeError) as exc:
        logger.error(
            "apex_overlay: could not patch %s.%s — the non-blocking models.dev "
            "fetch is NOT active; the picker may block on a live catalog fetch. "
            "Upstream may have renamed/moved it. (%s)",
            _TARGET_MODULE, _TARGET_FN, exc,
        )
        return False

    _APPLIED = True
    logger.debug("apex_overlay: non-blocking models.dev fetch seam applied")
    return True
