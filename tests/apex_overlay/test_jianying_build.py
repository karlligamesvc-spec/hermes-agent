"""hc-1219 A 剪映 draft from the short-video pipeline's cut list (apex_overlay/jianying_build.py).

Media are probed through the vendored library's ffprobe stand-in; here it answers from a table, so the tests need no
ffprobe and no real video.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from apex_overlay import jianying_build as build
from apex_overlay import jianying_install
from apex_overlay.vendor.pyJianYingDraft import TransitionType, _apex_probe

SEC = 1_000_000
#: name -> (kind, seconds, width, height)
MEDIA = {
    "tall.mp4": ("video", 5.0, 1080, 1920),
    "wide.mp4": ("video", 6.0, 1920, 1080),
    "card.png": ("image", 0.0, 1080, 1920),
    "voice.m4a": ("audio", 14.0, 0, 0),
    "music.m4a": ("audio", 30.0, 0, 0),
}


@pytest.fixture
def media(tmp_path, monkeypatch):
    folder = tmp_path / "work"
    folder.mkdir()
    for name in MEDIA:
        (folder / name).write_bytes(name.encode())

    def parse(path, mediainfo_options=None):
        kind, seconds, width, height = MEDIA[os.path.basename(path)]
        track = SimpleNamespace(duration=seconds * 1000, width=width, height=height)
        general = [SimpleNamespace(duration=seconds * 1000)]
        return _apex_probe.MediaInfo(general, [track] if kind == "video" else [],
                                     [track] if kind == "audio" else [], [track] if kind == "image" else [])

    monkeypatch.setattr(_apex_probe.MediaInfo, "parse", classmethod(lambda cls, path, mediainfo_options=None:
                                                                     parse(path)))
    monkeypatch.setattr(_apex_probe.MediaInfo, "can_parse", staticmethod(lambda: True))
    return folder


def _timeline(folder: Path, **extra) -> str:
    data = {"width": 1080, "height": 1920, "fps": 30, "shots": [
        {"file": "tall.mp4", "in": 0.5, "dur": 3.0},
        {"file": "wide.mp4", "in": 1.0, "out": 5.5, "zoom": 1.1},
        {"file": str(folder / "card.png"), "in": 0, "dur": 3.0},
    ], **extra}
    path = folder / "时间轴.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return str(path)


SRT = (
    "﻿1\r\n00:00:00,300 --> 00:00:03,000\r\n第一句\r\n\r\n"
    "2\r\n00:00:03,200 --> 00:00:06,500\r\n第二句\r\n第二行\r\n\r\n"
    "3\r\n00:00:06,800 --> 00:00:10,500\r\n最后一条后面没有空行"
)


def test_srt_keeps_the_last_cue_without_a_blank_line_after_it():
    # The library's own import_srt only closes a cue on a blank line, so it would drop the third one.
    assert build.parse_srt(SRT) == [
        (0.3, 3.0, "第一句"), (3.2, 6.5, "第二句\n第二行"), (6.8, 10.5, "最后一条后面没有空行"),
    ]


@pytest.mark.parametrize("text", ["1\n00:00:01,000 --> 00:00:01,000\n零长\n", "1\n坏时间\n字\n", "1\n00:00:01,000 --> 00:00:02,000\n\n"])
def test_srt_cues_without_time_or_text_are_left_out(text):
    assert build.parse_srt(text) == []


def test_ass_dialogue_loses_its_tags_and_keeps_line_breaks():
    text = ("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            "Dialogue: 0,0:00:01.20,0:00:02.50,Default,,0,0,0,,{\\an5\\fs120}关注我\\N看下一期\n"
            "Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,不是字幕\n")
    assert build.parse_ass(text) == [(1.2, 2.5, "关注我\n看下一期")]


def test_the_srt_beside_an_ass_is_preferred(tmp_path):
    (tmp_path / "字幕.ass").write_text("Dialogue: 0,0:00:00.00,0:00:01.00,D,,0,0,0,,从ASS来\n", encoding="utf-8")
    (tmp_path / "字幕.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\n从SRT来\n", encoding="utf-8")
    assert build.read_cues(str(tmp_path / "字幕.ass")) == [(0.0, 1.0, "从SRT来")]
    (tmp_path / "字幕.srt").unlink()
    assert build.read_cues(str(tmp_path / "字幕.ass")) == [(0.0, 1.0, "从ASS来")]


def test_the_plan_resolves_paths_as_assemble_does(media):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    plan = build.load_plan(_timeline(media, subtitles="字幕.srt", narration="voice.m4a"))
    assert [(Path(s.path).name, s.start, s.dur, s.zoom) for s in plan.shots] == [
        ("tall.mp4", 0.5, 3.0, 1.0), ("wide.mp4", 1.0, 4.5, 1.1), ("card.png", 0.0, 3.0, 1.0)]
    assert (Path(plan.subtitles).name, Path(plan.narration).name) == ("字幕.srt", "voice.m4a")


@pytest.mark.parametrize(
    ("shots", "message"),
    [
        ([{"file": "tall.mp4"}], "第 1 个镜头缺 file 或 in"),
        ([{"file": "tall.mp4", "in": 0}], "第 1 个镜头缺 out 或 dur"),
        ([{"file": "tall.mp4", "in": 2, "out": 2}], "第 1 个镜头时长不是正数"),
        ([{"file": "tall.mp4", "in": 0, "dur": 1}, {"file": "nope.mp4", "in": 0, "dur": 1}],
         "找不到第 2 个镜头的素材：nope.mp4"),
        ([], "时间轴里没有镜头(shots)"),
    ],
)
def test_a_timeline_that_cannot_be_a_draft_says_why(media, shots, message):
    path = media / "t.json"
    path.write_text(json.dumps({"shots": shots}), encoding="utf-8")
    with pytest.raises(build.PlanError, match=message.replace("(", r"\(").replace(")", r"\)")):
        build.load_plan(str(path))


@pytest.mark.parametrize(
    ("wanted", "expected"),
    [("夏日 vlog", "夏日 vlog"), ('a/b\\c:d*e?f"g<h>i|j', "a b c d e f g h i j"), ("  ..  ", "备用"),
     ("长" * 60, "长" * build.NAME_LIMIT), ("第\n一\t版", "第 一 版")],
)
def test_draft_names_are_safe_folder_names(wanted, expected):
    assert build.draft_name(wanted, "备用") == expected


def test_a_name_in_use_or_still_listed_by_jianying_is_not_reused(tmp_path):
    root = tmp_path / "drafts"
    (root / "成片").mkdir(parents=True)
    (root / jianying_install.ROOT_META).write_text(json.dumps({"all_draft_store": [
        {"draft_fold_path": str(root / "成片 2")}]}), encoding="utf-8")
    assert build.free_folder(root, "成片") == root / "成片 3"
    assert build.free_folder(root, "新的") == root / "新的"


def _write(media, tmp_path, **kwargs):
    root = tmp_path / "Projects" / "com.lveditor.draft"
    root.mkdir(parents=True)
    plan = build.load_plan(_timeline(media, subtitles="字幕.srt", narration="voice.m4a"))
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    written = build.write(plan, root, "测试成片", music=str(media / "music.m4a"), **kwargs)
    timeline = json.loads((written.folder / "draft_info.json").read_text(encoding="utf-8"))
    meta = json.loads((written.folder / "draft_meta_info.json").read_text(encoding="utf-8"))
    return root, written, timeline, meta


def test_the_draft_is_what_jianying_reads(media, tmp_path):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    root, written, timeline, meta = _write(media, tmp_path, dissolve_after=[1])

    assert written.folder == root / "测试成片"
    # The timeline file is draft_info.json (PR #198); the old name opens to nothing in 剪映 6.0+.
    assert sorted(p.name for p in written.folder.iterdir()) == ["draft_info.json", "draft_meta_info.json",
                                                                "materials"]
    # 剪映 takes the home page's duration from the meta when it first sees the folder, so it is filled in.
    assert meta["tm_duration"] == timeline["duration"] == written.duration_us == 10_500_000
    assert (meta["draft_name"], meta["draft_fold_path"], meta["draft_root_path"]) == (
        "测试成片", str(written.folder), str(root))
    # Media are copied in, and the timeline points at the copies where they are now.
    copies = {p.name for p in (written.folder / "materials").iterdir()}
    assert copies == {"tall.mp4", "wide.mp4", "card.png", "voice.m4a", "music.m4a"}
    for kind in ("videos", "audios"):
        for item in timeline["materials"][kind]:
            assert Path(item["path"]).parent == written.folder / "materials"
            assert Path(item["path"]).is_file()
    assert build.check_written(written.folder) is None
    # Nothing is left beside the draft folder.
    assert sorted(p.name for p in root.parent.iterdir()) == ["com.lveditor.draft"]


def test_the_cuts_sound_and_subtitles_follow_the_plan(media, tmp_path):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    _, written, timeline, _ = _write(media, tmp_path, dissolve_after=[1, 3])
    tracks = {t["name"]: t for t in timeline["tracks"]}
    assert [t["type"] for t in timeline["tracks"]] == ["video", "audio", "audio", "text"]

    video = tracks["画面"]["segments"]
    assert [(s["target_timerange"]["start"], s["target_timerange"]["duration"]) for s in video] == [
        (0, 3 * SEC), (3 * SEC, 4_500_000), (7_500_000, 3 * SEC)]
    assert [s["source_timerange"]["start"] for s in video] == [500_000, 1 * SEC, 0]
    # The footage's own sound sits under the narration, as assemble does.
    assert {s["volume"] for s in video} == {build.CLIP_VOLUME["under_narration"]}
    # A 16:9 clip fills the 9:16 canvas like assemble's crop (剪映 would fit it), times its zoom.
    assert video[0]["clip"]["scale"]["x"] == 1.0
    assert video[1]["clip"]["scale"]["x"] == pytest.approx((1920 / 1080) / (1080 / 1920) * 1.1)
    # 叠化 only after shot 1: shot 3 is the last, there is nothing to dissolve into.
    transitions = timeline["materials"]["transitions"]
    assert [t["name"] for t in transitions] == ["叠化"]
    assert [bool(set(s["extra_material_refs"]) & {t["id"] for t in transitions}) for s in video] == [
        True, False, False]

    assert [s["volume"] for s in tracks["旁白"]["segments"]] == [1.0]
    music = tracks["配乐"]["segments"]
    assert music[0]["target_timerange"]["duration"] == written.duration_us  # cut to the video's length

    texts = tracks[build.SUBTITLE_TRACK]["segments"]
    assert [(s["target_timerange"]["start"], s["target_timerange"]["duration"]) for s in texts] == [
        (300_000, 2_700_000), (3_200_000, 3_300_000), (6_800_000, 3_700_000)]
    contents = [json.loads(m["content"]) for m in timeline["materials"]["texts"]]
    assert [c["text"] for c in contents] == ["第一句", "第二句\n第二行", "最后一条后面没有空行"]
    for content in contents:  # white with a black stroke, so a bright frame does not swallow it
        style = content["styles"][0]
        assert style["fill"]["content"]["solid"]["color"] == [1.0, 1.0, 1.0]
        assert style["strokes"][0]["content"]["solid"]["color"] == [0.0, 0.0, 0.0]
    assert {s["clip"]["transform"]["y"] for s in texts} == {build.SUBTITLE_Y["bottom"]}


def test_only_local_media_and_the_free_dissolve_go_in(media, tmp_path):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    _, _, timeline, _ = _write(media, tmp_path, dissolve_after=[1, 2])
    materials = timeline["materials"]
    for kind in ("video_effects", "filters", "effects", "stickers", "material_animations"):
        assert not materials.get(kind), kind
    dissolve = TransitionType.from_name(build.TRANSITION).value
    assert dissolve.is_vip is False
    assert {t["effect_id"] for t in materials["transitions"]} == {dissolve.effect_id}
    for content in (json.loads(m["content"]) for m in materials["texts"]):
        assert "font" not in content["styles"][0], "no online font"


def test_the_draft_folder_appears_only_whole(media, tmp_path, monkeypatch):
    """剪映 takes in any new folder under its draft folder (a hidden one too) and keeps the duration it read then.
    So the parts are made elsewhere and moved into the new folder by rename, the meta last."""
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    moves: list[tuple[str, list[str]]] = []
    real = os.rename

    def rename(src, dst):
        if Path(dst).parent.name == "测试成片":
            moves.append((Path(dst).name, sorted(p.name for p in Path(dst).parent.iterdir())))
        real(src, dst)

    monkeypatch.setattr(build.os, "rename", rename)
    _write(media, tmp_path)
    assert moves == [("materials", []), ("draft_info.json", ["materials"]),
                     ("draft_meta_info.json", ["draft_info.json", "materials"])]


def test_a_failed_move_leaves_no_half_draft(media, tmp_path, monkeypatch):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    real = os.rename

    def rename(src, dst):
        if Path(dst).name == "draft_meta_info.json":
            raise OSError("disk full")
        real(src, dst)

    monkeypatch.setattr(build.os, "rename", rename)
    with pytest.raises(OSError):
        _write(media, tmp_path)
    root = tmp_path / "Projects" / "com.lveditor.draft"
    assert list(root.iterdir()) == []
    assert sorted(p.name for p in root.parent.iterdir()) == ["com.lveditor.draft"]


def test_announce_again_moves_the_same_draft_out_and_in(media, tmp_path):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    root, written, _, _ = _write(media, tmp_path)
    before = (written.folder / "draft_info.json").read_bytes()
    build.announce_again(written.folder)
    assert (written.folder / "draft_info.json").read_bytes() == before
    assert sorted(p.name for p in root.parent.iterdir()) == ["com.lveditor.draft"]


def test_a_shot_longer_than_its_footage_is_shortened_and_said(media, tmp_path):
    path = media / "t.json"
    path.write_text(json.dumps({"shots": [{"file": "tall.mp4", "in": 4.0, "dur": 3.0}]}), encoding="utf-8")
    root = tmp_path / "drafts"
    root.mkdir()
    written = build.write(build.load_plan(str(path)), root, "短")
    assert written.duration_us == 1 * SEC
    assert written.notes == ["第 1 个镜头素材不够长，缩短到 1.00 秒"]

    path.write_text(json.dumps({"shots": [{"file": "tall.mp4", "in": 5.0, "dur": 1.0}]}), encoding="utf-8")
    with pytest.raises(build.PlanError, match="入点超过了素材长度"):
        build.write(build.load_plan(str(path)), root, "过")
    assert sorted(p.name for p in root.iterdir()) == ["短"]


@pytest.mark.parametrize(
    ("damage", "problem"),
    [
        (lambda f: (f / "draft_info.json").write_text("{", encoding="utf-8"), "草稿的时间线文件没有写好"),
        (lambda f: next((f / "materials").glob("wide.mp4")).unlink(), "草稿里的素材没拷全：wide.mp4"),
        (lambda f: (f / "draft_meta_info.json").unlink(), "草稿缺 draft_meta_info.json"),
    ],
)
def test_our_own_check_catches_a_broken_draft(media, tmp_path, damage, problem):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    _, written, _, _ = _write(media, tmp_path)
    damage(written.folder)
    assert build.check_written(written.folder) == problem
