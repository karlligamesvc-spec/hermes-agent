"""APEX default narration via Scheduler; no vendor secrets or silent fallback."""

from __future__ import annotations

import contextvars
import copy
import functools
import inspect
import json
import logging
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import dotenv_values

from agent.tts_provider import TTSProvider
from apex_overlay import hosted_profiles

logger = logging.getLogger(__name__)

PUBLIC_BASE = "https://api.apex-nodes.com/api/v1"
MAX_AUDIO_BYTES = 18 * 1024 * 1024
# The Scheduler route accepts 0.5–2.0 (app/routers/tts.py); the tool itself clamps to 0.25–4.0.
MIN_SPEED, MAX_SPEED = 0.5, 2.0

# hc-1007: what the model reads while Doubao is the active provider. Upstream's text names
# Edge and OpenAI, and on 0.17.58 a model cutting a video wrote its own edge-tts code and then
# used macOS `say` instead of calling this tool (2026-10-21; Scheduler saw no TTS call).
# hc-1296: the last sentence of the narration text while the model cannot pick a voice.
FIXED_VOICE_SENTENCE = "声音由用户的设置决定，不由你选择。"
NARRATION_DESCRIPTION = (
    "把文字合成语音，用 APEX 平台配音（默认中文女声，也能读英文等语言）。"
    "视频配音、旁白、口播、朗读一律调用本工具：它返回音频文件（MEDIA: 路径），"
    "在 Hypit、ffmpeg 或脚本里直接引用这个文件。"
    "不要在终端或代码里自己用 edge-tts、gTTS、pyttsx3、macOS say 或其他系统声音代替。"
    "本工具失败时把错误告诉用户，不要换别的声音顶上。"
    "长文按原顺序自动分段合成，不用自己拆。" + FIXED_VOICE_SENTENCE
)

# hc-1283: `instructions` is offered only while the provider that speaks sends it to Scheduler
# (`carries_instructions`); otherwise the model reads that the parameter is unused.
TONE_DESCRIPTION = (
    "可选：一句话说明怎么读，比如语气、情绪、快慢或方言（「热情一点，像直播带货」「用粤语读」），30 字以内。"
    "平台尽量照做，个别要求可能读不出来；没有特别要求就不填。"
)
UNUSED_TONE_DESCRIPTION = "平台配音不使用这个参数，不用填。"

# hc-1296: what the user is offered -> the platform's system voice (the same table as the hosted
# plugin apexnodes-doubao-tts in apex-nodes; Scheduler takes exactly these ids). The first one is
# what an omitted `voice` gets.
VOICES = (
    ("默认女声", "longanhuan_v3.1"),
    ("女声二", "longanlingxin_v3.1"),
    ("女声三", "longanfengyue_v3.1"),
    ("男声", "xunanchuan_v3.1"),
)
VOICE_DESCRIPTION = (
    "可选：用哪个声音读，只在用户选了声音时填：" + "、".join(name for name, _ in VOICES)
    + "。不填就是" + VOICES[0][0] + "。不要自己替用户换声音，也不要填这几个以外的名字。"
)
VOICE_SENTENCE = "默认是" + VOICES[0][0] + "；用户选了别的声音时用 voice 指定，不要自己替用户换。"
VOICE_HEADER = "X-TTS-Voice"


def narration_parameters(parameters: dict, home: str, *, tone: bool = False, voice: bool = False) -> dict:
    params = copy.deepcopy(parameters)
    props = params["properties"]
    props["text"]["description"] = "要读出来的文字。"
    props["output_path"]["description"] = (
        f"可选：音频保存路径，比如剪辑工程里的 narration.mp3；平台配音总是存成 .mp3。不填就存到 {home}/audio_cache/。"
    )
    props["speed"]["description"] = "可选：语速倍数，1.0 为正常，范围 0.5–2.0，超出按边界处理。"
    props["instructions"]["description"] = TONE_DESCRIPTION if tone else UNUSED_TONE_DESCRIPTION
    if voice:
        props["voice"] = {"type": "string", "description": VOICE_DESCRIPTION}
    return params


