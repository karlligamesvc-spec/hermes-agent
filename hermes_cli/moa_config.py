"""Mixture-of-Agents configuration and slash-command helpers."""

from __future__ import annotations

import base64
import json
from copy import deepcopy
from typing import Any

MOA_MARKER_PREFIX = "__HERMES_MOA_TURN_V1__"
DEFAULT_MOA_PRESET_NAME = "default"

# ── ApexNodes default MoA preset (domestic + managed relay) ──────────────────
# Upstream defaults point reference/aggregator slots at foreign providers
# (openai-codex, openrouter→anthropic). ApexNodes is a China-first MANAGED RELAY
# product: the local runtime sends every inference call to the OpenAI-compatible
# relay (custom provider `Apex-nodes.com`, slug `custom:apex-nodes.com`) using
# the signed-in user's relay key, and the relay bills the user's cloud account
# and routes to a domestic model (apps/desktop/electron/apex-managed.cjs +
# api-relay/main.py).
#
# So every MoA slot here uses provider `custom:apex-nodes.com`. At runtime
# agent/moa_loop.py:_slot_runtime() calls resolve_runtime_provider(requested=
# "custom:apex-nodes.com"), which matches the desktop-seeded `custom_providers`
# entry and returns the relay base_url + the user's key — i.e. reference AND
# aggregator calls go through the same relay as normal chat (verified). No
# foreign endpoint is ever contacted.
#
# ⚠️ Model ids below are RELAY CATALOG ROUTE NAMES (no `-APEX` display suffix).
# Per-request routing landed in the relay (api-relay/main.py:_select_requested_
# model, hc-184/#448): for the MANAGED path the relay honours the request's
# `model` field only when it clears BOTH DB gates — the plan's
# `entitlements.allowed_models` AND a catalog entry that is present + `enabled`
# (matched case-insensitively, fail-closed on disabled). A name that misses
# either gate returns None and silently falls back to the agent's default model
# (deepseek-v4-pro), so a `-APEX` display name would NOT match the catalog
# (`glm-5.2`, etc.) and could never diverge. These names MUST therefore stay in
# sync with the `api-relay` catalog (_default_platform_model_catalog) + each
# plan's allowed_models.
#
# Today only `deepseek-v4-pro` (+ `deepseek-v4-flash`) are `enabled` in the
# catalog; `glm-5.2` / `kimi-k2.6` are `enabled: False` and `qwen3.7-max` is not
# in the managed catalog yet (it exists as a BYOK preset). So glm-5.2 + qwen3.7-
# max currently fall back to deepseek-v4-pro — MoA plumbing runs end-to-end but
# true model diversity only switches on once those catalog rows are enabled (and
# qwen3.7-max added + allow-listed). After Kael's benchmark, adjust the model
# names here (mirror the `moa:` block in cli-config.yaml.example).
APEX_MOA_PROVIDER = "custom:apex-nodes.com"

DEFAULT_MOA_REFERENCE_MODELS: list[dict[str, str]] = [
    {"provider": APEX_MOA_PROVIDER, "model": "deepseek-v4-pro"},
    {"provider": APEX_MOA_PROVIDER, "model": "glm-5.2"},
    {"provider": APEX_MOA_PROVIDER, "model": "qwen3.7-max"},
]

DEFAULT_MOA_AGGREGATOR: dict[str, str] = {
    "provider": APEX_MOA_PROVIDER,
    "model": "deepseek-v4-pro",
}


def _clean_slot(slot: Any) -> dict[str, str] | None:
    if not isinstance(slot, dict):
        return None
    provider = str(slot.get("provider") or "").strip()
    model = str(slot.get("model") or "").strip()
    if not provider or not model:
        return None
    return {"provider": provider, "model": model}


def _default_preset() -> dict[str, Any]:
    return {
        "reference_models": deepcopy(DEFAULT_MOA_REFERENCE_MODELS),
        "aggregator": deepcopy(DEFAULT_MOA_AGGREGATOR),
        "reference_temperature": 0.6,
        "aggregator_temperature": 0.4,
        "max_tokens": 4096,
        "enabled": True,
    }


