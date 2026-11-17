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
    # hc-1258: the sound effects assemble synthesizes beside a cut
    "pop-lo.wav": ("audio", 0.14, 0, 0),
    "ding.wav": ("audio", 1.1, 0, 0),
    "riser.wav": ("audio", 1.3, 0, 0),
    "outro-chime.wav": ("audio", 1.47, 0, 0),
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
    "\ufeff1\r\n00:00:00,300 --> 00:00:03,000\r\n第一句\r\n\r\n"
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


def test_ffprobe_is_the_named_one_then_the_engines_own_then_the_platform_resolvers(tmp_path, monkeypatch):
    bundled = tmp_path / "ffprobe"
    bundled.write_bytes(b"")
    monkeypatch.setattr(_apex_probe, "_BUNDLED", bundled)
    asked = []
    monkeypatch.setattr("hermes_platform.resolver.locate_command",
                        lambda name: asked.append(name) or SimpleNamespace(command=("/somewhere/ffprobe",)))

    monkeypatch.setenv(_apex_probe.FFPROBE_ENV, "/named/ffprobe")
    assert _apex_probe._ffprobe() == "/named/ffprobe"
    monkeypatch.delenv(_apex_probe.FFPROBE_ENV)
    assert _apex_probe._ffprobe() == str(bundled)
    bundled.unlink()
    assert _apex_probe._ffprobe() == "/somewhere/ffprobe"
    assert asked == ["ffprobe"]
    monkeypatch.setattr("hermes_platform.resolver.locate_command", lambda name: SimpleNamespace(command=()))
    assert _apex_probe._ffprobe() is None
    assert _apex_probe.MediaInfo.can_parse() is False


# hc-1232: the narration in the draft is as loud as in the finished cut. ``assemble`` raises it to -16 LUFS and writes
# how many dB in ``<cut>.assembly.json`` (apex-nodes short-video-studio footage_assemble.py); the draft reads that.

#: The shots of ``_timeline`` as assemble's report lists them (file name, in point, length).
ASSEMBLED_SHOTS = [{"file": "tall.mp4", "in": 0.5, "dur": 3.0}, {"file": "wide.mp4", "in": 1.0, "dur": 4.5},
                   {"file": "card.png", "in": 0, "dur": 3.0}]


def _report(folder: Path, name: str, gain_db=7.43, *, age: float = 0.0, **overrides) -> None:
    """A report as assemble writes it beside ``<name>.mp4``; ``age`` seconds older than now."""
    report = {
        "output": str(folder / f"{name}.mp4"), "fps": 30, "narration": str(folder / "voice.m4a"),
        "narration_level": {"measured_lufs": -16.0 - gain_db, "target_lufs": -16.0, "offset_db": 0.0,
                            "gain_db": gain_db},
        "shots": [{**shot, "start": 0.0, "gain_db": 0.0, "has_audio": True, "zoom": 1.0} for shot in ASSEMBLED_SHOTS],
        **overrides,
    }
    path = folder / f"{name}.assembly.json"
    path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    stamp = path.stat().st_mtime - age
    os.utime(path, (stamp, stamp))


def _without_level(folder: Path, name: str, **kwargs) -> None:
    _report(folder, name, **kwargs)
    path = folder / f"{name}.assembly.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    del report["narration_level"]  # what assemble wrote before hc-1232
    stamp = path.stat().st_mtime
    path.write_text(json.dumps(report), encoding="utf-8")
    os.utime(path, (stamp, stamp))


def _other_shots(folder: Path, name: str) -> None:
    shots = [dict(ASSEMBLED_SHOTS[0]), {**ASSEMBLED_SHOTS[1], "dur": 4.0}, dict(ASSEMBLED_SHOTS[2])]
    _report(folder, name, 7.43, shots=shots)


def _broken(folder: Path, name: str) -> None:
    (folder / f"{name}.assembly.json").write_text("{", encoding="utf-8")


