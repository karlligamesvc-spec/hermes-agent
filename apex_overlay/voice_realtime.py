"""hc-906: native Qwen voice through APEX; vendor credentials never enter the runtime."""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from dotenv import dotenv_values
from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect

DEFAULT_MODEL = 'qwen-audio-3.0-realtime-flash'
DEFAULT_VOICE = 'longanqian'
MODELS = frozenset({DEFAULT_MODEL, 'qwen-audio-3.0-realtime-plus'})
RELAY_BASE = 'https://apex-nodes.com/relay/v1'
# The public relay rejects generic Python clients at its edge. Identify both
# the status probe and the WebSocket as the same first-party Desktop client.
CLIENT_USER_AGENT = 'APEX-Desktop/1'
QWEN_PERSONA = (
    '你是 APEX 语音助手。用自然简短的中文回答，也可以跟随用户语言。'
    '闲聊可以直接回答。用户要求查询事实、操作文件、运行命令、安排任务、修改已有任务或需要推理时，'
    '必须先调用 apex_assistant，把用户最新完整要求传给它；只有拿到结果后才能报告事实或完成情况。'
    '不要编造操作结果。等待工具时可以简短说明正在处理。被打断立即停止说话。'
    '用户只说停止、暂停语音或结束通话时，不调用工具。'
)


def resolve_connection() -> tuple[str, str, dict]:
    from hermes_cli.config import load_config
    from hermes_cli.env_loader import hydrate_profile_secret_sources
    from hermes_constants import get_hermes_home, get_process_hermes_home

    cfg = load_config()
    home = get_hermes_home()
    secrets = dict(dotenv_values(home / '.env'))
    secrets.update(hydrate_profile_secret_sources(home))
    # A foreign profile must never borrow the process/default profile's identity.
    key = str(secrets.get('TOOLS_GATEWAY_KEY') or '')
    if home.resolve() == get_process_hermes_home().resolve():
        key = key or os.getenv('TOOLS_GATEWAY_KEY', '')
    base = RELAY_BASE
    for entry in cfg.get('custom_providers') or []:
        if str(entry.get('name', '')).lower() == 'apex-nodes.com':
            key = key or str(entry.get('api_key') or '')
            base = str(entry.get('base_url') or RELAY_BASE).rstrip('/')
            break
    voice = cfg.get('voice') or {}
    section = voice.get('qwen_realtime') or {}
    model = str(section.get('model') or DEFAULT_MODEL)
    if model not in MODELS:
        raise ValueError('不支持此千问实时语音模型。')
    return key, base, {'model': model, 'voice': str(section.get('voice') or DEFAULT_VOICE)}


def status() -> dict:
    key, base, settings = resolve_connection()
    result = {'mode': 'qwen-realtime', 'available': False, 'reason': '请先登录 APEX。', **settings}
    if not key:
        return result
    request = urllib.request.Request(base + '/audio/realtime/status?' + urllib.parse.urlencode({'model': settings['model']}), headers={
        'Authorization': 'Bearer ' + key, 'User-Agent': CLIENT_USER_AGENT,
    })
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            upstream = json.load(response)
        result.update(available=bool(upstream.get('available')), reason=upstream.get('reason'))
    except urllib.error.HTTPError as exc:
        result['reason'] = 'APEX 登录或额度不可用，请重新登录或检查额度。' if exc.code in (401, 402, 403) else '千问实时语音服务暂不可用。'
    except (OSError, ValueError):
        result['reason'] = '暂时无法连接语音服务，请重试。'
    return result


def session_config(settings: dict) -> dict:
    return {'type': 'session.update', 'session': {
        'modalities': ['text', 'audio'], 'voice': settings['voice'], 'instructions': QWEN_PERSONA,
        'input_audio_format': 'pcm', 'output_audio_format': 'pcm',
        'turn_detection': {'type': 'server_vad', 'threshold': 0.5, 'silence_duration_ms': 700},
        'input_audio_transcription': {'model': 'qwen-audio-3.0-asr-flash'},
        'tools': [{'type': 'function', 'function': {
            'name': 'apex_assistant', 'description': '查询事实、推理或执行任何工作，返回 APEX 助手的真实结果。',
            'parameters': {'type': 'object', 'properties': {'request': {'type': 'string'}}, 'required': ['request']},
        }}],
    }}


async def serve(ws: WebSocket, connection: tuple[str, str, dict]) -> None:
    key, base, settings = connection
    if not key:
        raise ValueError('请先登录 APEX。')
    start = await asyncio.wait_for(ws.receive_json(), 15)
    if start.get('type') != 'apex.start':
        raise ValueError('无效语音会话。')
    history = start.get('history') or []
    if (not isinstance(history, list) or len(history) > 24 or len(json.dumps(history)) > 30000
            or any(not isinstance(item, dict) or not isinstance(item.get('content', []), list) for item in history)):
        raise ValueError('语音历史过长。')
    url = base.replace('https://', 'wss://', 1).replace('http://', 'ws://', 1)
    url += '/audio/realtime?model=' + settings['model']
    tasks = []
    try:
        async with connect(url, additional_headers={'Authorization': 'Bearer ' + key},
                           user_agent_header=CLIENT_USER_AGENT, open_timeout=15, max_size=256 * 1024) as upstream:
            first = json.loads(await asyncio.wait_for(upstream.recv(), 20))
            if first.get('type') == 'error':
                await ws.send_json(first)
                return
            await upstream.send(json.dumps(session_config(settings), ensure_ascii=False))
            for item in history:
                if item.get('role') not in {'user', 'assistant'}:
                    continue
                content = item.get('content') or []
                text = '\n'.join(str(part.get('text') or '') for part in content if isinstance(part, dict))[:1200]
                await upstream.send(json.dumps({'type': 'conversation.item.create', 'item': {
                    'type': 'message', 'role': item['role'], 'content': [{'type': 'input_text' if item['role'] == 'user' else 'text', 'text': text}],
                }}, ensure_ascii=False))
            await ws.send_json(first)

            async def client_to_relay():
                while True:
                    text = await ws.receive_text()
                    if len(text.encode()) > 256 * 1024:
                        raise ValueError('语音数据过大。')
                    event = json.loads(text)
                    # Session authority is fixed here, never replaced by a renderer config.
                    if event.get('type') not in {'input_audio_buffer.append', 'input_audio_buffer.commit',
                                                'response.cancel', 'response.create', 'conversation.item.create',
                                                'conversation.item.truncate'}:
                        raise ValueError('不支持此语音事件。')
                    await upstream.send(text)

            async def relay_to_client():
                async for text in upstream:
                    await ws.send_text(text)

            tasks = [asyncio.create_task(client_to_relay()), asyncio.create_task(relay_to_client())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    except WebSocketDisconnect:
        pass
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