def _normalize_preset(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}

    refs = [_clean_slot(item) for item in raw.get("reference_models") or []]
    refs = [item for item in refs if item is not None]
    if not refs:
        refs = deepcopy(DEFAULT_MOA_REFERENCE_MODELS)

    aggregator = _clean_slot(raw.get("aggregator")) or deepcopy(DEFAULT_MOA_AGGREGATOR)

    return {
        "enabled": bool(raw.get("enabled", True)),
        "reference_models": refs,
        "aggregator": aggregator,
        "reference_temperature": float(raw.get("reference_temperature", 0.6) or 0.6),
        "aggregator_temperature": float(raw.get("aggregator_temperature", 0.4) or 0.4),
        "max_tokens": int(raw.get("max_tokens", 4096) or 4096),
    }


def normalize_moa_config(raw: Any) -> dict[str, Any]:
    """Return validated MoA config with named presets.

    Backward compatible with the first PR shape where ``moa`` itself contained
    ``reference_models`` and ``aggregator`` directly.
    """
    if not isinstance(raw, dict):
        raw = {}

    presets_raw = raw.get("presets")
    presets: dict[str, dict[str, Any]] = {}
    if isinstance(presets_raw, dict):
        for name, preset in presets_raw.items():
            clean_name = str(name or "").strip()
            if clean_name:
                presets[clean_name] = _normalize_preset(preset)

    # Legacy flat config becomes the default preset.
    if not presets:
        presets[DEFAULT_MOA_PRESET_NAME] = _normalize_preset(raw)

    default_name = str(raw.get("default_preset") or "").strip()
    if not default_name or default_name not in presets:
        default_name = next(iter(presets), DEFAULT_MOA_PRESET_NAME)
    if default_name not in presets:
        presets[default_name] = _default_preset()

    active_name = str(raw.get("active_preset") or "").strip()
    if active_name not in presets:
        active_name = ""

    active = presets[default_name]
    return {
        "default_preset": default_name,
        "active_preset": active_name,
        "presets": presets,
        # Compatibility/flattened view for existing dashboard/desktop callers.
        "reference_models": deepcopy(active["reference_models"]),
        "aggregator": deepcopy(active["aggregator"]),
        "reference_temperature": active["reference_temperature"],
        "aggregator_temperature": active["aggregator_temperature"],
        "max_tokens": active["max_tokens"],
        "enabled": active["enabled"],
    }


def list_moa_presets(config: Any) -> list[str]:
    cfg = normalize_moa_config(config)
    return list(cfg["presets"].keys())


def resolve_moa_preset(config: Any, name: str | None = None) -> dict[str, Any]:
    cfg = normalize_moa_config(config)
    preset_name = str(name or cfg.get("default_preset") or DEFAULT_MOA_PRESET_NAME).strip()
    preset = cfg["presets"].get(preset_name)
    if preset is None:
        raise KeyError(preset_name)
    return deepcopy(preset)


def exact_moa_preset_name(config: Any, text: str) -> str | None:
    wanted = str(text or "").strip()
    if not wanted:
        return None
    cfg = normalize_moa_config(config)
    return wanted if wanted in cfg["presets"] else None


def set_active_moa_preset(config: Any, name: str | None) -> dict[str, Any]:
    cfg = normalize_moa_config(config)
    clean = str(name or "").strip()
    if clean and clean not in cfg["presets"]:
        raise KeyError(clean)
    cfg["active_preset"] = clean
    return cfg


def encode_moa_turn(prompt: str, config: Any = None, preset: str | None = None) -> str:
    """Encode a /moa one-shot turn for frontends that can only send text."""
    payload = {
        "prompt": str(prompt or ""),
        "config": resolve_moa_preset(config or {}, preset),
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    return f"{MOA_MARKER_PREFIX}{encoded}"


def decode_moa_turn(message: Any) -> tuple[str, dict[str, Any] | None]:
    """Decode a hidden /moa one-shot marker."""
    if not isinstance(message, str) or not message.startswith(MOA_MARKER_PREFIX):
        return message, None
    encoded = message[len(MOA_MARKER_PREFIX):].strip()
    try:
        payload = json.loads(base64.urlsafe_b64decode(encoded.encode("ascii")).decode("utf-8"))
    except Exception:
        return message, None
    prompt = str(payload.get("prompt") or "")
    return prompt, _normalize_preset(payload.get("config") or {})


def build_moa_turn_prompt(user_prompt: str, config: Any = None, preset: str | None = None) -> str:
    """Build the hidden one-shot payload used by TUI/gateway routing."""
    return encode_moa_turn(user_prompt, config, preset=preset)


def moa_usage() -> str:
    return "Usage: /moa <prompt>  (runs one prompt through the default MoA preset, then restores your model; pick a preset from the model picker to switch for the session)"
