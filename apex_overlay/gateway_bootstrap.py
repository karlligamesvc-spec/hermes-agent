"""Keep Feishu adapter creation off the gateway startup critical path.

The managed ApexNodes runtime exposes API_SERVER as its readiness surface.
Feishu imports the Lark SDK and attaches a websocket, both of which may be
slow.  Blocking ``GatewayRunner.start()`` on that work delays an otherwise
ready agent and historically caused restart loops (hc-384/385).

v0.20 inlined the platform loop back into ``GatewayRunner.start()``.  Plugin
discovery still happens immediately before that loop, so the narrow stable
hook is now ``GatewayRunner._create_adapter``: the first cold-start Feishu
creation is scheduled as a tracked task and the synchronous loop is told no
adapter was created.  Reconnects and every other platform use upstream's
method unchanged.  This avoids copying the large, fast-moving startup loop.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import time
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

_TARGET_RUN_MODULE = "gateway.run"
_TARGET_RUNNER_CLS = "GatewayRunner"
_TARGET_CREATE_METHOD = "_create_adapter"
_APPLIED = False
_MARK = "_apex_overlay_gateway_bootstrap"
_SCHEDULED_ATTR = "_apex_background_bootstrap_scheduled"

_HELPER_NAMES = (
    "_apex_prepare_background_adapter",
    "_apex_register_background_adapter",
    "_apex_queue_platform_retry",
    "_apex_create_and_connect_adapter_in_background",
)


def _is_feishu(platform: Any) -> bool:
    return str(getattr(platform, "value", platform) or "").strip().lower() == "feishu"


def _prepare_background_adapter(self, adapter: Any) -> None:
    """Mirror v0.20's callback wiring before a cold adapter connect."""
    adapter.set_message_handler(self._primary_message_handler())
    adapter.set_fatal_error_handler(self._handle_adapter_fatal_error)
    adapter.set_session_store(self.session_store)
    adapter.set_busy_session_handler(self._handle_active_session_busy_message)
    set_reaction = getattr(adapter, "set_reaction_handler", None)
    if callable(set_reaction):
        set_reaction(self._handle_reaction_event)
    adapter.set_topic_recovery_fn(self._recover_telegram_topic_thread_id)
    adapter.set_authorization_check(self._make_adapter_auth_check(adapter.platform))
    adapter._busy_text_mode = self._busy_text_mode


def _register_background_adapter(self, platform: Any, adapter: Any) -> None:
    self.adapters[platform] = adapter
    self._sync_voice_mode_state_to_adapter(adapter)
    if hasattr(adapter, "_voice_input_callback"):
        adapter._voice_input_callback = self._handle_voice_channel_input
    self.delivery_router.adapters = self.adapters
    self._wire_teams_pipeline_runtime()
    self._update_platform_runtime_status(
        platform.value,
        platform_state="connected",
        error_code=None,
        error_message=None,
    )


def _queue_platform_retry(
    self,
    platform: Any,
    platform_config: Any,
    adapter: Any,
    *,
    error_message: str,
    error_code: Optional[str] = None,
    retryable: bool = True,
) -> None:
    self._update_platform_runtime_status(
        platform.value,
        platform_state="retrying" if retryable else "fatal",
        error_code=error_code,
        error_message=error_message,
    )
    if retryable:
        self._failed_platforms[platform] = {
            "config": platform_config,
            "attempts": 1,
            "next_retry": time.monotonic() + 30,
            "credential_claim": self._adapter_credential_claim(platform, adapter),
            "listener_claim": self._adapter_listener_claim(platform, adapter),
        }


