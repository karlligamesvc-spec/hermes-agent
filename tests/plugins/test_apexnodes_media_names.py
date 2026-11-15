"""hc-1130: 生成文件的名字取提示词第一句的开头,不是整段提示词。

hc-1243: 写给模型看的格式不算名字。MiniMax H3 的提示词以 ``subject_definitions:`` 开头,
每条 H3 出的视频都存成 ``subject_definitions_<hash>.mp4``,交付区叫「subject definitions」。
名字依次取台词、第一个主体是什么、去掉段名和标签后的第一句;只说参考图是谁的第一句不给名字。
The prompts below follow MiniMax's published layout with made-up content; the platform
skill's own examples (apex-nodes ``video-shot-prompts/references/minimax-h3.md``) are
checked against this code from the apex-nodes side, which reads fork main.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import types
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


def _serve_bytes(monkeypatch, gateway, content_type: str = "video/mp4") -> None:
    """Every download answers 200 with two bytes (httpx is one module for every loader)."""

    class Stream:
        status_code = 200
        headers = {"Content-Length": "2", "Content-Type": content_type}

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
    _serve_bytes(monkeypatch, gateway)

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


# ---------------------------------------------------------------------------
# hc-1243: what a prompt says about its own layout is never the name
# ---------------------------------------------------------------------------

# Reference generation (六段): a person who speaks.
H3_SPOKEN = """subject_definitions:
<Subject 1> is the baker in <Picture 1>: grey beard, round glasses, brown apron.

summary:
[reference generation] An 8-second clip in two shots: <Subject 1> slices a loaf at the counter and talks about it.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - his beard, glasses and apron from <Picture 1>.

detailed_description:
[Shot 1] <Subject 1> stands behind a flour-dusted counter. <Subject 1>, a man in his sixties with a low voice (S1), says: <d>[Chinese] 面包要等凉了再切。</d>
[Shot 2] At 00:04.000, the camera cuts to the knife going through the crust.

overall_soundscape:
An oven fan and the crackle of the crust.

non_diegetic_music:
N/A"""

# Reference generation: a product, nobody speaks.
H3_PRODUCT = """subject_definitions:
<Subject 1> is the red enamel teapot in <Picture 1>: round body, black knob on the lid.

summary:
[reference generation] A 6-second clip: <Subject 1> on a stove as the water comes to the boil.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the teapot's shape and colour from <Picture 1>.

detailed_description:
[Shot 1] A side shot of <Subject 1> on a gas ring; steam starts to curl from the spout.

overall_soundscape:
A rising whistle.

