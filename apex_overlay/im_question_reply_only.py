"""hc-1018 — cloud IM chats carry only the question and the reply, as a zero-in-place overlay seam.

APEX Desktop got 「只有问题和回复」 in hc-1015 (``single_thread_prompt`` plus the renderer's activity
line). Cloud agents answer in Feishu, WeChat, WeCom, DingTalk and QQ. For an allowlisted agent
apex-nodes writes ``apex.im_question_reply_only: true`` into its config.yaml, together with display
settings this gateway already honours: no tool progress, no mid-turn assistant messages, busy acks
without detail, a Chinese long-running phrase, the first-turn ack on Feishu too, and a prompt section
with hc-1015's speaking rules (apex-nodes ``app/services/im_question_reply_only.py``). Two things those
settings cannot reach live here.

1. Lifecycle status lines. ``AIAgent._emit_status`` / ``_emit_warning`` → the turn's status callback →
   ``gateway.run._prepare_gateway_status_message`` → ``adapter.send``. No display setting turns them
   off: rate-limit retries, 「❌ API failed after 3 retries — …」, 「↻ Empty response after tool calls
   — …」, memory recall lines. With the switch on, a Chinese IM chat gets none of them. They describe
   the process; the turn's reply carries the outcome, a failure included.
2. The runtime's own failure replies. They name the provider and the model and suggest ``/model``,
   ``/retry`` or ``hermes doctor``, none of which an IM user can act on:
   - credit exhaustion: 「Billing or credits exhausted: HTTP 402: <relay sentence>」 plus English
     advice naming the provider and model. The relay's own Chinese sentence (apex-nodes
     ``QUOTA_EXHAUSTED_MESSAGE``) is kept, the wrapper and the advice are dropped;
   - the provider error categories of ``_gateway_provider_error_reply`` (rate limit → wait a minute,
     anything else → it failed on the platform's side, try again shortly);
   - the turn-completion explainer (``explainer.no_reply_prefix``, 「⚠️ No reply: …」 on images that
     predate the catalog): the explanation becomes 「回「继续」我接着做，或者换个说法再试」, a partial
     answer before it is kept;
   - image v2026.8.31's reasoning-only fallback, which ends with the raw reasoning.
   ``gateway.run._sanitize_gateway_final_response`` is the exit every final reply passes before an
   adapter sends it. Each sentence still says what happened and what the user can do (hc-982: say why,
   never pretend it worked).

Kept: clarify cards, approval prompts, busy acks, the first-turn ack, every model answer, and every
failure this module does not recognise (it passes through as upstream renders it).

Switch: ``apex.im_question_reply_only: true`` in config.yaml, read through ``_load_gateway_config``
(mtime-cached), and only for feishu / weixin / wecom / wecom_callback / dingtalk / qqbot. Without it
both functions return exactly what upstream returns. The same file ships on fork main and on the cloud
image's hotfix line; every symbol it touches exists in both.

Idempotent (``_MARK`` + ``_APPLIED``) and fail-safe: any error inside a wrapper returns upstream's
result. ``apply()`` arms the patch for ``gateway.run``'s import (hc-989, ``post_import``) and returns
False only if a target symbol is missing, which the seam test turns into a CI failure.
"""

from __future__ import annotations

import functools
import logging
import re

from apex_overlay import post_import

logger = logging.getLogger(__name__)

_TARGET_RUN_MODULE = "gateway.run"
_TARGET_STATUS_FN = "_prepare_gateway_status_message"
_TARGET_FINAL_FN = "_sanitize_gateway_final_response"
_TARGET_FUNCTIONS = (_TARGET_STATUS_FN, _TARGET_FINAL_FN)

_APPLIED = False
_MARK = "_apex_overlay_im_question_reply_only"

CN_IM_PLATFORMS = frozenset({"feishu", "weixin", "wecom", "wecom_callback", "dingtalk", "qqbot"})

QUOTA_REPLY = "⚠️ 本月平台额度已用完，这次没能做完。可以在网页控制台的「用量」页升级套餐，或等下月初额度自动重置后再继续。"
BUSY_REPLY = "⏱️ 现在用的人多，这次没做完。等一两分钟再发一次就行。"
FAILED_REPLY = "⚠️ 这次没做完：平台这边的服务出了问题，不是你的原因。过几分钟再发一次试试。"
NO_RESULT_REPLY = "⚠️ 这次没出结果。回「继续」我接着做，或者换个说法再试。"

_BILLING_RE = re.compile(
    r"^\W*\s*(?:Billing or credits exhausted|Provider reported usage/credit exhaustion)", re.IGNORECASE
)
_REASONING_ONLY_PREFIX = "⚠️ The model produced only internal reasoning"
_LEGACY_NO_REPLY_PREFIX = "⚠️ No reply: "
_CJK_RE = re.compile(r"[一-鿿]")
_SENTENCE_END_RE = re.compile(r"['\"}]")


def _platform_key(platform) -> str:
    value = getattr(platform, "value", platform)
    return str(value or "").strip().lower()