async def _create_and_connect_adapter_in_background(
    self,
    platform: Any,
    platform_config: Any,
    create_adapter: Callable,
    allow_lock_takeover: bool,
) -> None:
    """Create and connect Feishu after the API conversation path can proceed."""
    started = time.monotonic()
    logger.info("Creating %s adapter in background...", platform.value)
    try:
        adapter = await asyncio.to_thread(create_adapter, self, platform, platform_config)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.error("✗ %s background adapter creation failed: %s", platform.value, exc)
        self._update_platform_runtime_status(
            platform.value,
            platform_state="fatal",
            error_code="adapter_create_failed",
            error_message=str(exc),
        )
        return

    if not adapter:
        self._update_platform_runtime_status(
            platform.value,
            platform_state="fatal",
            error_code="adapter_unavailable",
            error_message="adapter unavailable",
        )
        return

    self._apex_prepare_background_adapter(adapter)
    adapter._platform_lock_takeover_allowed = allow_lock_takeover
    try:
        success = await self._connect_adapter_with_timeout(adapter, platform)
    except asyncio.CancelledError:
        await self._safe_adapter_disconnect(adapter, platform)
        raise
    except Exception as exc:
        logger.error("✗ %s background connect error: %s", platform.value, exc)
        await self._safe_adapter_disconnect(adapter, platform)
        self._apex_queue_platform_retry(
            platform,
            platform_config,
            adapter,
            error_message=str(exc),
        )
        return
    finally:
        adapter._platform_lock_takeover_allowed = False

    if not success:
        await self._safe_adapter_disconnect(adapter, platform)
        if adapter.has_fatal_error:
            self._apex_queue_platform_retry(
                platform,
                platform_config,
                adapter,
                error_code=adapter.fatal_error_code,
                error_message=adapter.fatal_error_message or "failed to connect",
                retryable=adapter.fatal_error_retryable,
            )
        else:
            self._apex_queue_platform_retry(
                platform,
                platform_config,
                adapter,
                error_message="failed to connect",
            )
        return

    self._apex_register_background_adapter(platform, adapter)
    logger.info(
        "✓ %s connected in background in %dms",
        platform.value,
        int((time.monotonic() - started) * 1000),
    )
    try:
        from gateway.channel_directory import build_channel_directory

        await build_channel_directory(self.adapters)
    except Exception:
        logger.debug("background channel directory refresh failed", exc_info=True)
    try:
        self._schedule_resume_pending_sessions(platform=platform)
    except Exception:
        logger.debug("background resume scheduling failed", exc_info=True)


def _wrap_create_adapter(orig: Callable) -> Callable:
    @functools.wraps(orig)
    def wrapper(self, platform, config):
        if not _is_feishu(platform):
            return orig(self, platform, config)

        scheduled = getattr(self, _SCHEDULED_ATTR, None)
        if scheduled is None:
            scheduled = set()
            setattr(self, _SCHEDULED_ATTR, scheduled)
        key = str(getattr(platform, "value", platform))
        if key in scheduled:
            return orig(self, platform, config)

        scheduled.add(key)
        self._update_platform_runtime_status(
            platform.value,
            platform_state="connecting",
            error_code=None,
            error_message=None,
        )
        task = asyncio.create_task(
            self._apex_create_and_connect_adapter_in_background(
                platform,
                config,
                orig,
                bool(getattr(self, "_platform_lock_takeover_on_start", False)),
            ),
            name=f"gateway-{platform.value}-background-create-connect",
        )
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        logger.info("Scheduled %s adapter creation/connect in background", platform.value)
        return None

    setattr(wrapper, _MARK, True)
    return wrapper


def apply() -> bool:
    """Install the v0.20 hc-384/385 cold-start seam. Idempotent and fail-safe."""
    global _APPLIED
    if _APPLIED:
        return True

    import importlib

    try:
        run_mod = importlib.import_module(_TARGET_RUN_MODULE)
        runner_cls = getattr(run_mod, _TARGET_RUNNER_CLS)
        orig = getattr(runner_cls, _TARGET_CREATE_METHOD)
    except (ImportError, AttributeError) as exc:
        logger.error(
            "apex_overlay: gateway bootstrap seam target moved; Feishu may block startup (%s)",
            exc,
        )
        return False

    if getattr(orig, _MARK, False):
        _APPLIED = True
        return True

    setattr(runner_cls, "_apex_prepare_background_adapter", _prepare_background_adapter)
    setattr(runner_cls, "_apex_register_background_adapter", _register_background_adapter)
    setattr(runner_cls, "_apex_queue_platform_retry", _queue_platform_retry)
    setattr(
        runner_cls,
        "_apex_create_and_connect_adapter_in_background",
        _create_and_connect_adapter_in_background,
    )
    setattr(runner_cls, _TARGET_CREATE_METHOD, _wrap_create_adapter(orig))
    _APPLIED = True
    logger.debug("apex_overlay: v0.20 Feishu background-startup seam applied")
    return True
