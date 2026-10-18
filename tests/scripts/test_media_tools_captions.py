"""hc-926: the bundled FFmpeg must burn in Chinese captions (drawtext + subtitles).

APEX Desktop 0.17.58's FFmpeg 9.0.2 had neither filter, so the Agent drew captions as PNGs
with Pillow. The recipe now links FreeType/FriBidi/HarfBuzz/libunibreak/libass, and the
native smoke (``mirror.py smoke``) proves the filters on each target before publication.

CI cannot build FFmpeg, so these tests pin the parts that run without a build: the smoke's
decisions on rendered pixels, and that builder and publisher agree on what a package holds.
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

MEDIA_TOOLS = Path(__file__).resolve().parents[2] / "scripts/media-tools"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, MEDIA_TOOLS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mirror = _load("media_mirror_captions", "mirror.py")
publisher = _load("media_publisher_captions", "publish.py")


def _band(top: int, height: int, total: int = 360) -> list[int]:
    return [40 if top <= row < top + height else 0 for row in range(total)]


@pytest.fixture
def font_host(tmp_path, monkeypatch):
    font = tmp_path / "system-font.ttc"
    font.write_bytes(b"font bytes")
    monkeypatch.setattr(mirror.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(mirror, "CJK_FONT_FILES", {"Darwin": (str(tmp_path / "absent.ttc"), str(font))})
    work = tmp_path / "work"
    work.mkdir()
    return work


def _fake_renders(monkeypatch, renders: dict[str, tuple[list[int], str]]):
    """Answer lit_rows by filter kind; record the filters the smoke asked for."""
    seen: list[str] = []

    def lit_rows(_ffmpeg, _folder, video_filter):
        seen.append(video_filter)
        kind = "long" if "long.srt" in video_filter else video_filter.split("=", 1)[0]
        return renders[kind]

    monkeypatch.setattr(mirror, "lit_rows", lit_rows)
    return seen


def test_caption_checks_pass_when_both_filters_draw_and_long_lines_wrap(font_host, monkeypatch):
    seen = _fake_renders(monkeypatch, {
        "drawtext": (_band(150, 40), ""),
        "subtitles": (_band(300, 30), ""),
        "long": (_band(240, 70), ""),
    })
    mirror.caption_checks("ffmpeg", font_host)
    assert (font_host / "font.ttc").read_bytes() == b"font bytes"  # first font that exists
    assert (font_host / "caption.txt").read_text(encoding="utf-8") == mirror.CAPTION
    assert "FontName=Hiragino Sans GB" in seen[1]
    assert len(seen) == 3


@pytest.mark.parametrize(("renders", "message"), [
    ({"drawtext": ([0] * 360, "")}, "drawtext rendered no visible text"),
    ({"drawtext": (_band(150, 40), ""), "subtitles": ([0] * 360, "")}, "subtitles did not render"),
    ({"drawtext": (_band(150, 40), ""),
      "subtitles": (_band(300, 30), "fontselect: failed to find any fallback with glyph 0x4E2D")},
     "subtitles did not render"),
    ({"drawtext": (_band(150, 40), ""), "subtitles": (_band(300, 30), ""), "long": (_band(300, 30), "")},
     "did not wrap"),
], ids=["no-drawtext-pixels", "no-subtitle-pixels", "missing-cjk-glyph", "no-line-wrap"])
def test_caption_checks_fail_closed(font_host, monkeypatch, renders, message):
    _fake_renders(monkeypatch, renders)
    with pytest.raises(ValueError, match=message):
        mirror.caption_checks("ffmpeg", font_host)


def test_caption_checks_need_a_cjk_system_font(tmp_path, monkeypatch):
    monkeypatch.setattr(mirror.platform, "system", lambda: "Windows")
    monkeypatch.setattr(mirror, "CJK_FONT_FILES", {"Windows": (str(tmp_path / "msyh.ttc"),)})
    with pytest.raises(ValueError, match="No CJK system font"):
        mirror.caption_checks("ffmpeg.exe", tmp_path)


def test_builder_and_publisher_agree_on_linked_sources_checks_and_licenses():
    lock = json.loads((MEDIA_TOOLS / "source-lock.json").read_text(encoding="utf-8"))
    assert tuple(publisher.SOURCE_LICENSES) == mirror.SOURCES
    assert publisher.CHECKS == mirror.CHECKS
    for name in mirror.SOURCES:
        assert lock[name]["url"].startswith("https://"), name
        assert re.fullmatch(r"[0-9a-f]{64}", lock[name]["sha256"]), name
        assert publisher.source_archive(name, lock[name]) == mirror.source_archive(name, lock[name])
    # Every license the publisher requires is copied into the package by an executable
    # line of build.sh (comments stripped), not merely mentioned.
    code = [line.split("#", 1)[0] for line in (MEDIA_TOOLS / "build.sh").read_text(encoding="utf-8").splitlines()]
    copied = {match for line in code for match in re.findall(r'^cp "[^"]+" "\$work/package/([^"/]+)"$', line.strip())}
    assert set(publisher.SOURCE_LICENSES.values()) <= copied