@pytest.mark.parametrize(
    ("reports", "volume"),
    [
        pytest.param([], 1.0, id="no cut yet"),
        pytest.param([lambda f: _report(f, "成片", 7.43)], 10 ** (7.43 / 20), id="raised in the cut"),
        pytest.param([lambda f: _report(f, "成片", -4.5)], 10 ** (-4.5 / 20), id="lowered in the cut"),
        pytest.param([lambda f: _without_level(f, "成片")], 1.0, id="cut before hc-1232"),
        pytest.param([lambda f: _report(f, "成片", narration=None, narration_level=None)], 1.0,
                     id="cut without narration"),
        pytest.param([lambda f: _report(f, "成片", narration=str(f / "music.m4a"))], 1.0, id="other narration"),
        pytest.param([lambda f: _other_shots(f, "成片")], 1.0, id="other cut"),
        pytest.param([lambda f: _report(f, "成片", narration=str(f / ".." / f.name / "voice.m4a"))],
                     10 ** (7.43 / 20), id="same narration spelled otherwise"),
        pytest.param([lambda f: _report(f, "旧", 3.0, age=60), lambda f: _report(f, "成片", 7.43)],
                     10 ** (7.43 / 20), id="newest cut"),
        pytest.param([lambda f: _report(f, "成片", 7.43, age=60), lambda f: _without_level(f, "重拼")], 1.0,
                     id="newest cut is from before hc-1232"),
        pytest.param([lambda f: _report(f, "成片", 7.43, age=60), lambda f: _broken(f, "坏")], 10 ** (7.43 / 20),
                     id="unreadable report skipped"),
        pytest.param([lambda f: _report(f, "成片", 7.43, age=60), lambda f: _other_shots(f, "别的")],
                     10 ** (7.43 / 20), id="newer report of another cut skipped"),
    ],
)
def test_the_narration_is_as_loud_as_in_the_cut(media, tmp_path, reports, volume):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    for add in reports:
        add(media)
    _, written, timeline, _ = _write(media, tmp_path)
    tracks = {t["name"]: t for t in timeline["tracks"]}
    assert [s["volume"] for s in tracks["旁白"]["segments"]] == [pytest.approx(volume, abs=1e-4)]
    # The footage's own sound and the music are not the narration: they stay where they were.
    assert {s["volume"] for s in tracks["画面"]["segments"]} == {build.CLIP_VOLUME["under_narration"]}
    assert [s["volume"] for s in tracks["配乐"]["segments"]] == [0.3]
    assert written.notes == []


def test_a_report_beside_a_timeline_without_narration_changes_nothing(media, tmp_path):
    _report(media, "成片", 7.43)
    plan = build.load_plan(_timeline(media))
    assert (plan.narration, plan.narration_gain_db) == (None, None)


@pytest.mark.parametrize(
    ("gain_db", "volume", "note"),
    [
        (None, 1.0, None),
        (0.0, 1.0, None),
        (7.43, 2.3523, None),
        (-6.0, 0.5012, None),
        (-30.0, 0.0316, None),
        (20.0, 10.0, None),
        (20.04, 10.0, None),  # 0.04 dB short is not worth a word
        (20.06, 10.0, "成片里旁白拉响了 20.1 dB,剪映最多拉响 20 dB,草稿里的旁白比成片轻 0.1 dB"),
        (23.43, 10.0, "成片里旁白拉响了 23.4 dB,剪映最多拉响 20 dB,草稿里的旁白比成片轻 3.4 dB"),
        (30.0, 10.0, "成片里旁白拉响了 30.0 dB,剪映最多拉响 20 dB,草稿里的旁白比成片轻 10.0 dB"),
    ],
    ids=lambda value: "note" if isinstance(value, str) else None,
)
def test_the_narration_volume_is_the_cuts_gain_up_to_jianyings_ceiling(gain_db, volume, note):
    assert build.narration_volume(gain_db) == (volume, note)


def test_a_narration_above_jianyings_ceiling_is_capped_and_said_in_the_result(media, tmp_path, monkeypatch):
    from apex_overlay import jianying_draft

    monkeypatch.setenv(jianying_draft.SWITCH_ENV, "1")
    root = tmp_path / "Projects" / "com.lveditor.draft"
    root.mkdir(parents=True)
    found = jianying_install.Installation(app=tmp_path / "app", version="11.7.0", user_data=tmp_path, draft_root=root)
    monkeypatch.setattr(jianying_install, "find", lambda *a, **k: found)
    monkeypatch.setattr(jianying_install, "running", lambda *a, **k: False)
    _report(media, "成片", 23.43)

    result = jianying_draft.write_draft({"timeline": _timeline(media, narration="voice.m4a"), "name": "响"})
    assert result["changes"] == ["成片里旁白拉响了 23.4 dB,剪映最多拉响 20 dB,草稿里的旁白比成片轻 3.4 dB"]
    timeline = json.loads((root / "响" / "draft_info.json").read_text(encoding="utf-8"))
    [narration] = [t for t in timeline["tracks"] if t["name"] == "旁白"]
    assert [s["volume"] for s in narration["segments"]] == [build.VOLUME_MAX]