non_diegetic_music:
N/A"""

H3_SILENT_PERSON = H3_SPOKEN.replace(
    "<Subject 1> is the baker in <Picture 1>", "<Subject 1> is the baker with round glasses in <Picture 1>"
).replace(" (S1), says: <d>[Chinese] 面包要等凉了再切。</d>", " nods.")

# Text to video (三段) with a spoken line.
H3_TEXT_ONLY = (
    "integrated_multimodal_description: A 6-second clip on a rainy street. "
    "[Shot 1] A wide shot of a boy running for a bus with a newspaper over his head. The boy (S1) shouts: "
    "<d>[Chinese] 等等我！</d> [Shot 2] At 00:03.000, the camera cuts to the bus doors closing.\n\n"
    "overall_soundscape: Rain on the pavement and a bus engine.\n\n"
    "non_diegetic_music: N/A"
)

# First-frame mode: one line that binds <Picture 1> to the first frame, then the three sections; nobody speaks.
H3_FIRST_FRAME = (
    "For the target video, <Picture 1> is the opening frame.\n\n"
    "integrated_multimodal_description: [Shot 1] A paper boat drifts along a gutter after the rain, the camera follows it low.\n\n"
    "overall_soundscape: Dripping water.\n\n"
    "non_diegetic_music: N/A"
)

LAYOUT_WORDS = re.compile(r"subject|definition|integrated|multimodal|summary|retention|picture|shot|reference|_|<|\[", re.IGNORECASE)


@pytest.mark.parametrize(
    ("prompt", "hint"),
    [
        pytest.param(H3_SPOKEN, "面包要等凉了再切", id="h3-reference-spoken-line"),
        pytest.param(H3_PRODUCT, "red enamel teapot", id="h3-reference-what-subject-1-is"),
        pytest.param(H3_SILENT_PERSON, "baker with round glasses", id="h3-reference-a-word-is-finished-not-halved"),
        pytest.param(H3_TEXT_ONLY, "等等我", id="h3-text-only-spoken-line"),
        pytest.param(H3_FIRST_FRAME, "A paper boat drifts", id="h3-first-frame-line-and-tags-dropped"),
    ],
)
def test_an_h3_prompt_is_named_by_what_it_shows(prompt: str, hint: str) -> None:
    name = _gateway().media_title_hint(prompt)

    assert name == hint
    assert not LAYOUT_WORDS.search(name)


@pytest.mark.parametrize(
    ("prompt", "hint"),
    [
        # 参考图编号和它的「的」不进名字 (image-generation 技能的写法)
        pytest.param("图片1 的男生背着图片2 的书包，站在公交站旁，全身，阴天", "男生背着书包", id="zh-picture-possessive"),
        pytest.param("<Picture 1> with the umbrella from <Picture 2>, at a bus stop", "with the umbrella", id="en-picture-phrase"),
        pytest.param("<Subject 1> 是图片1里的男生：圆脸，寸头", "男生", id="zh-subject-definition"),
        # 只说参考图是谁：不给名字，交给调用方的通用名(结果卡片显示「图片」「视频」)
        pytest.param("图片1 和图片2 是同一只猫，按这两张画它", "", id="zh-pictures-binding"),
        pytest.param("图片1、2 都是它，保留花色", "", id="zh-pictures-binding-short-list"),
        pytest.param("<Picture 1> and <Picture 2> show the same cat. Keep its markings.", "", id="en-pictures-binding"),
        # 行首的小标题不算名字
        pytest.param("人物：三十岁左右的男店主，圆脸", "三十岁左右的男店主", id="zh-label"),
        pytest.param("Scene: a quiet kitchen at dawn", "a quiet kitchen at dawn", id="en-label"),
    ],
)
def test_picture_tags_bindings_and_labels_are_not_names(prompt: str, hint: str) -> None:
    assert _gateway().media_title_hint(prompt) == hint


# --- the files the generators save -----------------------------------------


def _load_plugin(name: str):
    slug = name.replace("-", "_")
    module_name = f"hermes_plugins.{slug}_names"
    plugin_dir = REPO / "plugins" / name
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def hermes_home(tmp_path, monkeypatch) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest.mark.parametrize(
    ("prompt", "stem"),
    [
        pytest.param(H3_SPOKEN, "面包要等凉了再切", id="spoken-line"),
        pytest.param(H3_PRODUCT, "red_enamel_teapot", id="subject"),
        pytest.param("图片1 和图片2 是同一只猫，按这两张画它", "generated_video", id="binding-keeps-the-generic-stem"),
    ],
)
def test_the_video_generator_saves_the_clip_under_that_name(monkeypatch, hermes_home, prompt: str, stem: str) -> None:
    video = _load_plugin("apexnodes-video-tools")
    _serve_bytes(monkeypatch, video._gateway)

    result = json.loads(video._localize_gateway_video({"video_url": "https://cdn.example.com/out.mp4"}, prompt))

    saved = Path(result["video_path"])
    assert saved.parent == hermes_home / "cache" / "media"
    assert re.fullmatch(rf"{stem}_[0-9a-f]{{8}}\.mp4", saved.name), saved.name
    assert result["media_tag"] == f"MEDIA:{saved}"


@pytest.mark.parametrize(
    ("prompt", "stem"),
    [
        pytest.param("图片1 的男生背着图片2 的书包，站在公交站旁", "男生背着书包_1", id="picture-tags-dropped"),
        pytest.param("图片1 和图片2 是同一只猫，按这两张画它", "image_1", id="binding-keeps-the-generic-stem"),
    ],
)
def test_the_image_generator_saves_each_image_under_that_name(monkeypatch, hermes_home, prompt: str, stem: str) -> None:
    image = _load_plugin("apexnodes-image-tools")
    _serve_bytes(monkeypatch, image._gateway, content_type="image/png")

    result = json.loads(image._localize_gateway_image({"images": [{"image_url": "https://cdn.example.com/out.png"}]}, prompt))

    saved = Path(result["images"][0]["image_path"])
    assert saved.parent == hermes_home / "cache" / "media"
    assert re.fullmatch(rf"{stem}_[0-9a-f]{{8}}\.png", saved.name), saved.name
