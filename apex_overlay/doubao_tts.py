"""APEX default narration via Scheduler; no vendor secrets or silent fallback."""

from __future__ import annotations

import copy
import json
import logging
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import dotenv_values

from agent.tts_provider import TTSProvider

logger = logging.getLogger(__name__)

PUBLIC_BASE = "https://api.apex-nodes.com/api/v1"
MAX_AUDIO_BYTES = 18 * 1024 * 1024
# The Scheduler route accepts 0.5–2.0 (app/routers/tts.py); the tool itself clamps to 0.25–4.0.
MIN_SPEED, MAX_SPEED = 0.5, 2.0

# hc-1007: what the model reads while Doubao is the active provider. Upstream's text names
# Edge and OpenAI, and on 0.17.58 a model cutting a video wrote its own edge-tts code and then
# used macOS `say` instead of calling this tool (2026-10-21; Scheduler saw no TTS call).
NARRATION_DESCRIPTION = (
    "把文字合成语音，默认用 APEX 平台的豆包配音（seed-tts-2.0，中文女声）。"
    "视频配音、旁白、口播、朗读一律调用本工具：它返回音频文件（MEDIA: 路径），"
    "在 Hypit、ffmpeg 或脚本里直接引用这个文件。"
    "不要在终端或代码里自己用 edge-tts、gTTS、pyttsx3、macOS say 或其他系统声音代替。"
    "本工具失败时把错误告诉用户，不要换别的声音顶上。"
    "长文按原顺序自动分段合成，不用自己拆。声音由用户的设置决定，不由你选择。"
)


def narration_parameters(parameters: dict, home: str) -> dict:
    params = copy.deepcopy(parameters)
    props = params["properties"]
    props["text"]["description"] = "要读出来的文字。"
    props["output_path"]["description"] = (
        f"可选：音频保存路径，比如剪辑工程里的 narration.mp3；豆包配音总是存成 .mp3。不填就存到 {home}/audio_cache/。"
    )
    props["speed"]["description"] = "可选：语速倍数，1.0 为正常，范围 0.5–2.0，超出按边界处理。"
    props["instructions"]["description"] = "豆包配音不使用这个参数，不用填。"
    return params


def install_narration_schema(tts_tool) -> bool:
    """While Doubao is the active provider, show the model the Chinese narration description."""
    from hermes_constants import display_hermes_home
    from tools.registry import registry

    entry = registry.get_entry("text_to_speech")
    if entry is None:
        return False
    original = entry.dynamic_schema_overrides
    if getattr(original, "_apex_doubao_schema", False):
        return True

    def overrides():
        result = dict(original() or {}) if original is not None else {}
        # An explicitly chosen BYOK provider keeps upstream's description.
        if tts_tool._get_provider(tts_tool._load_tts_config()) != "doubao":
            return result
        parameters = result.get("parameters") or tts_tool.TTS_SCHEMA["parameters"]
        return {**result, "description": NARRATION_DESCRIPTION,
                "parameters": narration_parameters(parameters, display_hermes_home())}

    overrides._apex_doubao_schema = True
    entry.dynamic_schema_overrides = overrides
    return True


def connection() -> tuple[str, str]:
    from hermes_cli.config import load_config
    from hermes_cli.env_loader import hydrate_profile_secret_sources
    from hermes_constants import get_hermes_home, get_process_hermes_home

    home = get_hermes_home()
    secrets = dict(dotenv_values(home / '.env'))
    secrets.update(hydrate_profile_secret_sources(home))
    keys = ('TOOLS_GATEWAY_KEY', 'API_SERVER_KEY', 'MODEL_API_KEY')
    key = next((str(secrets[k]) for k in keys if secrets.get(k)), '')
    same_home = home.resolve() == get_process_hermes_home().resolve()
    if same_home and not key:
        key = next((os.environ[k] for k in keys if os.environ.get(k)), '')
    if not key:
        for item in load_config().get('custom_providers') or []:
            if item.get('name', '').lower() == 'apex-nodes.com':
                key = str(item.get('api_key') or '')
                break
    # A foreign profile must not inherit the process identity or private endpoint.
    base = (os.getenv('HERMES_PLATFORM_API_BASE') or PUBLIC_BASE) if same_home else PUBLIC_BASE
    return key, base.rstrip('/')