# hc-1258: the sound effects of the finished cut come along. ``assemble --sfx`` lists them in the cut's report
# (apex-nodes short-video-studio footage_sfx.py ``summary``); the draft puts them on 音效 tracks.


def _cue(folder: Path, name: str, start: float, gain_db: float = -2.0, *, skip: float = 0.0, cut: str = "成片") -> dict:
    """One entry of the report's ``sfx.cues``, as assemble writes it for a built-in effect."""
    return {"name": name, "label": name, "file": str(folder / f"{cut}.sfx" / f"{name}.wav"), "at": start + skip,
            "anchor": skip, "start": start, "skip": skip, "seconds": MEDIA[f"{name}.wav"][1], "level": -20.0 + gain_db,
            "gain_db": gain_db}


def _sfx(cues: list[dict], voice: bool = True) -> dict:
    return {"style": "few", "voice": voice, "gain": 0.0, "limit": 6, "level": -22.0 if voice else -15.0,
            "bed_trim_db": 0.0, "note": None, "cues": cues}


def _effect_files(folder: Path, cut: str = "成片") -> Path:
    beside = folder / f"{cut}.sfx"
    beside.mkdir(exist_ok=True)
    for name in ("pop-lo.wav", "ding.wav", "riser.wav", "outro-chime.wav"):
        (beside / name).write_bytes((folder / name).read_bytes())
    return beside


def _tracks(timeline: dict) -> dict:
    return {track["name"]: track["segments"] for track in timeline["tracks"]}


def _spans(segments: list[dict]) -> list[tuple[int, int]]:
    return [(s["target_timerange"]["start"], s["target_timerange"]["duration"]) for s in segments]


def test_the_cuts_sound_effects_get_tracks_of_their_own_at_the_cuts_times_and_levels(media, tmp_path):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    _effect_files(media)
    _report(media, "成片", 7.43, sfx=_sfx([
        _cue(media, "ding", 3.0), _cue(media, "pop-lo", 0.05), _cue(media, "riser", 6.2, -5.0),
        _cue(media, "outro-chime", 7.0, -3.0),  # starts while the riser still sounds: a second track
        _cue(media, "ding", 9.9, -2.0),  # the cut ends at 10.5 s: only its first 0.6 s
    ]))
    _, written, timeline, _ = _write(media, tmp_path)
    tracks = _tracks(timeline)
    assert [t["type"] for t in timeline["tracks"]] == ["video", "audio", "audio", "audio", "audio", "text"]
    assert list(tracks) == ["画面", "旁白", "配乐", "音效", "音效 2", build.SUBTITLE_TRACK]
    assert _spans(tracks["音效"]) == [(50_000, 140_000), (3 * SEC, 1_100_000), (6_200_000, 1_300_000),
                                      (9_900_000, 600_000)]
    assert _spans(tracks["音效 2"]) == [(7 * SEC, 1_470_000)]
    assert [s["volume"] for s in tracks["音效"]] == pytest.approx(
        [10 ** (-2 / 20), 10 ** (-2 / 20), 10 ** (-5 / 20), 10 ** (-2 / 20)], abs=1e-4)
    assert [s["volume"] for s in tracks["音效 2"]] == pytest.approx([10 ** (-3 / 20)], abs=1e-4)
    assert {s["source_timerange"]["start"] for s in tracks["音效"] + tracks["音效 2"]} == {0}
    assert all(s["source_timerange"]["duration"] == s["target_timerange"]["duration"] and s["speed"] == 1.0
               for s in tracks["音效"] + tracks["音效 2"])
    # The effect files are copied into the draft like the other media, each once.
    copies = sorted(p.name for p in (written.folder / "materials").iterdir())
    assert copies == sorted(["tall.mp4", "wide.mp4", "card.png", "voice.m4a", "music.m4a", "pop-lo.wav", "ding.wav",
                             "riser.wav", "outro-chime.wav"])
    assert build.check_written(written.folder) is None
    assert (written.effects, written.notes) == (5, [])
    # The narration and the music are where they were without effects.
    assert [s["volume"] for s in tracks["旁白"]] == [pytest.approx(10 ** (7.43 / 20), abs=1e-4)]
    assert [s["volume"] for s in tracks["配乐"]] == [0.3]