def tone_reaches_platform() -> bool:
    """Whether the `doubao` provider that would speak now sends the call's `instructions` on."""
    try:
        from agent.tts_registry import get_provider
        return bool(getattr(get_provider('doubao'), 'carries_instructions', False))
    except Exception:
        logger.debug("apex-overlay: could not ask the doubao provider about instructions", exc_info=True)
        return False


def voice_reaches_platform() -> bool:
    """hc-1296: whether the registered text_to_speech handler carries the call's `voice`."""
    try:
        from tools.registry import registry
        return _bridged(getattr(registry.get_entry("text_to_speech"), "handler", None), _CALL_VOICE, "_apex_tts_voice")
    except Exception:
        logger.debug("apex-overlay: could not ask the registry about the voice bridge", exc_info=True)
        return False


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
        voice = voice_reaches_platform()
        description = NARRATION_DESCRIPTION.replace(FIXED_VOICE_SENTENCE, VOICE_SENTENCE) if voice else NARRATION_DESCRIPTION
        return {**result, "description": description,
                "parameters": narration_parameters(parameters, display_hermes_home(), tone=tone_reaches_platform(),
                                                   voice=voice)}

    overrides._apex_doubao_schema = True
    entry.dynamic_schema_overrides = overrides
    return True


# How Settings → 语音 shows the built-in engines (prettyName of the option).
_ENGINE_NAMES = {"edge": "Edge", "elevenlabs": "Elevenlabs", "openai": "Openai", "xai": "Xai", "minimax": "Minimax",
                 "mistral": "Mistral", "gemini": "Gemini", "neutts": "Neutts", "kittentts": "Kittentts", "piper": "Piper"}


def missing_engine_message(provider: str) -> str:
    """hc-1035: what the model reads when the voice chosen in Settings has no engine in APEX.
    Upstream's text (`No TTS provider available. Enable Edge TTS with: pip install …` or run
    `hermes setup tts`) names commands an APEX user cannot run and the model rendered it as
    「无可用 TTS provider」 (2026-11-04/05). hc-1193: the list offers APEX's own voice again
    (apps/desktop/src/app/settings/apex-voice.ts), and switching back is the user's call."""
    name = _ENGINE_NAMES.get(provider, provider)
    return (
        f"配音没做成：设置 → 语音 里的「文字转语音提供方」选的是「{name}」，APEX 没带这个组件；"
        "这次没有配音，也没有换成别的声音。在这一项里改选「APEX 配音（默认）」就用回 APEX 配音。"
        "把这些照实告诉用户，由用户自己去改；不要替用户改设置，也不要自己装组件、写代码或换别的声音顶上。"
    )


def install_missing_engine_message(tts_tool) -> None:
    """Word the no-engine answer of ``_select_builtin_engine`` for APEX. Nothing else changes:
    the chosen provider stays chosen and nothing is routed to another voice."""
    original = tts_tool._select_builtin_engine
    if getattr(original, "_apex_missing_engine", False):
        return

    def select_builtin_engine(provider):
        engine, error = original(provider)
        if error is None:
            return engine, None
        logger.info("apex-overlay: TTS provider %r has no engine here: %s", provider, error)
        return provider, tts_tool._error_json(missing_engine_message(provider))

    select_builtin_engine._apex_missing_engine = True
    tts_tool._select_builtin_engine = select_builtin_engine


# hc-1283: upstream hands a plugin provider voice, model, speed and format only
# (tools/tts_tool_plugins.py::_dispatch_to_plugin_provider), so the tone line the model gave
# text_to_speech never reached Scheduler. The chunk loop passes it to _text_to_speech_single as the
# keyword-only `instructions`, and that call reaches the provider on the same thread; the wrapper
# holds it there for that one call. A runtime that passes `instructions` itself wins (synthesize's
# **extra).
_CALL_INSTRUCTIONS: contextvars.ContextVar = contextvars.ContextVar('apex_overlay_tts_instructions', default=None)


def _bridged(function, var, mark: str = '_apex_tts_instructions') -> bool:
    """Whether a wrapper in *function*'s chain sets *var* (wrappers from other code may sit on top)."""
    while function is not None:
        if getattr(function, mark, None) is var:
            return True
        function = getattr(function, '__wrapped__', None)
    return False


