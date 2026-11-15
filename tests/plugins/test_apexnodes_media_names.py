"""hc-1130: 生成文件的名字取提示词第一句的开头,不是整段提示词。

hc-1243: 写给模型看的格式不算名字。MiniMax H3 的提示词以 ``subject_definitions:`` 开头,
每条 H3 出的视频都存成 ``subject_definitions_<hash>.mp4``,交付区叫「subject definitions」。
名字依次取台词、第一个主体是什么、去掉段名和标签后的第一句;只说参考图是谁的第一句不给名字。
The prompts below follow MiniMax's published layout; the platform skill's own examples
(apex-nodes ``video-shot-prompts/references/minimax-h3.md``) are checked against this code
from the apex-nodes side, which reads fork main.
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
<Subject 1> is the young woman in <Picture 1>: short black hair, light grey crew-neck sweater.

summary:
[reference generation] A 10-second vertical clip in two hard-cut shots: <Subject 1> holds a plain white mug and speaks to the camera.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - her face, hair and grey sweater from <Picture 1> stay identical.

detailed_description:
The target video looks like real smartphone footage, not an advertisement.
[Shot 1] A medium static shot frames <Subject 1> at a wooden desk. <Subject 1>, a young woman with a bright voice (S1), says: <d>[Chinese] 这杯子我天天用，保温一整天。</d> She closes her lips.
[Shot 2] At 00:05.000, the camera cuts to a close-up of the mug on the desk.

overall_soundscape:
Quiet room tone and a soft knock of the mug on the desk.

non_diegetic_music:
N/A"""

# Reference generation: a product and a hand, nobody speaks.
H3_PRODUCT = """subject_definitions:
<Subject 1> is the matte green insulated bottle in <Picture 1>: straight sides, push-button lid, completely blank surface with no text or logo.

summary:
[reference generation] A 10-second vertical clip: a hand picks up <Subject 1> and presses its lid open.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the bottle's shape, colour and blank surface from <Picture 1> stay identical.

detailed_description:
[Shot 1] A close-up static shot. A hand reaches in, lifts <Subject 1> and presses the lid; a thin wisp of steam rises.

overall_soundscape:
The click of the lid.

non_diegetic_music:
N/A"""

H3_SILENT_PERSON = H3_SPOKEN.replace(
    "<Subject 1> is the young woman in <Picture 1>", "<Subject 1> is the young East Asian woman in <Picture 1>"
).replace(" (S1), says: <d>[Chinese] 这杯子我天天用，保温一整天。</d>", " smiles.")

# Text to video (三段) with a spoken line.
H3_TEXT_ONLY = (
    "integrated_multimodal_description: A 10-second vertical food-review clip at a night market. "
    "[Shot 1] A medium handheld shot follows her at a grill stall. A young woman with a lively voice (S1) says: "
    "<d>[Chinese] 这家排队排了半小时！</d> [Shot 2] At 00:05.000, the camera cuts to a close-up of the skewer.\n\n"
    "overall_soundscape: Night-market ambience and sizzling oil.\n\n"
    "non_diegetic_music: A light lo-fi beat kept low under the voice."
)

# First-frame mode: one binding line, then the three sections; nobody speaks.
H3_FIRST_FRAME = (
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
    "integrated_multimodal_description: [Shot 1] A white mug on a wooden desk, steam rising, the camera pushes in slowly.\n\n"
    "overall_soundscape: Quiet room tone.\n\n"
    "non_diegetic_music: N/A"
)

LAYOUT_WORDS = re.compile(r"subject|definition|integrated|multimodal|summary|retention|picture|shot|reference|_|<|\[", re.IGNORECASE)


@pytest.mark.parametrize(
    ("prompt", "hint"),
    [
        pytest.param(H3_SPOKEN, "这杯子我天天用", id="h3-reference-spoken-line"),
        pytest.param(H3_PRODUCT, "matte green insulated", id="h3-reference-what-subject-1-is"),
        pytest.param(H3_SILENT_PERSON, "young East Asian woman", id="h3-reference-a-word-is-finished-not-halved"),
        pytest.param(H3_TEXT_ONLY, "这家排队排了半小时", id="h3-text-only-spoken-line"),
        pytest.param(H3_FIRST_FRAME, "A white mug on a wooden", id="h3-first-frame-line-and-tags-dropped"),
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
        pytest.param("图片1 的女生穿图片2 的外套，站在咖啡店门口，半身，暖色自然光", "女生穿外套", id="zh-picture-possessive"),
        pytest.param("<Picture 1> wearing the coat from <Picture 2>, at a cafe door", "wearing the coat", id="en-picture-phrase"),
        pytest.param("<Subject 1> 是图片1里的女生：圆脸，齐肩短发", "女生", id="zh-subject-definition"),
        # 只说参考图是谁：不给名字，交给调用方的通用名(结果卡片显示「图片」「视频」)
        pytest.param("图片1 和图片2 是同一位女士，请保留她的长相、发型和妆容", "", id="zh-pictures-binding"),
        pytest.param("图片1、2 都是她，保留脸型", "", id="zh-pictures-binding-short-list"),
        pytest.param("<Picture 1> and <Picture 2> show the same woman. Keep her face.", "", id="en-pictures-binding"),
        # 行首的小标题不算名字
        pytest.param("人物：二十多岁的东亚女生，鹅蛋脸", "二十多岁的东亚女生", id="zh-label"),
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
        pytest.param(H3_SPOKEN, "这杯子我天天用", id="spoken-line"),
        pytest.param(H3_PRODUCT, "matte_green_insulated", id="subject"),
        pytest.param("图片1 和图片2 是同一位女士，保留她的长相", "generated_video", id="binding-keeps-the-generic-stem"),
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
        pytest.param("图片1 的女生穿图片2 的外套，站在咖啡店门口", "女生穿外套_1", id="picture-tags-dropped"),
        pytest.param("图片1 和图片2 是同一位女士，保留她的长相", "image_1", id="binding-keeps-the-generic-stem"),
    ],
)
def test_the_image_generator_saves_each_image_under_that_name(monkeypatch, hermes_home, prompt: str, stem: str) -> None:
    image = _load_plugin("apexnodes-image-tools")
    _serve_bytes(monkeypatch, image._gateway, content_type="image/png")

    result = json.loads(image._localize_gateway_image({"images": [{"image_url": "https://cdn.example.com/out.png"}]}, prompt))

    saved = Path(result["images"][0]["image_path"])
    assert saved.parent == hermes_home / "cache" / "media"
    assert re.fullmatch(rf"{stem}_[0-9a-f]{{8}}\.png", saved.name), saved.name