class DoubaoTTS(TTSProvider):
    name = 'doubao'

    def is_available(self) -> bool:
        return bool(connection()[0])

    def synthesize(self, text, output_path, *, voice=None, model=None, speed=None, format='mp3', **extra):
        if model not in (None, 'seed-tts-2.0'):
            raise ValueError('豆包配音仅支持 seed-tts-2.0。')
        key, base = connection()
        if not key:
            raise ValueError('请先登录 APEX，再生成豆包配音。')
        payload = {'text': text, 'speed': 1.0 if speed is None else min(MAX_SPEED, max(MIN_SPEED, float(speed)))}
        if voice:
            payload['voice'] = voice
        request = urllib.request.Request(
            base + '/tools/v1/tts/synthesize',
            data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                     'User-Agent': 'APEX-Desktop/1'}, method='POST',
        )
        # Never follow a redirect with the platform key to a different host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        try:
            opener = urllib.request.build_opener(NoRedirect)
            with opener.open(request, timeout=110) as response:
                if response.headers.get_content_type() != 'audio/mpeg':
                    raise ValueError('豆包配音未返回音频文件。')
                audio = response.read(MAX_AUDIO_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise ValueError(f'豆包配音请求失败（HTTP {exc.code}），请重试或联系平台管理员；未切换其他声音。') from None
        except OSError:
            raise ValueError('豆包配音连接中断，请重试；未切换其他声音。') from None
        if len(audio) < 4 or len(audio) > MAX_AUDIO_BYTES or not (
            audio.startswith(b'ID3') or (audio[0] == 255 and audio[1] & 224 == 224)
        ):
            raise ValueError('豆包配音结果为空、损坏或超出大小限制。')
        target = Path(output_path).with_suffix('.mp3')
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as file:
                temporary = Path(file.name)
                file.write(audio)
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return str(target)


def apply(ctx) -> None:
    from tools import tts_tool, tts_tool_delivery

    tts_tool.DEFAULT_PROVIDER = 'doubao'
    tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH['doubao'] = 2000
    try:
        if not install_narration_schema(tts_tool):
            logger.warning("apex-overlay: text_to_speech is not registered; the model keeps upstream's description")
    except Exception:
        logger.warning("apex-overlay: Doubao narration description did not apply", exc_info=True)
    if getattr(tts_tool._dispatch_to_plugin_provider, '_apex_doubao_guard', False):
        ctx.register_tts_provider(DoubaoTTS())
        return
    original_config = tts_tool._load_tts_config

    def load_tts_config():
        from hermes_cli.config_effective import load_user_config_effective
        # load_config includes upstream's Edge default even when the user never
        # selected it. Read the presence-sensitive layer, retaining explicit BYOK.
        selected = (load_user_config_effective(fail_closed=True).get('tts') or {}).get('provider')
        config = original_config()
        if not selected:
            config['provider'] = 'doubao'
        return config

    tts_tool._load_tts_config = load_tts_config
    original = tts_tool._dispatch_to_plugin_provider

    def dispatch(text, output_path, provider, tts_config):
        result = original(text, output_path, provider, tts_config)
        if provider == 'doubao' and result is None:
            raise ValueError('豆包配音组件未加载，请重启或更新 APEX；未切换其他声音。')
        return result

    dispatch._apex_doubao_guard = True
    tts_tool._dispatch_to_plugin_provider = dispatch

    # Install fail-closed routing before registration, so a discovery failure
    # cannot silently select Edge while unrelated overlay seams still boot.
    ctx.register_tts_provider(DoubaoTTS())