def install_instructions_bridge(tts_tool) -> bool:
    """Hold each call's `instructions` while _text_to_speech_single runs; False if it has none to hold."""
    original = getattr(tts_tool, '_text_to_speech_single', None)
    if original is None:
        return False
    if _bridged(original, _CALL_INSTRUCTIONS):
        return True
    parameter = inspect.signature(original).parameters.get('instructions')
    if parameter is None or parameter.kind is not inspect.Parameter.KEYWORD_ONLY:
        return False  # only a keyword-only parameter always arrives in **kwargs

    @functools.wraps(original)
    def text_to_speech_single(*args, **kwargs):
        token = _CALL_INSTRUCTIONS.set(kwargs.get('instructions'))
        try:
            return original(*args, **kwargs)
        finally:
            _CALL_INSTRUCTIONS.reset(token)

    text_to_speech_single._apex_tts_instructions = _CALL_INSTRUCTIONS
    tts_tool._text_to_speech_single = text_to_speech_single
    return True


def spoken_instructions(extra: dict) -> str | None:
    """The tone line for this synthesis: what the runtime passed, else what the model gave the tool."""
    value = extra.get('instructions')
    if value is None:
        value = _CALL_INSTRUCTIONS.get()
    return value.strip() if isinstance(value, str) and value.strip() else None


# hc-1296: the runtime takes a plugin provider's voice from `tts.voice` in the config
# (tools/tts_tool_plugins.py::_plugin_voice_kwargs) and the registered text_to_speech handler drops
# every argument it does not know, so the model could not name one of the platform's system voices
# for a call. The handler wrapper holds the call's `voice`; text_to_speech_tool loads the config once,
# on the handler's thread, and the `_load_tts_config` wrapper puts the voice into a copy of it, which
# the call then carries to every chunk. Only names in VOICES are sent on.
_CALL_VOICE: contextvars.ContextVar = contextvars.ContextVar('apex_overlay_tts_voice', default=None)


def voice_id(value) -> str | None:
    """The platform id for what the model put in `voice` (a name in VOICES, or its id); None when it gave none."""
    chosen = value.strip() if isinstance(value, str) else ''
    if not chosen:
        return None
    for name, platform_id in VOICES:
        if chosen in (name, platform_id):
            return platform_id
    raise ValueError('没有「' + chosen[:20] + '」这个声音，可以选的是：' + '、'.join(name for name, _ in VOICES)
                     + '。这次没有配音，也没有换成别的声音。')


def voice_name(platform_id: str) -> str:
    return next((name for name, known in VOICES if known == platform_id), platform_id)


def install_voice_bridge(tts_tool) -> bool:
    """Carry each call's `voice` from the registered handler into the config that call loads; False if it cannot."""
    from tools.registry import registry

    entry = registry.get_entry('text_to_speech')
    handler = getattr(entry, 'handler', None)
    load = getattr(tts_tool, '_load_tts_config', None)
    if not callable(handler) or not callable(load):
        return False
    if _bridged(handler, _CALL_VOICE, '_apex_tts_voice'):
        return True

    @functools.wraps(load)
    def load_tts_config(*args, **kwargs):
        config = load(*args, **kwargs)
        chosen = _CALL_VOICE.get()
        if chosen and isinstance(config, dict) and tts_tool._get_provider(config) == 'doubao':
            return {**config, 'voice': chosen}  # a copy: the config the runtime loaded stays as it was
        return config

    @functools.wraps(handler)
    def text_to_speech(args, **kwargs):
        try:
            chosen = voice_id(args.get('voice') if isinstance(args, dict) else None)
        except ValueError as exc:
            return json.dumps({'success': False, 'error': str(exc)}, ensure_ascii=False)
        token = _CALL_VOICE.set(chosen)
        try:
            return handler(args, **kwargs)
        finally:
            _CALL_VOICE.reset(token)

    text_to_speech._apex_tts_voice = _CALL_VOICE
    tts_tool._load_tts_config = load_tts_config
    entry.handler = text_to_speech
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
    if not same_home and not key:  # hc-1166: one engine hosting every assistant shares the account's key
        key = hosted_profiles.account_value('TOOLS_GATEWAY_KEY')
    if not key:
        for item in load_config().get('custom_providers') or []:
            if item.get('name', '').lower() == 'apex-nodes.com':
                key = str(item.get('api_key') or '')
                break
    # A foreign profile must not inherit the process identity or private endpoint, unless it is an
    # assistant hosted on one engine with the account's (hc-1166).
    own_base = os.getenv('HERMES_PLATFORM_API_BASE') if same_home else hosted_profiles.account_value('HERMES_PLATFORM_API_BASE')
    base = own_base or PUBLIC_BASE
    return key, base.rstrip('/')


