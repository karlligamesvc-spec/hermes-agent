#!/usr/bin/env python3
"""hc-1083 多助手第一期验收：测量和核对工具（只读）。

只读一个测试 HERMES_HOME 下的文件、它的 logs/desktop.log 和本机进程表；不改任何文件
（fixture 子命令只写 --out 指定的视频），不发网络请求。密钥只输出 sha256 前 12 位。

用引擎自带的 Python 跑（带 ruamel.yaml 和 psutil），并加 -I：
  Mac:     <home>/versions/<hash>/venv/bin/python3 -I multi_bot_qa.py ...
  Windows: <home>\\versions\\<hash>\\venv\\Scripts\\python.exe -I multi_bot_qa.py ...

子命令（详见同目录 README.md）：
  snapshot  家目录快照：每个助手（profile）的 key 指纹、插件表、平台技能、SOUL、主线会话
  check     对快照跑核对项 C1–C7，有 FAIL 时退出码 1
  diff      比两份快照（改名、删除、重新登录前后）
  watch     盯 desktop.log 和引擎进程：冷启动、内存、池里的挤掉/回收/排队
  mark      往 watch 的记录里打一个时间点（比如「点了剪辑助手」）
  report    把 watch 记录整理成表
  tokens    各助手会话库里的 token 合计（算实际花费）
  fixture   用 ffmpeg 生成后台剪片用的测试视频
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

try:  # 引擎自带 ruamel.yaml（fork 已不带 PyYAML）；系统自带的 python3 两个都没有
    from ruamel.yaml import YAML

    def _yaml_load(text: str) -> object:
        return YAML(typ="safe", pure=True).load(text)
except ImportError:
    try:
        import yaml as _pyyaml

        def _yaml_load(text: str) -> object:
            return _pyyaml.safe_load(text)
    except ImportError:
        _yaml_load = None

try:
    import psutil
except ImportError:  # watch 和 --live 需要；引擎的 python 自带
    psutil = None

MAIN_THREAD_TITLE = "APEX 主线"
BOT_CHAT_TITLE = "Bot Chat"
DATE_LINE = "Conversation started:"
BOT_PROTOCOL_HEADING = "## Messaging other agents"
PLATFORM_SKILLS = ("skills", "apexnodes")
SHARED_MIRRORS = "apex"
# 只读这几个环境变量的值；别的（含平台凭据）一律不读
ENV_FLAGS = ("APEXNODES_MULTI_BOT", "APEX_MULTI_BOT_ACTIVE", "APEXNODES_SINGLE_THREAD", "APEX_SINGLE_THREAD_ACTIVE")
SECRETISH_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)", re.IGNORECASE)


def fingerprint(value: object) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:12]


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(text: str) -> float:
    return datetime.fromisoformat(text).timestamp()


# ---------------------------------------------------------------- snapshot


def profile_homes(home: Path) -> dict[str, Path]:
    """根目录是 default（APEX）；profiles/ 下每个不以点开头的目录是一个助手。"""
    homes = {"default": home}
    profiles = home / "profiles"
    if profiles.is_dir():
        for child in sorted(profiles.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                homes[child.name] = child
    return homes


def load_yaml(path: Path) -> dict | None:
    if not path.is_file():
        return None
    if _yaml_load is None:
        raise SystemExit("需要 ruamel.yaml：请用引擎自带的 python 运行（见 README）")
    data = _yaml_load(path.read_text(encoding="utf-8-sig"))
    return data if isinstance(data, dict) else {}


def key_anchors(node: object, path: str = "") -> list[dict]:
    """配置里每个带 api_key 的映射：位置、base_url、key 指纹。不看产品代码认哪些锚点。"""
    found: list[dict] = []
    if isinstance(node, dict):
        if node.get("api_key"):
            found.append({"path": path or ".", "base_url": str(node.get("base_url") or ""), "fp": fingerprint(node["api_key"])})
        for key, value in node.items():
            found.extend(key_anchors(value, f"{path}.{key}" if path else str(key)))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            found.extend(key_anchors(value, f"{path}[{index}]"))
    return found


def config_summary(home: Path) -> dict | None:
    config = load_yaml(home / "config.yaml")
    if config is None:
        return None
    model = config.get("model") if isinstance(config.get("model"), dict) else {}
    plugins = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
    skills = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    return {
        "model_default": model.get("default"),
        "model_provider": model.get("provider"),
        "model_base_url": model.get("base_url"),
        "model_key_fp": fingerprint(model["api_key"]) if model.get("api_key") else None,
        "key_anchors": key_anchors(config),
        "plugins_enabled": sorted(str(p) for p in (plugins.get("enabled") or [])),
        "skills_disabled": sorted(str(s) for s in (skills.get("disabled") or [])),
    }


def env_summary(home: Path) -> dict:
    """.env 只记名字；像密钥的值只记指纹。"""
    path = home / ".env"
    if not path.is_file():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        name, sep, value = line.partition("=")
        name = name.strip()
        if not sep or not name or name.startswith("#"):
            continue
        out[name] = fingerprint(value.strip()) if SECRETISH_ENV.search(name) else "(set)"
    return out


def skill_version(skill_md: Path) -> str | None:
    match = re.search(r"^version:\s*['\"]?([^'\"\n]+)", skill_md.read_text(encoding="utf-8-sig"), re.MULTILINE)
    return match.group(1).strip() if match else None


def platform_skills(home: Path) -> dict:
    root = home.joinpath(*PLATFORM_SKILLS)
    files: dict[str, str] = {}
    versions: dict[str, str | None] = {}
    if not root.is_dir():
        return {"files": files, "versions": versions}
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        files[rel] = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        if path.name == "SKILL.md":
            versions[path.parent.relative_to(root).as_posix()] = skill_version(path)
    return {"files": files, "versions": versions}


def soul_summary(home: Path) -> dict | None:
    path = home / "SOUL.md"
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    headings = [line.strip() for line in lines if line.lstrip().startswith("#")]
    first = lines[0].strip() if lines else ""
    return {"sha": fingerprint(text), "chars": len(text), "first_line": first[:200], "headings": headings}


def profile_meta(home: Path) -> dict:
    data = load_yaml(home / "profile.yaml") or {}
    ui_meta = data.get("ui_meta") if isinstance(data.get("ui_meta"), dict) else {}
    apex = ui_meta.get("apex") if isinstance(ui_meta.get("apex"), dict) else None
    return {"display_name": data.get("display_name"), "ui_meta_apex": apex, "has_hermes_bots": "hermes-bots" in ui_meta}


def _session_rows(db: Path) -> list[dict]:
    """只读打开会话库。系统提示现在按哈希存在 system_prompts 表里，sessions.system_prompt 是空的。"""
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=5)
    try:
        con.row_factory = sqlite3.Row
        have = {row["name"] for row in con.execute("PRAGMA table_info(sessions)")}
        tables = {row["name"] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        wanted = ["id", "parent_session_id", "title", "started_at", "input_tokens", "output_tokens",
                  "cache_read_tokens", "api_call_count", "model"]
        cols = [f"s.{c}" for c in wanted if c in have]
        prompt = "s.system_prompt" if "system_prompt" in have else "NULL"
        join = ""
        if "system_prompts" in tables and "system_prompt_hash" in have:
            prompt = f"COALESCE(sp.prompt, {prompt})"
            join = " LEFT JOIN system_prompts sp ON sp.hash = s.system_prompt_hash"
        sql = f"SELECT {', '.join(cols)}, {prompt} AS system_prompt FROM sessions s{join}"
        return [dict(row) for row in con.execute(sql)]
    finally:
        con.close()


def _chain_root(row: dict, by_id: dict[str, dict]) -> dict:
    seen = set()
    while row.get("parent_session_id") in by_id and row["id"] not in seen:
        seen.add(row["id"])
        row = by_id[row["parent_session_id"]]
    return row


def prompt_checks(prompt: str | None, name: str | None) -> dict | None:
    if not prompt:
        return None
    return {
        "has_date_line": DATE_LINE in prompt,
        "has_bot_protocol": BOT_PROTOCOL_HEADING in prompt,
        "mentions_name": (name in prompt) if name else None,
        "sha": fingerprint(prompt),
    }


def _tool_names(raw: str | None) -> list[str]:
    try:
        calls = json.loads(raw) if raw else []
    except ValueError:
        return ["(unparsed)"]
    names = []
    for call in calls if isinstance(calls, list) else []:
        fn = call.get("function") if isinstance(call, dict) else None
        name = (fn or {}).get("name") if isinstance(fn, dict) else (call.get("name") if isinstance(call, dict) else None)
        names.append(str(name or "(unnamed)"))
    return names


def tool_call_counts(db: Path) -> dict[str, dict[str, int]]:
    """模型要调的工具（assistant 消息的 tool_calls）和真跑了的工具（tool 消息的 tool_name），按名字计数。"""
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=5)
    try:
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").fetchone():
            return {"requested": {}, "ran": {}}
        requested: dict[str, int] = {}
        for (raw,) in con.execute("SELECT tool_calls FROM messages WHERE role = 'assistant' AND tool_calls IS NOT NULL"):
            for name in _tool_names(raw):
                requested[name] = requested.get(name, 0) + 1
        ran = dict(con.execute("SELECT tool_name, COUNT(*) FROM messages WHERE role = 'tool' AND tool_name IS NOT NULL "
                               "GROUP BY tool_name").fetchall())
        return {"requested": dict(sorted(requested.items())), "ran": dict(sorted(ran.items()))}
    finally:
        con.close()


def sessions_summary(home: Path, name: str | None) -> dict | None:
    db = home / "state.db"
    if not db.is_file():
        return None
    rows = _session_rows(db)
    by_id = {row["id"]: row for row in rows}
    main_chain = [row for row in rows if (_chain_root(row, by_id).get("title") or "") == MAIN_THREAD_TITLE]
    latest = max(main_chain, key=lambda row: row.get("started_at") or 0, default=None)
    return {
        "total": len(rows),
        "main_thread_roots": sum(1 for row in rows if row.get("title") == MAIN_THREAD_TITLE),
        "main_thread_segments": len(main_chain),
        "bot_chat": sum(1 for row in rows if row.get("title") == BOT_CHAT_TITLE),
        "main_thread_prompt": prompt_checks(latest.get("system_prompt") if latest else None, name),
        "tool_calls": tool_call_counts(db),
    }


def shared_mirrors(home: Path) -> dict:
    root = home / SHARED_MIRRORS
    if not root.is_dir():
        return {}
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()[:12] for p in sorted(root.glob("*.md"))}


def home_snapshot(home: Path) -> dict:
    meta = profile_meta(home)
    name = (meta["ui_meta_apex"] or {}).get("name") if meta["ui_meta_apex"] else None
    return {
        "soul": soul_summary(home),
        "meta": meta,
        "config": config_summary(home),
        "env": env_summary(home),
        "platform_skills": platform_skills(home),
        "sessions": sessions_summary(home, name),
    }


def take_snapshot(home: Path, live: bool = False) -> dict:
    snap = {
        "taken_at": iso(time.time()),
        "home": str(home),
        "homes": {name: home_snapshot(path) for name, path in profile_homes(home).items()},
        "shared": shared_mirrors(home),
    }
    if live:
        snap["engines"] = live_engines(home)
    return snap


# ---------------------------------------------------------------- processes


def _norm(path: str) -> str:
    return os.path.normcase(str(Path(path).resolve()))


def _proc_home(proc, cache: dict[int, str | None]) -> str | None:
    """进程启动时的 HERMES_HOME（规范化）。只读这一个变量的值。"""
    if proc.pid in cache:
        return cache[proc.pid]
    try:
        value = proc.environ().get("HERMES_HOME")
    except (psutil.Error, OSError):
        value = None
    cache[proc.pid] = _norm(value) if value else None
    return cache[proc.pid]


def classify(argv: list[str]) -> tuple[str, str | None]:
    """进程类别和 profile 名：引擎（hermes … serve）、IM 网关（hermes … gateway run）、其余。"""
    words = [re.split(r"[\\/]", a)[-1].lower() for a in argv]  # Windows 路径在 Mac/Linux 上也要拆得开
    profile = argv[argv.index("--profile") + 1] if "--profile" in argv[:-1] else None
    is_hermes = any(w.startswith("hermes") for w in words) or "hermes_cli.main" in argv
    if is_hermes and "serve" in words:
        return "engine", profile or "default"
    if is_hermes and "gateway" in words and "run" in words:
        return "gateway", profile or "default"
    return "other", None


def our_processes(home: Path, cache: dict[int, str | None]) -> dict[int, dict]:
    """HERMES_HOME 等于测试家目录的进程：App 本身、引擎、网关和它们的子进程。"""
    want = _norm(str(home))
    found: dict[int, dict] = {}
    for proc in psutil.process_iter(["pid", "ppid", "name", "cmdline", "create_time"]):
        if _proc_home(proc, cache) != want:
            continue
        proc_kind, profile = classify(proc.info.get("cmdline") or [])
        found[proc.pid] = {"pid": proc.pid, "ppid": proc.info.get("ppid"), "name": proc.info.get("name"),
                           "proc_kind": proc_kind, "profile": profile, "create_time": proc.info.get("create_time")}
    return found


def memory_of(pid: int, uss: bool) -> dict | None:
    try:
        proc = psutil.Process(pid)
        rss = proc.memory_info().rss
    except (psutil.Error, OSError):
        return None
    if not uss:
        return {"rss": rss, "uss": None}
    try:
        return {"rss": rss, "uss": getattr(proc.memory_full_info(), "uss", None)}
    except (psutil.Error, OSError):
        return {"rss": rss, "uss": None}


def descendants(pid: int, procs: dict[int, dict]) -> list[int]:
    out, frontier = [], [pid]
    while frontier:
        parent = frontier.pop()
        children = [p for p, info in procs.items() if info["ppid"] == parent and p not in out]
        out.extend(children)
        frontier.extend(children)
    return out


def listening_ports(pid: int) -> list[int]:
    try:
        conns = psutil.Process(pid).net_connections(kind="tcp")
    except (psutil.Error, OSError):
        return []
    return sorted({c.laddr.port for c in conns if c.status == psutil.CONN_LISTEN})


def live_engines(home: Path) -> list[dict]:
    if psutil is None:
        return [{"error": "需要 psutil：请用引擎自带的 python 运行"}]
    out = []
    for pid, info in our_processes(home, {}).items():
        if info["proc_kind"] not in ("engine", "gateway"):
            continue
        try:
            env = psutil.Process(pid).environ()
        except (psutil.Error, OSError):
            env = {}
        out.append({"pid": pid, "proc_kind": info["proc_kind"], "profile": info["profile"],
                    "flags": {k: env.get(k) for k in ENV_FLAGS}, "memory": memory_of(pid, False)})
    return sorted(out, key=lambda e: (e["proc_kind"], e["profile"] or ""))


# ---------------------------------------------------------------- check


def _bots(snap: dict) -> dict[str, dict]:
    return {n: h for n, h in snap["homes"].items() if n != "default" and h.get("soul")}


def _relay(snap: dict) -> tuple[str | None, str | None]:
    root = snap["homes"]["default"].get("config") or {}
    return root.get("model_base_url"), root.get("model_key_fp")


def _managed(snap: dict) -> dict[str, dict]:
    """用托管中转的家目录：有任何一个锚点的 base_url 等于根的中转地址。"""
    relay, _ = _relay(snap)
    return {n: h for n, h in snap["homes"].items()
            if relay and any(a["base_url"] == relay for a in (h.get("config") or {}).get("key_anchors", []))}


def check_keys(snap: dict, _args) -> tuple[str, str]:
    relay, root_fp = _relay(snap)
    if not relay or not root_fp:
        return "WARN", "根 config.yaml 没有中转 key（没登录？）"
    managed = _managed(snap)
    lag = [f"{n}:{a['path']}={a['fp']}" for n, h in managed.items()
           for a in h["config"]["key_anchors"] if a["base_url"] == relay and a["fp"] != root_fp]
    # 产品模式建的助手（带 ui_meta.apex）必须走托管中转
    off_relay = [n for n, h in snap["homes"].items() if h["meta"]["ui_meta_apex"] and n not in managed]
    if lag or off_relay:
        return "FAIL", f"中转 key 和根（{root_fp}）不一致：{', '.join(lag) or '无'}；没走托管中转的助手：{off_relay or '无'}"
    return "PASS", f"{len(managed)} 个家目录的中转 key 都是 {root_fp}"


def check_skills(snap: dict, _args) -> tuple[str, str]:
    root = snap["homes"]["default"]["platform_skills"]["files"]
    if not root:
        return "WARN", "根目录没有平台技能（没登录或同步失败）"
    bad = []
    for name, home in _managed(snap).items():
        files = home["platform_skills"]["files"]
        if name == "default" or files == root:
            continue
        missing = sorted(set(root) - set(files))
        extra = sorted(set(files) - set(root))
        changed = sorted(k for k in set(root) & set(files) if root[k] != files[k])
        bad.append(f"{name}: 缺 {len(missing)} 多 {len(extra)} 不同 {len(changed)} {(missing + extra + changed)[:3]}")
    return ("FAIL", "；".join(bad)) if bad else ("PASS", f"{len(root)} 个平台技能文件，各助手一致")


def check_plugins(snap: dict, _args) -> tuple[str, str]:
    root = set((snap["homes"]["default"].get("config") or {}).get("plugins_enabled") or [])
    bad = [f"{n} 缺 {sorted(root - set(h['config']['plugins_enabled']))}" for n, h in _managed(snap).items()
           if root - set(h["config"]["plugins_enabled"])]
    return ("FAIL", "；".join(bad)) if bad else ("PASS", f"各助手都有根的 {len(root)} 个插件")


def check_titles(snap: dict, _args) -> tuple[str, str]:
    bad = [f"{n} 有 {h['sessions']['bot_chat']} 条「{BOT_CHAT_TITLE}」" for n, h in snap["homes"].items()
           if (n == "default" or h["meta"]["ui_meta_apex"]) and h.get("sessions") and h["sessions"]["bot_chat"]]
    return ("FAIL", "；".join(bad)) if bad else ("PASS", f"没有「{BOT_CHAT_TITLE}」会话")


def check_ui_meta(snap: dict, _args) -> tuple[str, str]:
    bad = [n for n, h in snap["homes"].items() if h["meta"]["ui_meta_apex"] and h["meta"]["has_hermes_bots"]]
    if bad:
        return "FAIL", f"产品模式建的助手带了 ui_meta.hermes-bots：{bad}"
    return "PASS", "产品模式的助手没碰 hermes-bots 键"


def check_prompts(snap: dict, _args) -> tuple[str, str]:
    bad, seen = [], 0
    for name, home in snap["homes"].items():
        prompt = (home.get("sessions") or {}).get("main_thread_prompt")
        if not prompt:
            continue
        seen += 1
        if not prompt["has_date_line"]:
            bad.append(f"{name} 没有日期行")
        if prompt["has_bot_protocol"]:
            bad.append(f"{name} 带了互发协议")
        if prompt["mentions_name"] is False:
            bad.append(f"{name} 的系统提示里没有它的名字")
    if bad:
        return "FAIL", "；".join(bad)
    return ("PASS", f"{seen} 个主线的系统提示：有日期行、没有互发协议、名字对") if seen else ("WARN", "还没有主线会话")


# 新助手 SOUL.md 第一行的模板（hc-1078 写、hc-1082 改名时跟着改）；手写过的第一行不算
SOUL_NAME_LINE = re.compile(r"^You are (?P<name>.+?), an AI assistant from ApexNodes HK, working alongside APEX for the same person\.$")


def check_soul_name(snap: dict, _args) -> tuple[str, str]:
    bad, seen = [], 0
    for name, home in _bots(snap).items():
        stored = (home["meta"]["ui_meta_apex"] or {}).get("name")
        match = SOUL_NAME_LINE.match((home.get("soul") or {}).get("first_line") or "")
        if not stored or not match:
            continue
        seen += 1
        if match.group("name") != stored:
            bad.append(f"{name}: SOUL 写的是「{match.group('name')}」，名字是「{stored}」")
    if bad:
        return "FAIL", "；".join(bad)
    return ("PASS", f"{seen} 个助手的 SOUL 第一行和名字一致") if seen else ("WARN", "没有模板形状的 SOUL 第一行可比")


def check_count(snap: dict, args) -> tuple[str, str]:
    bots = sorted(_bots(snap))
    if len(bots) > args.max_bots:
        return "FAIL", f"{len(bots)} 个助手，超过上限 {args.max_bots}：{bots}"
    return "PASS", f"{len(bots)} 个助手（上限 {args.max_bots}）：{bots}"


CHECKS = (
    ("C1", "中转 key 一致", check_keys),
    ("C2", "平台技能一致", check_skills),
    ("C3", "插件启用表", check_plugins),
    ("C4", "不是 Bot Chat", check_titles),
    ("C5", "不碰 Bot 模式资料", check_ui_meta),
    ("C6", "系统提示", check_prompts),
    ("C7", "助手个数", check_count),
    ("C8", "SOUL 第一行的名字", check_soul_name),
)


def run_checks(snap: dict, args) -> list[tuple[str, str, str, str]]:
    return [(cid, title, *fn(snap, args)) for cid, title, fn in CHECKS]


# ---------------------------------------------------------------- diff


def flatten(node: object, prefix: str = "") -> dict[str, object]:
    if isinstance(node, dict):
        out: dict[str, object] = {}
        for key, value in node.items():
            out.update(flatten(value, f"{prefix}.{key}" if prefix else str(key)))
        return out
    return {prefix: node}


def diff_snapshots(before: dict, after: dict) -> list[str]:
    a, b = flatten(before), flatten(after)
    lines = []
    for key in sorted(set(a) | set(b)):
        if key == "taken_at" or a.get(key) == b.get(key):
            continue
        if key not in a:
            lines.append(f"+ {key} = {b[key]!r}")
        elif key not in b:
            lines.append(f"- {key} (was {a[key]!r})")
        else:
            lines.append(f"~ {key}: {a[key]!r} -> {b[key]!r}")
    return lines


# ---------------------------------------------------------------- watch

LOG_LINE = re.compile(r"^\[(?P<ts>\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[hermes\] (?P<text>.*)$")
# 都是 apps/desktop/electron/main.ts、pool-spawn-coordinator.ts 和 hermes_cli/web_server.py 里的原文；
# tests/scripts/test_multi_bot_qa.py 钉着，产品改了日志措辞这里会红，免得 watch 悄悄数成 0。
LOG_EVENTS = (
    ("pool_start", re.compile(r'Starting Hermes backend for profile "(?P<profile>[^"]+)" via ')),
    ("primary_start", re.compile(r"Starting Hermes backend via ")),
    ("ready", re.compile(r"HERMES_BACKEND_READY port=(?P<port>\d+)")),
    ("slot_wait", re.compile(r'Profile backend "(?P<profile>[^"]+)" waiting for a free local slot '
                             r"\((?P<busy>\d+)/(?P<max>\d+) busy, (?P<queued>\d+) queued\)")),
    ("slot_timeout", re.compile(r'Local backend start for "(?P<profile>[^"]+)" timed out while waiting for a free slot')),
    ("evict", re.compile(r'Evicting idle profile backend "(?P<profile>[^"]+)"')),
    ("reap", re.compile(r'Reaping idle profile backend "(?P<profile>[^"]+)"')),
    # hc-1080（fork #500）：回收前先问引擎，有回合在跑就留着
    ("reap_kept", re.compile(r'Keeping idle profile backend "(?P<profile>[^"]+)" another \d+s: '
                             r"the engine did not retire \((?P<reason>[^)]*)\)")),
    ("start_failed", re.compile(r'Hermes backend for profile "(?P<profile>[^"]+)" '
                                r"(?:failed to start|exited before it became ready)")),
    ("exit", re.compile(r'Hermes backend for profile "(?P<profile>[^"]+)" exited \((?P<code>[^)]*)\)')),
    # hc-1080（fork #500）起每个托管 profile 各记一行：「[apexnodes] profile <名字> config.yaml relay key …」
    ("relay_key", re.compile(r"\[apexnodes\] (?:profile (?P<profile>\S+) )?config\.yaml relay key (?P<what>refreshed|write FAILED)")),
    ("http_401", re.compile(r"\b401\b")),
)
POOL_EVENTS = ("slot_wait", "slot_timeout", "evict", "reap", "reap_kept", "start_failed", "exit")


def parse_log_line(line: str) -> dict | None:
    match = LOG_LINE.match(line.rstrip("\n"))
    if not match:
        return None
    text = match.group("text")
    for event, pattern in LOG_EVENTS:
        hit = pattern.search(text)
        if hit:
            return {"t": parse_iso(match.group("ts")), "kind": "log", "event": event, **hit.groupdict(), "text": text[:240]}
    return None


class LogTail:
    def __init__(self, path: Path, from_start: bool):
        self.path = path
        self.offset = 0 if from_start or not path.exists() else path.stat().st_size

    def read(self) -> list[str]:
        if not self.path.exists():
            return []
        if self.path.stat().st_size < self.offset:  # 日志轮转了
            self.offset = 0
        with self.path.open("r", encoding="utf-8-sig", errors="replace") as handle:
            handle.seek(self.offset)
            data = handle.read()
            self.offset = handle.tell()
        return data.splitlines()


class Recorder:
    def __init__(self, out: Path):
        self.out = out

    def emit(self, record: dict) -> None:
        record.setdefault("t", time.time())
        record["iso"] = iso(record["t"])
        with self.out.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


class Watcher:
    def __init__(self, home: Path, recorder: Recorder, uss: bool):
        self.home, self.recorder, self.uss = home, recorder, uss
        self.env_cache: dict[int, str | None] = {}
        self.known: dict[int, dict] = {}
        self.unready: set[int] = set()  # 还没开始监听端口的引擎

    def poll_processes(self) -> dict[int, dict]:
        procs = our_processes(self.home, self.env_cache)
        for pid in procs.keys() - self.known.keys():
            info = procs[pid]
            if info["proc_kind"] in ("engine", "gateway"):
                self.recorder.emit({"kind": "proc_new", "t": info["create_time"], "pid": pid,
                                    "proc_kind": info["proc_kind"], "profile": info["profile"]})
                if info["proc_kind"] == "engine":
                    self.unready.add(pid)
        for pid in self.known.keys() - procs.keys():
            gone = self.known[pid]
            if gone["proc_kind"] in ("engine", "gateway"):
                self.recorder.emit({"kind": "proc_gone", "pid": pid, "proc_kind": gone["proc_kind"], "profile": gone["profile"]})
            self.unready.discard(pid)
        self.known = procs
        return procs

    def poll_listen(self) -> None:
        for pid in sorted(self.unready):
            ports = listening_ports(pid)
            if ports:
                self.recorder.emit({"kind": "listen", "pid": pid, "ports": ports, "profile": self.known[pid]["profile"]})
                self.unready.discard(pid)

    def sample_memory(self, procs: dict[int, dict]) -> None:
        mems = {pid: memory_of(pid, self.uss and procs[pid]["proc_kind"] == "engine") for pid in procs}
        mems = {pid: mem for pid, mem in mems.items() if mem}
        engines = {}
        for pid, info in procs.items():
            if info["proc_kind"] != "engine" or pid not in mems:
                continue
            tree = mems[pid]["rss"] + sum(mems[c]["rss"] for c in descendants(pid, procs) if c in mems)
            engines[str(pid)] = {"profile": info["profile"], **mems[pid], "tree_rss": tree}
        self.recorder.emit({"kind": "mem", "engines": engines, "all_rss": sum(m["rss"] for m in mems.values()),
                            "processes": len(mems)})


def cmd_watch(args) -> int:
    if psutil is None:
        raise SystemExit("watch 需要 psutil：请用引擎自带的 python 运行（见 README）")
    home = Path(args.home).resolve()
    recorder = Recorder(Path(args.out))
    tail = LogTail(home / "logs" / "desktop.log", args.from_start)
    watcher = Watcher(home, recorder, args.uss)
    recorder.emit({"kind": "watch_start", "home": str(home)})
    deadline = time.time() + args.duration if args.duration else None
    next_mem = 0.0
    print(f"记录到 {args.out}；Ctrl-C 结束，然后跑 report", flush=True)
    try:
        while deadline is None or time.time() < deadline:
            for line in tail.read():
                event = parse_log_line(line)
                if event:
                    recorder.emit(event)
            procs = watcher.poll_processes()
            watcher.poll_listen()
            if time.time() >= next_mem:
                watcher.sample_memory(procs)
                next_mem = time.time() + args.mem_interval
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("停止记录", flush=True)
    recorder.emit({"kind": "watch_stop"})
    return 0


# ---------------------------------------------------------------- report


def load_events(path: Path) -> list[dict]:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    return sorted((json.loads(line) for line in lines if line.strip()), key=lambda e: e["t"])


def _first(events: list[dict], pred, after: float) -> dict | None:
    return next((e for e in events if e["t"] >= after and pred(e)), None)


def _last(events: list[dict], pred, after: float, before: float) -> dict | None:
    hits = [e for e in events if after <= e["t"] <= before and pred(e)]
    return hits[-1] if hits else None


def engine_row(new: dict, events: list[dict]) -> dict:
    """一个引擎进程的冷启动：从它前面的「排队等槽」或「Starting」日志，到 READY（找不到就用开始监听）。"""
    pid, profile, born = new["pid"], new["profile"], new["t"]
    start_event = "primary_start" if profile == "default" else "pool_start"
    start = _last(events, lambda e: e.get("event") == start_event and e.get("profile", profile) == profile, born - 120, born + 1)
    wait = _last(events, lambda e: e.get("event") == "slot_wait" and e.get("profile") == profile, born - 120, born)
    mark = _last(events, lambda e: e["kind"] == "mark", born - 120, born)
    listen = _first(events, lambda e: e["kind"] == "listen" and e.get("pid") == pid, born)
    ports = {str(p) for p in (listen or {}).get("ports", [])}
    ready = _first(events, lambda e: e.get("event") == "ready" and e.get("port") in ports, born) if ports else None
    t0 = (wait or start or new)["t"]
    t_ready = (ready or listen or {}).get("t")
    return {
        "profile": profile, "pid": pid, "born": born,
        "slot_wait": round(start["t"] - wait["t"], 1) if wait and start else None,
        "cold_start": round(t_ready - t0, 1) if t_ready else None,
        "ready_source": "READY" if ready else ("listen" if listen else None),
        "mark": (mark or {}).get("label"),
        "mark_to_ready": round(t_ready - mark["t"], 1) if mark and t_ready else None,
    }


def memory_rows(events: list[dict], engines: list[dict]) -> list[dict]:
    samples = [e for e in events if e["kind"] == "mem"]
    rows = []
    for engine in engines:
        pid = str(engine["pid"])
        mine = [(s["t"], s["engines"][pid]) for s in samples if pid in s["engines"]]
        if not mine:
            continue
        settled = next((m for t, m in mine if t >= engine["born"] + 30), mine[-1][1])
        rows.append({"profile": engine["profile"], "pid": engine["pid"], "rss_settled_mb": round(settled["rss"] / 2**20),
                     "uss_settled_mb": round(settled["uss"] / 2**20) if settled.get("uss") else None,
                     "tree_peak_mb": round(max(m["tree_rss"] for _, m in mine) / 2**20)})
    return rows


def build_report(events: list[dict]) -> dict:
    engines = [engine_row(e, events) for e in events if e["kind"] == "proc_new" and e.get("proc_kind") == "engine"]
    mem = [e for e in events if e["kind"] == "mem"]
    return {
        "engines": engines,
        "memory": memory_rows(events, engines),
        "pool_events": [{"iso": e["iso"], "event": e["event"], "profile": e.get("profile"), "text": e.get("text")}
                        for e in events if e.get("event") in POOL_EVENTS],
        "engine_exits": [{"iso": e["iso"], "profile": e.get("profile"), "pid": e["pid"]}
                         for e in events if e["kind"] == "proc_gone" and e.get("proc_kind") == "engine"],
        "marks": [{"iso": e["iso"], "label": e["label"]} for e in events if e["kind"] == "mark"],
        "http_401": sum(1 for e in events if e.get("event") == "http_401"),
        "relay_key": [{"iso": e["iso"], "what": e.get("what"), "profile": e.get("profile") or "default"}
                      for e in events if e.get("event") == "relay_key"],
        "peak_all_rss_mb": round(max((e["all_rss"] for e in mem), default=0) / 2**20),
        "peak_engines": max((len(e["engines"]) for e in mem), default=0),
    }


def _cell(value: object) -> str:
    return "" if value is None else str(value)


def render_report(report: dict) -> str:
    out = ["## 冷启动（秒）", "", "| 助手 | pid | 排队等槽 | 引擎就绪 | 就绪依据 | 前一个标记 | 标记→就绪 |", "|---|---|---|---|---|---|---|"]
    out += [f"| {r['profile']} | {r['pid']} | {_cell(r['slot_wait'])} | {_cell(r['cold_start'])} | {r['ready_source'] or '没就绪'} "
            f"| {_cell(r['mark'])} | {_cell(r['mark_to_ready'])} |" for r in report["engines"]]
    out += ["", "## 内存（MB）", "", "| 助手 | pid | 就绪 30 秒后 RSS | USS | 连子进程峰值 |", "|---|---|---|---|---|"]
    out += [f"| {r['profile']} | {r['pid']} | {r['rss_settled_mb']} | {_cell(r['uss_settled_mb'])} | {r['tree_peak_mb']} |"
            for r in report["memory"]]
    out += ["", f"测试家目录下全部进程 RSS 峰值 {report['peak_all_rss_mb']} MB；同时在跑的引擎最多 {report['peak_engines']} 个。",
            "", "## 池事件和引擎退出", ""]
    out += [f"- {e['iso']} {e['event']} {_cell(e['profile'])} — {e['text']}" for e in report["pool_events"]]
    out += [f"- {e['iso']} 引擎进程退出 {_cell(e['profile'])}（pid {e['pid']}）" for e in report["engine_exits"]]
    out += ["", "## 其他", "", f"- 含 401 的日志行：{report['http_401']}"]
    out += [f"- {k['iso']} {k['profile']} 的中转 key {k['what']}" for k in report["relay_key"]]
    out += [f"- 标记 {m['iso']} {m['label']}" for m in report["marks"]]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- tokens / fixture


def cmd_tokens(args) -> int:
    since = parse_iso(args.since) if args.since else 0.0
    total_in = total_out = calls = 0
    for name, home in profile_homes(Path(args.home)).items():
        db = home / "state.db"
        if not db.is_file():
            continue
        rows = [r for r in _session_rows(db) if (r.get("started_at") or 0) >= since]
        t_in = sum(r.get("input_tokens") or 0 for r in rows)
        t_out = sum(r.get("output_tokens") or 0 for r in rows)
        n_calls = sum(r.get("api_call_count") or 0 for r in rows)
        total_in, total_out, calls = total_in + t_in, total_out + t_out, calls + n_calls
        print(f"{name}: 会话 {len(rows)}，调用 {n_calls}，输入 {t_in}，输出 {t_out}")
    usd = total_in / 1e6 * args.price_in + total_out / 1e6 * args.price_out
    print(f"合计：调用 {calls}，输入 {total_in}，输出 {total_out}，按标价约 ${usd:.3f}（不算缓存折扣）")
    return 0


def find_ffmpeg(home: Path | None, explicit: str | None) -> str:
    if explicit:
        return explicit
    names = ("ffmpeg.exe", "ffmpeg")
    if home:
        for name in names:
            hits = sorted(home.glob(f"versions/*/.runtime/bin/{name}")) + sorted(home.glob(f"tools/{name}"))
            if hits:
                return str(hits[-1])
    found = shutil.which("ffmpeg")
    if not found:
        raise SystemExit("找不到 ffmpeg：用 --ffmpeg 指定，或 --home 指向已经激活引擎的测试家目录")
    return found


def run_ffmpeg(argv: list[str], timeout: float) -> float:
    started = time.monotonic()
    subprocess.run(argv, check=True, capture_output=True, timeout=timeout)
    return time.monotonic() - started


def cmd_fixture(args) -> int:
    ffmpeg = find_ffmpeg(Path(args.home) if args.home else None, args.ffmpeg)
    seconds = int(args.minutes * 60)
    source = ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
    out = Path(args.out)
    took = run_ffmpeg([ffmpeg, "-hide_banner", "-y", *source, "-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast",
                       "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)], timeout=seconds * 4 + 120)
    print(f"写好 {out}（{args.minutes} 分钟，生成用了 {took:.0f} 秒）")
    if args.calibrate:
        probe = out.with_name(out.stem + ".calibrate.mp4")
        took = run_ffmpeg([ffmpeg, "-hide_banner", "-y", "-t", "20", "-i", str(out), "-c:v", "libx264", "-preset", args.calibrate,
                           "-crf", "18", "-c:a", "aac", str(probe)], timeout=1800)
        probe.unlink(missing_ok=True)
        print(f"preset {args.calibrate}：20 秒素材转码 {took:.1f} 秒 → 整段约 {took * seconds / 20 / 60:.1f} 分钟")
    return 0


# ---------------------------------------------------------------- cli


def cmd_snapshot(args) -> int:
    snap = take_snapshot(Path(args.home).resolve(), live=args.live)
    text = json.dumps(snap, ensure_ascii=False, indent=1)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"快照写到 {args.out}")
    else:
        print(text)
    return 0


def cmd_check(args) -> int:
    snap = json.loads(Path(args.snapshot).read_text(encoding="utf-8-sig")) if args.snapshot else take_snapshot(Path(args.home).resolve())
    results = run_checks(snap, args)
    for cid, title, status, detail in results:
        print(f"{status:4} {cid} {title}：{detail}")
    return 1 if any(status == "FAIL" for _, _, status, _ in results) else 0


def cmd_diff(args) -> int:
    before = json.loads(Path(args.before).read_text(encoding="utf-8-sig"))
    after = json.loads(Path(args.after).read_text(encoding="utf-8-sig"))
    lines = diff_snapshots(before, after)
    print("\n".join(lines) if lines else "两份快照一样")
    return 0


def cmd_mark(args) -> int:
    Recorder(Path(args.out)).emit({"kind": "mark", "label": args.label})
    return 0


def cmd_report(args) -> int:
    report = build_report(load_events(Path(args.events)))
    print(json.dumps(report, ensure_ascii=False, indent=1) if args.json else render_report(report))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="hc-1083 多助手验收：测量和核对（只读）")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("snapshot")
    p.add_argument("--home", required=True)
    p.add_argument("--out")
    p.add_argument("--live", action="store_true", help="同时记录在跑的引擎、网关和它们的开关环境变量")
    p = sub.add_parser("check")
    p.add_argument("--home")
    p.add_argument("--snapshot")
    p.add_argument("--max-bots", type=int, default=4)
    p = sub.add_parser("diff")
    p.add_argument("before")
    p.add_argument("after")
    p = sub.add_parser("watch")
    p.add_argument("--home", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--interval", type=float, default=0.5)
    p.add_argument("--mem-interval", type=float, default=5.0)
    p.add_argument("--duration", type=float)
    p.add_argument("--from-start", action="store_true")
    p.add_argument("--uss", action="store_true", help="也量 USS（独占内存，慢一些）")
    p = sub.add_parser("mark")
    p.add_argument("--out", required=True)
    p.add_argument("label")
    p = sub.add_parser("report")
    p.add_argument("events")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("tokens")
    p.add_argument("--home", required=True)
    p.add_argument("--since")
    p.add_argument("--price-in", type=float, default=0.15, help="美元 / 百万输入 token（Flash 标价）")
    p.add_argument("--price-out", type=float, default=0.60)
    p = sub.add_parser("fixture")
    p.add_argument("--out", required=True)
    p.add_argument("--minutes", type=float, default=10)
    p.add_argument("--home")
    p.add_argument("--ffmpeg")
    p.add_argument("--calibrate", metavar="PRESET")
    return parser


COMMANDS = {
    "snapshot": cmd_snapshot, "check": cmd_check, "diff": cmd_diff, "watch": cmd_watch, "mark": cmd_mark,
    "report": cmd_report, "tokens": cmd_tokens, "fixture": cmd_fixture,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "check" and not (args.home or args.snapshot):
        raise SystemExit("check 要 --home 或 --snapshot")
    return COMMANDS[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