def switch_on(run_mod) -> bool:
    """``apex.im_question_reply_only`` in the gateway's config.yaml."""
    cfg = run_mod._load_gateway_config() or {}
    apex = cfg.get("apex") if isinstance(cfg, dict) else None
    value = apex.get("im_question_reply_only") if isinstance(apex, dict) else None
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return value is True


def _active(run_mod, platform) -> bool:
    return _platform_key(platform) in CN_IM_PLATFORMS and switch_on(run_mod)


def _quota_reply(text: str) -> str:
    """The relay's own Chinese sentence from the first paragraph, else ``QUOTA_REPLY``.

    The sentence may sit inside a raw SDK error dump (``{'error': {'message': '…', 'type': …}}``),
    so it ends at the first ASCII quote or brace after it starts.
    """
    first = text.strip().split("\n\n", 1)[0]
    match = _CJK_RE.search(first)
    if not match:
        return QUOTA_REPLY
    sentence = _SENTENCE_END_RE.split(first[match.start():], maxsplit=1)[0].strip()
    return f"⚠️ {sentence}" if sentence else QUOTA_REPLY


def _no_reply_prefixes() -> tuple[str, ...]:
    """The explainer prefix as the catalog renders it, plus the pre-catalog English one.

    ``t()`` returns the bare key when no catalog has it (image v2026.8.31)."""
    from agent.i18n import t

    rendered = t("explainer.no_reply_prefix")
    if not rendered or rendered in ("explainer.no_reply_prefix", _LEGACY_NO_REPLY_PREFIX):
        return (_LEGACY_NO_REPLY_PREFIX,)
    return (_LEGACY_NO_REPLY_PREFIX, rendered)


def plain_final_reply(run_mod, original: str, sanitized):
    """``sanitized`` (upstream's result) with a recognised runtime failure in plain Chinese."""
    if not isinstance(sanitized, str) or not sanitized.strip() or not isinstance(original, str):
        return sanitized
    if _BILLING_RE.match(original.strip()):
        return _quota_reply(original)
    if run_mod._looks_like_gateway_provider_error(original):
        return BUSY_REPLY if run_mod._GATEWAY_RATE_LIMIT_RE.search(original) else FAILED_REPLY
    stripped = sanitized.strip()
    if stripped.startswith(_REASONING_ONLY_PREFIX):
        return NO_RESULT_REPLY
    for prefix in _no_reply_prefixes():
        if stripped.startswith(prefix):
            return NO_RESULT_REPLY
        head, sep, _ = sanitized.partition("\n\n" + prefix)
        if sep:
            return f"{head.rstrip()}\n\n{NO_RESULT_REPLY}"
    return sanitized


def _wrap_status(run_mod, orig):
    @functools.wraps(orig)
    def wrapper(platform, event_type, message, *args, **kwargs):
        try:
            if _active(run_mod, platform):
                return None
        except Exception:  # health: allow BLE001 -- a status callback must never break; log and pass through
            logger.warning("apex_overlay: hc-1018 status filter failed; sending upstream's line", exc_info=True)
        return orig(platform, event_type, message, *args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_final(run_mod, orig):
    @functools.wraps(orig)
    def wrapper(platform, text, *args, **kwargs):
        result = orig(platform, text, *args, **kwargs)
        try:
            if _active(run_mod, platform):
                return plain_final_reply(run_mod, text, result)
        except Exception:  # health: allow BLE001 -- a final reply must never break; log and send upstream's text
            logger.warning("apex_overlay: hc-1018 reply rewrite failed; sending upstream's text", exc_info=True)
        return result

    setattr(wrapper, _MARK, True)
    return wrapper


_WRAPPERS = {_TARGET_STATUS_FN: _wrap_status, _TARGET_FINAL_FN: _wrap_final}
# Read at install time too, so a renamed helper fails the seam test instead of a user's reply.
_HELPERS = ("_load_gateway_config", "_looks_like_gateway_provider_error", "_GATEWAY_RATE_LIMIT_RE")


def _install_run(run_mod) -> bool:
    global _APPLIED
    try:
        for name in _HELPERS:
            getattr(run_mod, name)
        for name in _TARGET_FUNCTIONS:
            orig = getattr(run_mod, name)
            if not getattr(orig, _MARK, False):
                setattr(run_mod, name, _WRAPPERS[name](run_mod, orig))
    except AttributeError as exc:
        logger.error(
            "apex_overlay: could not patch %s for hc-1018 — cloud IM chats keep the runtime's status "
            "lines and English failure replies. Upstream may have renamed a target. (%s)",
            _TARGET_RUN_MODULE, exc,
        )
        return False
    _APPLIED = True
    return True


def apply() -> bool:
    """Arm the two wrappers for ``gateway.run``'s import. Idempotent, fail-safe, never raises."""
    if _APPLIED:
        return True
    return post_import.when_imported(_TARGET_RUN_MODULE, _install_run)