class DoubaoTTS(TTSProvider):
    name = 'doubao'

    def is_available(self) -> bool:
        return bool(connection()[0])

    @property
    def carries_instructions(self) -> bool:
        """hc-1283: whether this call's `instructions` reach Scheduler (the narration text reads it)."""
        from tools import tts_tool
        return _bridged(getattr(tts_tool, '_text_to_speech_single', None), _CALL_INSTRUCTIONS)

    def synthesize(self, text, output_path, *, voice=None, model=None, speed=None, format='mp3', **extra):
        if model not in (None, 'seed-tts-2.0'):
            raise ValueError(f'平台配音不能指定模型（{model}），去掉 model 再试。')
        key, base = connection()
        if not key:
            raise ValueError('请先登录 APEX，再生成配音。')
        payload = {'text': text, 'speed': 1.0 if speed is None else min(MAX_SPEED, max(MIN_SPEED, float(speed)))}
        if voice:
            payload['voice'] = voice
        instructions = spoken_instructions(extra)
        if instructions:
            payload['instructions'] = instructions
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
                    raise ValueError('配音未返回音频文件。')
                used = (response.headers.get(VOICE_HEADER) or '').strip()
                if voice and used and used != voice:  # hc-1296: never deliver another voice as the chosen one
                    raise ValueError(f'平台这次没有用选的那个声音（{voice_name(voice)}），这段配音没有交付；'
                                     '告诉用户这个声音现在用不了，要不要先用' + VOICES[0][0] + '。')
                audio = response.read(MAX_AUDIO_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise ValueError(f'配音请求失败（HTTP {exc.code}），请重试或联系平台管理员；未切换其他声音。') from None
        except OSError:
            raise ValueError('配音连接中断，请重试；未切换其他声音。') from None
        if len(audio) < 4 or len(audio) > MAX_AUDIO_BYTES or not (
            audio.startswith(b'ID3') or (audio[0] == 255 and audio[1] & 224 == 224)
        ):
            raise ValueError('配音结果为空、损坏或超出大小限制。')
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


def _apply_voice_bridge(tts_tool) -> None:
    try:
        if not install_voice_bridge(tts_tool):
            logger.warning('apex-overlay: no text_to_speech handler or config loader to carry a voice; '
                           'the narration text says the voice is fixed')
    except Exception:
        logger.warning('apex-overlay: the narration voice bridge did not apply', exc_info=True)


def apply(ctx) -> None:
    from tools import tts_tool, tts_tool_delivery

    tts_tool.DEFAULT_PROVIDER = 'doubao'
    tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH['doubao'] = 2000
    try:
        if not install_narration_schema(tts_tool):
            logger.warning("apex-overlay: text_to_speech is not registered; the model keeps upstream's description")
    except Exception:
        logger.warning("apex-overlay: Doubao narration description did not apply", exc_info=True)
    install_missing_engine_message(tts_tool)
    try:
        if not install_instructions_bridge(tts_tool):
            logger.warning("apex-overlay: _text_to_speech_single takes no keyword-only instructions; "
                           "the narration text says the tone line is unused")
    except Exception:
        logger.warning("apex-overlay: the narration tone bridge did not apply", exc_info=True)
    if getattr(tts_tool._dispatch_to_plugin_provider, '_apex_doubao_guard', False):
        _apply_voice_bridge(tts_tool)
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
            raise ValueError('配音组件未加载，请重启或更新 APEX；未切换其他声音。')
        return result

    dispatch._apex_doubao_guard = True
    tts_tool._dispatch_to_plugin_provider = dispatch
    _apply_voice_bridge(tts_tool)  # after load_tts_config above: the voice goes to whoever speaks by default

    # Install fail-closed routing before registration, so a discovery failure
    # cannot silently select Edge while unrelated overlay seams still boot.
    ctx.register_tts_provider(DoubaoTTS())
