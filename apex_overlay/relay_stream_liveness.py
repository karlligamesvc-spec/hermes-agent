"""Notice a dead platform-relay stream in about a minute, not ten (hc-1032).

On 2026-10-22 four Desktop streams (``deepseek-v4-pro-APEX``) finished on the server in
3-15 s, but the bytes stopped reaching the Mac somewhere between Cloudflare and the user's
broadband. The engine only noticed when its stale timer ran out: 600 s for this model (the
DeepSeek reasoning floor, and the stream read timeout is raised to match), so the user
waited 7-17 minutes and the identical re-send was metered a second time.

Three seams, all limited to the platform relay base URL:

1. Byte deadline. A relay that heartbeats its chat stream says so in
   ``X-APEX-Stream-Keepalive``. A response hook then lowers that request's read timeout
   (httpcore reads it when the body starts) to ``max(45 s, 6 beats)``: 60 s for the relay's
   10 s beat. Without the header nothing changes, so an older relay keeps today's patience.
   The engine already retries a read timeout on a fresh connection when nothing visible
   was delivered yet.
2. TCP keepalive on the relay's connections (probes after 30 s idle, 6 of them 10 s apart),
   so a path that died is noticed even without the header and on non-streaming calls.
3. ``X-APEX-Call-Id``: a digest of the call's ``api_request_id``, which stays the same across
   the engine's retries of that call. The relay hands such a retry the stream it already
   finished instead of running and metering it again.
"""
from __future__ import annotations

import functools
import hashlib
import logging
import socket
from typing import Any

from apex_overlay.managed_model_catalog import is_platform_relay

logger = logging.getLogger(__name__)

KEEPALIVE_HEADER = 'x-apex-stream-keepalive'
CALL_ID_HEADER = 'X-APEX-Call-Id'
MISSED_BEATS = 6
MIN_READ_DEADLINE_SECONDS = 45.0
MAX_BEAT_SECONDS = 60.0
KEEPALIVE_IDLE_SECONDS = 30
KEEPALIVE_INTERVAL_SECONDS = 10
KEEPALIVE_PROBES = 6
_MARK = '_apex_relay_stream_liveness'
_keepalive_options_cache: list[tuple[int, int, int]] | None = None


def read_deadline(headers: Any) -> float | None:
    """The byte deadline a heartbeating relay response allows, else None."""
    try:
        beat = float(headers.get(KEEPALIVE_HEADER))
    except (TypeError, ValueError):
        return None
    if not 0 < beat <= MAX_BEAT_SECONDS:
        return None
    return max(MIN_READ_DEADLINE_SECONDS, beat * MISSED_BEATS)


def _tighten_read_timeout(response: Any) -> None:
    deadline = read_deadline(response.headers)
    timeouts = response.request.extensions.get('timeout') if deadline is not None else None
    if not isinstance(timeouts, dict):
        return
    current = timeouts.get('read')
    if current is None or current > deadline:
        timeouts['read'] = deadline


async def _tighten_read_timeout_async(response: Any) -> None:
    _tighten_read_timeout(response)


def keepalive_socket_options() -> list[tuple[int, int, int]]:
    """The keepalive options this OS accepts, probed once on a throwaway socket (one the OS
    refuses would fail every connection; macOS names the idle timer ``TCP_KEEPALIVE``)."""
    global _keepalive_options_cache
    if _keepalive_options_cache is not None:
        return _keepalive_options_cache
    idle = getattr(socket, 'TCP_KEEPIDLE', None) or getattr(socket, 'TCP_KEEPALIVE', None)
    wanted = [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]
    for name, value in ((idle, KEEPALIVE_IDLE_SECONDS),
                        (getattr(socket, 'TCP_KEEPINTVL', None), KEEPALIVE_INTERVAL_SECONDS),
                        (getattr(socket, 'TCP_KEEPCNT', None), KEEPALIVE_PROBES)):
        if name is not None:
            wanted.append((socket.IPPROTO_TCP, name, value))
    accepted: list[tuple[int, int, int]] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            for option in wanted:
                try:
                    probe.setsockopt(*option)
                except OSError:
                    continue
                accepted.append(option)
    except OSError:
        accepted = []
    _keepalive_options_cache = accepted
    return accepted


def _add_keepalive(client: Any) -> None:
    """Add keepalive to the pools behind the client. ``socket_options`` is read when a pool
    opens a connection; httpcore still sets TCP_NODELAY after them. A shared pool (other
    direct providers in this process) gets it too, which costs them nothing."""
    options = keepalive_socket_options()
    transports = (getattr(client, '_transport', None), *(getattr(client, '_mounts', None) or {}).values())
    for transport in transports:
        pool = getattr(transport, '_pool', None)
        if options and pool is not None and hasattr(pool, '_socket_options'):
            current = list(pool._socket_options or ())
            pool._socket_options = current + [option for option in options if option not in current]


def _watch_relay_client(client: Any, *, async_mode: bool) -> None:
    hooks = dict(client.event_hooks)
    hook = _tighten_read_timeout_async if async_mode else _tighten_read_timeout
    hooks['response'] = [*hooks.get('response', ()), hook]
    client.event_hooks = hooks
    _add_keepalive(client)


def call_id(session_id: str, api_request_id: str) -> str | None:
    if not api_request_id:
        return None
    return hashlib.sha256(f'{session_id}|{api_request_id}'.encode()).hexdigest()[:32]


def name_relay_call(*, request: dict, base_url: str = '', session_id: str = '', api_request_id: str = '',
                    **_context: Any) -> dict | None:
    """``llm_request`` middleware: the call id rides on every attempt of one logical call."""
    value = call_id(session_id or '', api_request_id or '') if is_platform_relay(base_url) else None
    if value is None or not isinstance(request, dict):
        return None
    headers = dict(request.get('extra_headers') or {})
    headers[CALL_ID_HEADER] = value
    return {'request': {**request, 'extra_headers': headers}, 'source': 'apex-overlay',
            'reason': 'hc-1032 relay call id'}


def apply(ctx: Any = None) -> bool:
    try:
        from agent import process_bootstrap
    except ImportError:
        logger.error('apex-overlay: hc-1032 cannot import agent.process_bootstrap')
        return False
    original = getattr(process_bootstrap, 'build_keepalive_http_client', None)
    if not callable(original):
        logger.error('apex-overlay: hc-1032 build_keepalive_http_client is gone')
        return False
    if not getattr(original, _MARK, False):
        @functools.wraps(original)
        def build(base_url: str = '', *args: Any, **kwargs: Any) -> Any:
            client = original(base_url, *args, **kwargs)
            if client is not None and is_platform_relay(base_url):
                try:
                    _watch_relay_client(client, async_mode=bool(kwargs.get('async_mode')))
                except Exception:
                    logger.warning('apex-overlay: hc-1032 relay stream watch not installed', exc_info=True)
            return client

        setattr(build, _MARK, True)
        process_bootstrap.build_keepalive_http_client = build
    if ctx is not None:
        ctx.register_middleware('llm_request', name_relay_call)
    return True