def test_an_effect_whose_head_was_cut_off_starts_inside_its_file(media, tmp_path):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    _effect_files(media)
    _report(media, "成片", 7.43, sfx=_sfx([_cue(media, "riser", 0.0, -5.0, skip=0.77)]))
    _, _, timeline, _ = _write(media, tmp_path)
    [riser] = _tracks(timeline)["音效"]
    assert (riser["source_timerange"]["start"], riser["source_timerange"]["duration"]) == (770_000, 530_000)
    assert _spans([riser]) == [(0, 530_000)]


@pytest.mark.parametrize(
    ("cues", "placed"),
    [
        pytest.param(lambda f: [_cue(f, "ding", 10.5)], 0, id="starts where the cut ends"),
        pytest.param(lambda f: [_cue(f, "ding", 12.0)], 0, id="starts after the cut"),
        pytest.param(lambda f: [_cue(f, "ding", 10.49)], 0, id="a hundredth of a second left"),
        pytest.param(lambda f: [_cue(f, "ding", 10.4)], 1, id="a tenth of a second left"),
        pytest.param(lambda f: ["ding", {"file": 3}, {**_cue(f, "ding", 1.0), "start": "1"},
                                {**_cue(f, "ding", 1.0), "gain_db": None}, {**_cue(f, "ding", 1.0), "start": -1},
                                {**_cue(f, "ding", 1.0), "skip": -0.5}, {**_cue(f, "ding", 1.0), "gain_db": True}],
                     0, id="entries that are not cues"),
    ],
)
def test_what_cannot_be_placed_is_left_out(media, tmp_path, cues, placed):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    _effect_files(media)
    _report(media, "成片", 7.43, sfx=_sfx(cues(media)))
    _, written, timeline, _ = _write(media, tmp_path)
    assert written.effects == placed
    assert ("音效" in _tracks(timeline)) is bool(placed)


def test_with_nobody_speaking_the_effects_come_down_with_the_rest_and_the_result_says_so(media, tmp_path):
    """The cut's loudness step lifted the live sound and the music to the target; the draft leaves them as recorded."""
    _effect_files(media)
    _report(media, "成片", narration=None, narration_level=None,
            sfx=_sfx([_cue(media, "ding", 3.0, 5.0), _cue(media, "pop-lo", 6.0, 4.95)], voice=False))
    root = tmp_path / "drafts"
    root.mkdir()
    written = build.write(build.load_plan(_timeline(media)), root, "没人说话")
    timeline = json.loads((written.folder / "draft_info.json").read_text(encoding="utf-8"))
    assert [s["volume"] for s in _tracks(timeline)["音效"]] == pytest.approx(
        [10 ** ((5.0 + build.UNNORMALISED_EFFECT_DB) / 20), 10 ** ((4.95 + build.UNNORMALISED_EFFECT_DB) / 20)], abs=1e-4)
    assert build.UNNORMALISED_EFFECT_DB == -10.0
    assert written.notes == ["这条片没有人说话：草稿不做整条的响度归一，音效按和现场声、配乐的比例放轻了，觉得轻就在剪映里把音效轨拉高"]
    assert {s["volume"] for s in _tracks(timeline)["画面"]} == {build.CLIP_VOLUME["plain"]}


@pytest.mark.parametrize(
    ("gain_db", "under_voice", "volume"),
    [(0.0, True, 1.0), (-2.0, True, 0.7943), (-3.0, True, 0.7079), (8.0, False, 0.7943), (5.0, False, 0.5623),
     (25.0, True, 10.0), (40.0, False, 10.0)],
)
def test_an_effects_volume_is_the_cuts_gain_under_a_voice_and_ten_db_less_without(gain_db, under_voice, volume):
    assert build.effect_volume(gain_db, under_voice) == volume


def test_a_moved_work_folder_still_finds_the_effects_beside_the_report_and_a_lost_one_is_said(media, tmp_path):
    (media / "字幕.srt").write_text(SRT, encoding="utf-8")
    beside = _effect_files(media)
    elsewhere = tmp_path / "以前的位置"  # the report still names the folder the cut was made in
    _report(media, "成片", 7.43, sfx=_sfx([_cue(elsewhere, "ding", 3.0), _cue(elsewhere, "pop-lo", 6.0)]))
    (beside / "pop-lo.wav").unlink()
    _, written, timeline, _ = _write(media, tmp_path)
    [ding] = _tracks(timeline)["音效"]
    assert _spans([ding]) == [(3 * SEC, 1_100_000)]
    assert (written.effects, written.notes) == (1, ["成片里有 1 个音效的文件找不到了，草稿里没放这几个"])


