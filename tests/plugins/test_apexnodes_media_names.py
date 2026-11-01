"""hc-1130: 生成文件的名字取提示词第一句的开头,不是整段提示词。"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _gateway():
    spec = importlib.util.spec_from_file_location("hc1130_gateway", REPO / "plugins" / "apexnodes_gateway.py")
    module = importlib.util.module_from_spec(spec)
    # dataclasses in the module look themselves up in sys.modules while it loads.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("prompt", "hint"),
    [
        # hc-1126 的真实提示词开头
        ("一条 15 秒的竖屏短视频，分三个镜头，镜头之间硬切，三个镜头里是同一个人", "一条 15 秒的竖屏短视频"),
        ("收纳架封面，暖色调。", "收纳架封面"),
        ("A vertical clip of a kitchen, three shots", "A vertical clip of a"),
        # 数字里的点不算句子结束
        ("时长 12.5 秒的口播，竖屏", "时长 12.5 秒的口播"),
        ("  厨房\n第二行不算", "厨房"),
        ("这一句一直没有标点所以只取前面二十个字到这里就够了后面都不要", "这一句一直没有标点所以只取前面二十个字到"),
        ("", ""),
    ],
)
def test_media_title_hint(prompt: str, hint: str) -> None:
    assert _gateway().media_title_hint(prompt) == hint


def test_the_cached_name_reads_as_the_hint_plus_its_tail(tmp_path, monkeypatch) -> None:
    gateway = _gateway()

    class Stream:
        status_code = 200
        headers = {"Content-Length": "2", "Content-Type": "video/mp4"}

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def raise_for_status(self):
            return None

        def iter_bytes(self, *_args, **_kwargs):
            yield b"ok"

    class Client:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def stream(self, *_args, **_kwargs):
            return Stream()

    monkeypatch.setattr(gateway.httpx, "Client", Client)

    saved = gateway.download_media(
        "https://cdn.example.com/x.mp4",
        dest_dir=tmp_path,
        filename_hint=gateway.media_title_hint("一条 15 秒的竖屏短视频，分三个镜头，镜头之间硬切"),
    )

    assert saved.name.startswith("一条_15_秒的竖屏短视频_")
    assert "分三个镜头" not in saved.name
    assert saved.suffix == ".mp4"


@pytest.mark.parametrize(
    ("plugin", "line"),
    [
        ("apexnodes-video-tools", 'filename_hint=_gateway.media_title_hint(prompt) or "generated_video"'),
        ("apexnodes-image-tools", "filename_hint=f\"{_gateway.media_title_hint(prompt) or 'image'}_{index}\""),
    ],
)
def test_both_generators_name_their_files_by_the_hint(plugin: str, line: str) -> None:
    source = (REPO / "plugins" / plugin / "__init__.py").read_text(encoding="utf-8")

    assert line in source
    assert "prompt[:" not in source.split("download_media(", 1)[1].split("\n", 1)[0]
