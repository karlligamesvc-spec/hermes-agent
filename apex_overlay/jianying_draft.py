"""hc-1219 剪映 draft handoff on APEX Desktop: the agent writes the finished cut as a 剪映专业版 draft, the user
opens it in 剪映 and exports it there.

**Off means nothing.** Desktop's main process settles ``desktop_features.jianying`` (or the install switch
``APEXNODES_JIANYING``) into ``APEX_JIANYING_ACTIVE=1`` before the engine starts (electron/apex-jianying.ts). Without
it, as in every cloud container, no tool is registered.

**Only where 剪映 is.** The one tool, ``jianying_draft``, is in the tool list only while 剪映 is installed and has its
draft folder, read each time the list is built (jianying_install.py). So the agent offers 「在剪映里接着剪」 only
on a computer that can take it, and a 剪映 installed while APEX runs counts from the next turn.

**APEX writes, the user exports.** The draft is written into 剪映's own draft folder; nothing operates 剪映
(hc-1219: the user exports). Desktop draws the result as a card with 「在剪映中打开」, which starts 剪映 and checks that
it took the draft in (apps/desktop electron/jianying.ts). After writing, this side checks the same where it can: when
剪映 is running it takes a new draft in within about two seconds, and ``root_meta_info.json`` must then list a
timeline file that exists and a duration above 0. A draft is never read back: once open in 剪映 its files are no
longer JSON, so a change goes into a new draft.

    $APEX_PYTHON -m apex_overlay.jianying_draft status          where 剪映 is, its version and draft folder
    $APEX_PYTHON -m apex_overlay.jianying_draft write <timeline.json> [--name 名字] [--subtitles 字幕.srt] ...
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from apex_overlay import jianying_install

logger = logging.getLogger(__name__)

SWITCH_ENV = "APEX_JIANYING_ACTIVE"
TOOL = "jianying_draft"
TOOLSET = "apex_jianying"
#: How long to wait for a running 剪映 to list a new draft. It usually takes about 2 s (11.7.0); when it has not
#: after ANNOUNCE_AGAIN_SECONDS the draft is moved out and in again (jianying_build.announce_again).
REGISTER_WAIT_SECONDS = 10.0
ANNOUNCE_AGAIN_SECONDS = 3.5
POLL_SECONDS = 0.5

SCHEMA = {
    "name": TOOL,
    "description": (
        "Write the finished cut as a draft in 剪映专业版 (JianyingPro) on this computer, so the user can keep "
        "editing and export it there. Pass the same timeline JSON given to short-video-studio's assemble (shots of "
        "file/in/dur on unburned footage); subtitles (SRT, or the ASS from the subtitles command) become editable "
        "text with a black stroke, narration and music become audio tracks. Only local media and the free 叠化 "
        "transition. Returns the draft's name; Desktop shows it as a card with an 「在剪映中打开」 button."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "timeline": {"type": "string", "description": "Absolute path of the timeline JSON given to assemble."},
            "name": {"type": "string", "description": "Short draft name the user will recognise, e.g. the title."},
            "subtitles": {"type": "string",
                          "description": "SRT or ASS path. Defaults to the timeline's subtitles."},
            "subtitle_position": {"type": "string", "enum": ["bottom", "middle"],
                                  "description": "Where the subtitles sit, as chosen for the video. Default bottom."},
            "narration": {"type": "string",
                          "description": "Narration audio. Defaults to the timeline's narration."},
            "music": {"type": "string",
                      "description": "Music from APEX's music tools or the user's own; omit when there is none."},
            "music_volume": {"type": "number", "description": "0.05 to 1. Default 0.3."},
            "dissolve_after": {"type": "array", "items": {"type": "integer"},
                               "description": "Shot numbers (1 = first) followed by a 叠化. Default none: hard cuts."},
        },
        "required": ["timeline"],
    },
}

NOT_HERE = "这台电脑上没有找到剪映专业版，或者剪映还没打开过一次。"
WRITTEN_NOTE = (
    "草稿写好了。告诉用户：点卡片上的「在剪映中打开」，在剪映首页点开这份草稿，剪好后{export}。"
    "剪映里的改动回不到 APEX：之后要 APEX 改，就另写一份新草稿，不改这份。回复里不写草稿的文件夹路径。"
)
EXPORT_STEPS = {"darwin": "点菜单「文件 › 导出」，再点「导出」", "win32": "点右上角「导出」，再点「导出」"}
NOT_TAKEN_NOTE = (
    "剪映开着，但它没有认出这份草稿（{why}）。照实告诉用户这份草稿可能打不开，先交成片；不要说草稿已经好了。"
)
CLOSED_NOTE = "剪映现在没开，打开后草稿会出现在首页。"
SWITCHED_OFF = "剪映草稿在这台电脑上没有打开（desktop_features.jianying 关着）。"


def switch_on() -> bool:
    """Desktop settled the 剪映 switch on for this engine."""
    return os.environ.get(SWITCH_ENV, "").strip() == "1"


def available() -> bool:
    """The tool is offered: switch on, 剪映 installed, and its draft folder there."""
    if not switch_on():
        return False
    found = jianying_install.find()
    return found is not None and found.draft_root is not None


def _wait_for_registration(folder: Path, wait: float) -> Optional[dict]:
    from apex_overlay import jianying_build

    started = time.monotonic()
    announced = False
    while True:
        entry = jianying_install.registration(folder)
        if entry is not None and entry["timeline_exists"] and entry["duration_us"] > 0:
            return entry
        waited = time.monotonic() - started
        if waited >= wait:
            return entry
        if entry is None and not announced and waited >= ANNOUNCE_AGAIN_SECONDS:
            announced = True
            try:
                jianying_build.announce_again(folder)
            except OSError:
                logger.warning("apex-overlay: could not show the 剪映 draft again", exc_info=True)
        time.sleep(POLL_SECONDS)


def _taken_in(folder: Path, is_running: bool, wait: float) -> tuple[Optional[bool], Optional[str]]:
    """(registered, why not). None when 剪映 is closed: it reads the folder at its next start."""
    if not is_running:
        return None, None
    entry = _wait_for_registration(folder, wait)
    if entry is None:
        return False, "首页没有出现这份草稿"
    if not entry["timeline_exists"]:
        return False, "剪映登记的时间线文件不存在"
    if entry["duration_us"] <= 0:
        return False, "剪映登记的时长是 0"
    return True, None


def write_draft(args: dict, *, platform: str = sys.platform, wait: float = REGISTER_WAIT_SECONDS) -> dict:
    """Write the draft and check it. Raises ``jianying_build.PlanError`` for a timeline that cannot be one."""
    from apex_overlay import jianying_build as build

    found = jianying_install.find(platform=platform)
    if found is None or found.draft_root is None:
        return {"error": NOT_HERE}
    plan = build.load_plan(str(args.get("timeline") or ""), args.get("subtitles"), args.get("narration"))
    fallback = f"APEX 成片 {datetime.now().strftime('%m%d-%H%M')}"
    written = build.write(
        plan, found.draft_root, build.draft_name(str(args.get("name") or ""), fallback),
        music=args.get("music") or None, music_volume=float(args.get("music_volume") or 0.3),
        dissolve_after=[int(n) for n in args.get("dissolve_after") or []],
        subtitle_position=str(args.get("subtitle_position") or "bottom"))
    problem = build.check_written(written.folder)
    if problem:
        return {"error": problem}
    registered, why = _taken_in(written.folder, jianying_install.running(platform), wait)
    note = WRITTEN_NOTE.format(export=EXPORT_STEPS.get(platform, EXPORT_STEPS["darwin"]))
    if registered is False:
        note = NOT_TAKEN_NOTE.format(why=why)
    elif registered is None:
        note = f"{note}{CLOSED_NOTE}"
    return {
        "status": "written",
        "draft": {"name": written.folder.name, "folder": str(written.folder),
                  "seconds": round(written.duration_us / 1_000_000, 2), "shots": written.shots,
                  "subtitles": written.subtitles},
        "jianying": {"version": found.version, "platform": platform, "registered": registered},
        "problem": why,
        "changes": written.notes,
        "note": note,
    }


def handle(args: dict, **_kwargs: Any) -> str:
    from apex_overlay import jianying_build as build

    try:
        result = write_draft(args if isinstance(args, dict) else {})
    except build.PlanError as exc:
        result = {"error": str(exc)}
    except (OSError, ValueError) as exc:
        logger.warning("apex-overlay: 剪映 draft not written", exc_info=True)
        result = {"error": f"草稿没写成：{exc}"}
    return json.dumps(result, ensure_ascii=False)


def apply(ctx: Any) -> bool:
    """Only with the switch on: register the tool, offered while 剪映 is on this computer."""
    if not switch_on():
        return True
    if getattr(ctx, "register_tool", None) is None:
        logger.warning("apex-overlay: this plugin host cannot register the 剪映 draft tool")
        return False
    from tools.registry import no_cache_check_fn

    ctx.register_tool(name=TOOL, toolset=TOOLSET, schema=SCHEMA, handler=handle,
                      check_fn=no_cache_check_fn(available), description=SCHEMA["description"], emoji="🎞️")
    return True


def status() -> dict:
    found = jianying_install.find()
    if found is None:
        return {"installed": False, "switch": switch_on()}
    return {"installed": True, "switch": switch_on(), "app": str(found.app), "version": found.version,
            "draft_root": str(found.draft_root) if found.draft_root else None,
            "running": jianying_install.running()}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m apex_overlay.jianying_draft")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="where 剪映 is, its version and draft folder")
    write = sub.add_parser("write", help="write a draft from an assemble timeline")
    write.add_argument("timeline")
    for flag in ("--name", "--subtitles", "--narration", "--music", "--subtitle-position"):
        write.add_argument(flag)
    write.add_argument("--music-volume", type=float)
    write.add_argument("--dissolve-after", type=int, nargs="*")
    options = parser.parse_args(argv)
    if options.command == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=1))
        return 0
    args = {key: value for key, value in vars(options).items() if key != "command" and value is not None}
    # Off means nothing here too: the command is the tool's own path, for tests on a real 剪映.
    output = json.loads(handle(args)) if switch_on() else {"error": SWITCHED_OFF}
    print(json.dumps(output, ensure_ascii=False, indent=1))
    return 1 if "error" in output else 0


if __name__ == "__main__":
    sys.exit(main())