@pytest.mark.parametrize(
    ("reports", "narrated", "placed"),
    [
        pytest.param([], True, 0, id="no cut yet"),
        pytest.param([lambda f: _report(f, "成片", 7.43)], True, 0, id="cut without effects"),
        pytest.param([lambda f: _report(f, "成片", 7.43, sfx=None)], True, 0, id="cut whose sheet was empty"),
        pytest.param([lambda f: _report(f, "成片", 7.43, sfx=_sfx([_cue(f, "ding", 3.0)]))], True, 1, id="cut with one"),
        pytest.param([lambda f: _report(f, "带音效", 7.43, age=60, sfx=_sfx([_cue(f, "ding", 3.0, cut="成片")])),
                      lambda f: _report(f, "重拼", 7.43)], True, 0, id="newest cut has none"),
        pytest.param([lambda f: _report(f, "旧", 7.43, age=60),
                      lambda f: _report(f, "成片", 7.43, sfx=_sfx([_cue(f, "ding", 3.0)]))], True, 1, id="newest cut"),
        pytest.param([lambda f: _report(f, "成片", 7.43, shots=[dict(ASSEMBLED_SHOTS[0])],
                                        sfx=_sfx([_cue(f, "ding", 3.0)]))], True, 0, id="other cut"),
        pytest.param([lambda f: _report(f, "成片", 7.43, sfx=_sfx([_cue(f, "ding", 3.0)]))], False, 0,
                     id="narrated cut, timeline without narration"),
        pytest.param([lambda f: _report(f, "成片", narration=None, narration_level=None,
                                        sfx=_sfx([_cue(f, "ding", 3.0)]))], True, 0,
                     id="cut without narration, timeline with one"),
        pytest.param([lambda f: _report(f, "成片", narration=None, narration_level=None,
                                        sfx=_sfx([_cue(f, "ding", 3.0)]))], False, 1, id="neither has narration"),
        pytest.param([lambda f: _report(f, "成片", 7.43, age=60, sfx=_sfx([_cue(f, "ding", 3.0)])),
                      lambda f: _broken(f, "坏")], True, 1, id="unreadable report skipped"),
    ],
)
def test_the_effects_are_those_of_the_cut_the_user_has_last(media, tmp_path, reports, narrated, placed):
    _effect_files(media)
    for add in reports:
        add(media)
    root = tmp_path / "drafts"
    root.mkdir()
    plan = build.load_plan(_timeline(media, **({"narration": "voice.m4a"} if narrated else {})))
    written = build.write(plan, root, "成片")
    timeline = json.loads((written.folder / "draft_info.json").read_text(encoding="utf-8"))
    assert written.effects == placed == len(_tracks(timeline).get("音效", []))


def test_the_tool_result_names_the_effects_only_when_the_draft_has_them(media, tmp_path, monkeypatch):
    from apex_overlay import jianying_draft

    monkeypatch.setenv(jianying_draft.SWITCH_ENV, "1")
    root = tmp_path / "Projects" / "com.lveditor.draft"
    root.mkdir(parents=True)
    found = jianying_install.Installation(app=tmp_path / "app", version="11.7.0", user_data=tmp_path, draft_root=root)
    monkeypatch.setattr(jianying_install, "find", lambda *a, **k: found)
    monkeypatch.setattr(jianying_install, "running", lambda *a, **k: False)
    _effect_files(media)
    timeline = _timeline(media, narration="voice.m4a")

    _report(media, "成片", 7.43)
    assert "sfx" not in jianying_draft.write_draft({"timeline": timeline, "name": "没有音效"})["draft"]
    _report(media, "成片", 7.43, sfx=_sfx([_cue(media, "ding", 3.0), _cue(media, "pop-lo", 6.0)]))
    result = jianying_draft.write_draft({"timeline": timeline, "name": "有音效"})
    assert result["draft"]["sfx"] == 2 and result["changes"] == []
    assert json.loads(jianying_draft.handle({"timeline": timeline, "name": "再来"}))["draft"]["sfx"] == 2
