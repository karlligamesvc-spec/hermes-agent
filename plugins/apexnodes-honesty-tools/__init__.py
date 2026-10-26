"""ApexNodes deterministic honesty and ad-compliance check (``honesty_verify``).

The rules are not in this file. They live in the copy-compliance-check skill's graded lexicon
(apex-nodes ``app/skills/apexnodes/copy-compliance-check/references/ad-lexicon.json``, hc-1022),
the single source of truth for the cloud agents and APEX Desktop:

* cloud agents: the platform skill sits at ``HERMES_HOME/skills/copy-compliance-check/`` (always
  installed next to honesty-verification) and this plugin at ``HERMES_HOME/plugins/``;
* APEX Desktop: the skill arrives after login at ``HERMES_HOME/skills/apexnodes/copy-compliance-check/``
  and this plugin ships in the engine (hermes-agent fork ``plugins/apexnodes-honesty-tools/``,
  byte-identical to the apex-nodes copy; apex-nodes CI compares the bytes).

No lexicon, no check: the tool then returns an error that says so, never a PASS.

What it does, in order (hc-1023):

1. Context: platform, scene (挂车带货 / 种草 / 纯内容 / 投流), category. A call that names a scene is
   ad copy: a missing platform is checked as Douyin (the strictest) and the result says so. A call
   without a scene (meeting notes, reports, support replies also call this tool) is not checked as an
   ad: rules limited to ad scenes drop to 「建议改」, rules for every scene keep their level.
2. Mechanical match: every pattern rule of the lexicon, minus its exclusions, negations
   (「不是最好的」) and phrases the user proved (``proven``: a trademark, a registered function).
3. Levels from the rule's scope and overrides: 必须改 (must_fix) / 要证据 (needs_evidence) /
   建议改 (suggest). Overlapping hits keep the most severe one.
4. Required notices (「效果因人而异」「本品不能代替药物」, risk notices) that are missing.
5. ``corrected_text``: every 必须改 hit removed (the word, or its clause) and the missing notices
   appended. It is re-checked until no 必须改 is left. The model then rewrites it into fluent
   sentences with facts the user gave; this text is the floor, not the final copy.

Status: any 必须改 → FAIL (the original is never delivered as written; the corrected version is);
要证据 → NEEDS_REVIEW; only 建议改 → NEEDS_REVIEW (strict / moderate) or PASS (relaxed).
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

from tools.registry import tool_error, tool_result

STATUS_PASS = "PASS"
STATUS_NEEDS_REVIEW = "NEEDS_REVIEW"
STATUS_FAIL = "FAIL"

RISK_PROFILES = {"strict", "moderate", "relaxed"}

LEXICON_SKILL = "copy-compliance-check"
LEXICON_FILE = ("references", "ad-lexicon.json")
LEXICON_SCHEMA = "apex-ad-lexicon/1"

MUST_FIX = "must_fix"
NEEDS_EVIDENCE = "needs_evidence"
SUGGEST = "suggest"
SKIP = "skip"
SEVERITY = {MUST_FIX: 3, NEEDS_EVIDENCE: 2, SUGGEST: 1}
SCORES = {MUST_FIX: 9, NEEDS_EVIDENCE: 6, SUGGEST: 3}
LEGACY_SEVERITY = {MUST_FIX: "hard", NEEDS_EVIDENCE: "soft", SUGGEST: "soft"}

# A clause ends at these marks; 必须改 rules that delete a clause cut here.
_CLAUSE_END = re.compile(r"[，,；;。！？!?\n]")
# A sentence ends at these; a source or a date anywhere in the sentence counts for its claims.
_SENTENCE_END = re.compile(r"[。！？!?\n]")
_NEGATION_WINDOW = 4
_SCOPE_FIELDS = {"platforms": "platform", "scenes": "scene", "categories": "category"}
_MAX_CORRECTION_ROUNDS = 4

HONESTY_VERIFY_SCHEMA = {
    "name": "honesty_verify",
    "description": (
        "Deterministically check customer-facing text against APEX's graded ad-law and platform lexicon "
        "(copy-compliance-check). Returns PASS, NEEDS_REVIEW, or FAIL, the hits in three columns "
        "(必须改 / 要证据 / 建议改) with basis codes, missing required notices, and corrected_text with "
        "every 必须改 hit removed. Pass scene for ad copy; without it the text is not checked as an ad."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Customer-facing text to verify (script, captions, title, body, hashtags, cover text)."},
            "risk_profile": {"type": "string", "description": "strict, moderate, or relaxed. Defaults to moderate."},
            "platform": {"type": "string", "description": "Where it is published: douyin, xiaohongshu, kuaishou, channels, tiktok, bilibili, wechat, amazon (Chinese names work too)."},
            "scene": {"type": "string", "description": "commerce (挂车带货/直播), seeding (种草，没挂链接), content (纯内容), ad (投流). Give it for ad copy; leave it out for reports, notes and replies."},
            "category": {"type": "string", "description": "What is sold: general, food, health_food, cosmetics, medical, education, finance, real_estate, alcohol, baby, appliance (Chinese names work too)."},
            "proven": {"type": "array", "items": {"type": "string"}, "description": "Exact phrases from the text the user can prove (a trademark or product name, a registered cosmetic function, an award's full name)."},
            "ai_content": {"type": "boolean", "description": "True when the post uses AI-generated visuals, voice or music (adds a reminder only; never a label)."},
        },
        "required": ["text"],
    },
}


class LexiconUnavailable(RuntimeError):
    pass


_cache_lock = threading.Lock()
_cache: dict[str, Any] = {}


def _hermes_homes() -> list[Path]:
    homes: list[Path] = []
    try:
        from hermes_constants import get_hermes_home
    except ImportError:  # apex-nodes tests load the plugin without the runtime around it
        get_hermes_home = None
    if get_hermes_home is not None:
        homes.append(Path(get_hermes_home()))
    env_home = os.environ.get("HERMES_HOME")
    if env_home:
        homes.append(Path(env_home))
    # <HERMES_HOME>/plugins/apexnodes-honesty-tools/__init__.py → <HERMES_HOME>; in an apex-nodes
    # checkout the same walk lands on app/, whose skills/apexnodes/ holds the source lexicon.
    homes.append(Path(__file__).resolve().parent.parent.parent)
    return homes


def lexicon_candidates() -> list[Path]:
    paths: list[Path] = []
    for home in _hermes_homes():
        paths.append(home.joinpath("skills", LEXICON_SKILL, *LEXICON_FILE))  # cloud agent home
        paths.append(home.joinpath("skills", "apexnodes", LEXICON_SKILL, *LEXICON_FILE))  # APEX Desktop, apex-nodes checkout
    seen: set[Path] = set()
    unique = []
    for path in paths:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def _compile(patterns: list[str]) -> list[re.Pattern]:
    return [re.compile(pattern) for pattern in patterns]


def _prepare(raw: dict[str, Any]) -> dict[str, Any]:
    if raw.get("schema") != LEXICON_SCHEMA:
        raise LexiconUnavailable(f"词库格式不认识({raw.get('schema')!r}),要 {LEXICON_SCHEMA}")
    rules = []
    for rule in raw["rules"]:
        if rule.get("match") != "pattern":
            continue
        rules.append({
            **rule,
            "_patterns": _compile(rule["patterns"]),
            "_exclude": _compile(rule.get("exclude") or []),
            "_satisfied": [_compile(group) for group in rule.get("satisfied_by") or []],
        })
    notices = [{**notice, "_trigger": _compile(notice["trigger"]), "_present": _compile(notice["present"])} for notice in raw.get("required_notices") or []]
    reminders = [{**item, "_trigger": _compile(item.get("trigger") or [])} for item in raw.get("reminders") or []]
    return {"raw": raw, "rules": rules, "notices": notices, "reminders": reminders}


def load_lexicon() -> dict[str, Any]:
    for path in lexicon_candidates():
        try:
            stat = path.stat()
        except OSError:
            continue
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        with _cache_lock:
            if _cache.get("key") == key:
                return _cache["lexicon"]
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            lexicon = _prepare(raw)
        except (OSError, ValueError, KeyError, re.error) as exc:
            raise LexiconUnavailable(f"词库文件读不了:{path}({exc})") from exc
        lexicon["path"] = str(path)
        with _cache_lock:
            _cache.update(key=key, lexicon=lexicon)
        return lexicon
    raise LexiconUnavailable("没找到词库文件 copy-compliance-check/references/ad-lexicon.json")


def _normalize(value: Any, known: dict[str, Any], aliases: dict[str, str]) -> tuple[str, str]:
    """→ (key or "", raw text). Unknown non-empty values come back as ("", raw)."""
    raw = str(value or "").strip()
    if not raw:
        return "", ""
    lowered = raw.lower().replace("-", "_").replace(" ", "_")
    if lowered in known:
        return lowered, raw
    if raw in aliases:
        return aliases[raw], raw
    if lowered in aliases:
        return aliases[lowered], raw
    return "", raw


def resolve_context(lexicon: dict[str, Any], platform: Any, scene: Any, category: Any) -> dict[str, Any]:
    raw = lexicon["raw"]
    platform_key, platform_raw = _normalize(platform, raw["platforms"], raw["platform_aliases"])
    scene_key, scene_raw = _normalize(scene, raw["scenes"], raw["scene_aliases"])
    category_key, category_raw = _normalize(category, raw["categories"], raw["category_aliases"])
    assumed: list[str] = []
    if not category_key and not category_raw and platform_raw and not platform_key:
        # Older callers passed an industry as platform (platform="real_estate").
        category_key = raw.get("platform_category_aliases", {}).get(platform_raw, "")
    if platform_raw and not platform_key:
        platform_key = "other"
    if scene_raw and not scene_key:
        scene_key = "commerce"
        assumed.append(f"场景「{scene_raw}」不认识，按挂车带货查")
    if scene_key and not platform_key:
        platform_key = raw["defaults"]["platform_when_scene_given"]
        assumed.append("平台没给，按抖音电商规则查(最严)")
    if category_raw and not category_key:
        assumed.append(f"品类「{category_raw}」不认识，品类条目只作提醒")
    if not category_key:
        assumed.append("品类没给，品类条目只作提醒")
    return {
        "platform": platform_key,
        "scene": scene_key,
        "category": category_key,
        "ad_copy": bool(scene_key),
        "assumed": assumed,
    }


def _scope_matches(values: list[str], value: str) -> bool:
    return values == ["*"] or (bool(value) and value in values)


def rule_level(rule: dict[str, Any], context: dict[str, Any]) -> tuple[str, str]:
    """Level of ``rule`` in ``context`` → (level, note). Category mismatch skips the rule."""
    scope = rule["scope"]
    categories = scope["categories"]
    if categories != ["*"]:
        if not context["category"]:
            labels = "、".join(context["category_labels"].get(c, c) for c in categories)
            return SUGGEST, f"如果卖的是{labels}，这句必须改"
        if context["category"] not in categories:
            return SKIP, ""
    in_scope = _scope_matches(scope["platforms"], context["platform"]) and _scope_matches(scope["scenes"], context["scene"])
    level = rule["level"] if in_scope else rule.get("outside_scope", SUGGEST)
    note = ""
    if in_scope:
        for override in rule.get("overrides") or []:
            if all(_scope_matches(values, context[_SCOPE_FIELDS[field]]) for field, values in override["when"].items()):
                level = override["level"]
    elif level != SKIP and not context["ad_copy"] and scope["scenes"] != ["*"]:
        note = "没说是广告文案，只作提醒;要是带货文案，这句必须改" if rule["level"] == MUST_FIX else ""
    return level, note


def _span(text: str, start: int, end: int, boundary: re.Pattern = _CLAUSE_END) -> tuple[int, int]:
    left = start
    while left > 0 and not boundary.match(text[left - 1]):
        left -= 1
    right = end
    while right < len(text) and not boundary.match(text[right]):
        right += 1
    return left, right


def _negated(text: str, start: int, markers: list[str]) -> bool:
    window = text[max(0, start - _NEGATION_WINDOW):start]
    return any(window.endswith(marker) for marker in markers)


def _proven_spans(text: str, proven: list[str]) -> list[tuple[int, int]]:
    spans = []
    for phrase in proven:
        phrase = str(phrase or "").strip()
        if not phrase:
            continue
        spans.extend(match.span() for match in re.finditer(re.escape(phrase), text))
    return spans


def find_hits(lexicon: dict[str, Any], text: str, context: dict[str, Any], proven: list[str]) -> list[dict[str, Any]]:
    markers = lexicon["raw"]["negation_markers"]
    proven_spans = _proven_spans(text, proven)
    candidates = []
    for order, rule in enumerate(lexicon["rules"]):
        level, note = rule_level(rule, context)
        if level == SKIP:
            continue
        excluded = [match.span() for pattern in rule["_exclude"] for match in pattern.finditer(text)]
        for pattern in rule["_patterns"]:
            for match in pattern.finditer(text):
                start, end = match.span()
                if start == end or any(s <= start < e for s, e in excluded):
                    continue
                if rule.get("negation_exempt") and _negated(text, start, markers):
                    continue
                clause = _span(text, start, end)
                hit_level, hit_note = level, note
                sentence_start, sentence_end = _span(text, start, end, _SENTENCE_END)
                sentence = text[sentence_start:sentence_end]
                if rule["_satisfied"] and rule["level"] != MUST_FIX and any(all(p.search(sentence) for p in group) for group in rule["_satisfied"]):
                    if hit_level == rule["level"]:
                        hit_level, hit_note = SUGGEST, "已写来源或时间：发布时要能出示证明"
                if any(s <= start and end <= e for s, e in proven_spans):
                    downgrade = rule.get("proof_downgrades_to") or (SUGGEST if rule["level"] == NEEDS_EVIDENCE else "")
                    if downgrade and SEVERITY[downgrade] < SEVERITY[hit_level]:
                        hit_level, hit_note = downgrade, "你说过这个说法有证明：保留，发布时要能出示"
                candidates.append({
                    "rule": rule,
                    "level": hit_level,
                    "note": hit_note,
                    "start": start,
                    "end": end,
                    "clause": clause,
                    "order": order,
                })
    candidates.sort(key=lambda h: (-SEVERITY[h["level"]], -(h["end"] - h["start"]), h["order"], h["start"]))
    kept: list[dict[str, Any]] = []
    for hit in candidates:
        if any(hit["start"] < other["end"] and other["start"] < hit["end"] for other in kept):
            continue
        kept.append(hit)
    kept.sort(key=lambda h: (h["start"], h["order"]))
    return kept


def _notice_level(notice: dict[str, Any], context: dict[str, Any]) -> str:
    scope = notice["scope"]
    if scope["categories"] != ["*"] and context["category"] not in scope["categories"]:
        return SKIP
    in_scope = _scope_matches(scope["platforms"], context["platform"]) and _scope_matches(scope["scenes"], context["scene"])
    return notice["level"] if in_scope else notice.get("outside_scope", SKIP)


def missing_notices(lexicon: dict[str, Any], text: str, context: dict[str, Any]) -> list[dict[str, Any]]:
    missing = []
    for notice in lexicon["notices"]:
        level = _notice_level(notice, context)
        if level == SKIP:
            continue
        if any(p.search(text) for p in notice["_trigger"]) and not any(p.search(text) for p in notice["_present"]):
            missing.append({"notice": notice, "level": level})
    return missing


def _basis_text(rule: dict[str, Any]) -> str:
    parts = []
    for item in rule["basis"]:
        ref = f" {item['ref']}" if item.get("ref") else ""
        parts.append(f"{item['code']}{ref}({item['date']})")
    return " / ".join(parts)


def _tidy(text: str) -> str:
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"([，,；;、])\s*(?=[，,；;。！？!?\n]|$)", "", text)
    text = re.sub(r"^[，,；;、。！？!?\s]+", "", text)
    text = re.sub(r"\n[，,；;、。！？!?]+", "\n", text)
    text = re.sub(r"([。！？!?])[，,；;、]+", r"\1", text)
    return text.strip()


def _apply_fixes(text: str, hits: list[dict[str, Any]]) -> str:
    """Remove every must_fix hit: the matched word (delete_match) or its whole clause."""
    cuts: list[tuple[int, int]] = []
    for hit in hits:
        if hit["level"] != MUST_FIX:
            continue
        action = hit["rule"]["fix"]["action"]
        if action == "delete_match":
            start, end = hit["start"], hit["end"]
            if text[end:end + 1] == "的":
                end += 1
            clause_start, clause_end = hit["clause"]
            remaining = (text[clause_start:start] + text[end:clause_end]).strip()
            if len(re.sub(r"[^一-龥A-Za-z0-9]", "", remaining)) < 2:
                cuts.append((clause_start, min(len(text), clause_end + 1)))
            else:
                cuts.append((start, end))
        else:
            clause_start, clause_end = hit["clause"]
            head = text[clause_start - 1:clause_start]
            tail = text[clause_end:clause_end + 1]
            if tail and tail in "，,；;、":
                clause_end += 1  # the clause takes its own comma
            elif tail and tail in "。！？!?\n" and (not head or head in "。！？!?\n"):
                clause_end += 1  # a whole sentence or line goes with its end mark (no 「。。」)
            cuts.append((clause_start, clause_end))
    if not cuts:
        return text
    cuts.sort()
    merged: list[list[int]] = []
    for start, end in cuts:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    out = []
    cursor = 0
    for start, end in merged:
        out.append(text[cursor:start])
        cursor = end
    out.append(text[cursor:])
    return _tidy("".join(out))


def correct_text(lexicon: dict[str, Any], text: str, context: dict[str, Any], proven: list[str]) -> str:
    corrected = text
    for _ in range(_MAX_CORRECTION_ROUNDS):
        hits = [h for h in find_hits(lexicon, corrected, context, proven) if h["level"] == MUST_FIX]
        if not hits:
            break
        corrected = _apply_fixes(corrected, hits)
    else:
        hits = [h for h in find_hits(lexicon, corrected, context, proven) if h["level"] == MUST_FIX]
        for hit in sorted(hits, key=lambda h: -h["clause"][0]):
            start, end = hit["clause"]
            corrected = corrected[:start] + corrected[end:]
        corrected = _tidy(corrected)
    additions = [m["notice"]["append"] for m in missing_notices(lexicon, corrected, context) if m["level"] == MUST_FIX]
    if additions:
        joined = corrected.rstrip()
        if joined and joined[-1] not in "。！？!?\n":
            joined += "。"
        corrected = joined + "".join(additions)
    return corrected


def _row(hit: dict[str, Any], text: str, corrected_clause: str | None) -> dict[str, Any]:
    rule = hit["rule"]
    clause = text[hit["clause"][0]:hit["clause"][1]].strip()
    row = {
        "code": rule["id"],
        "title": rule["title"],
        "matched": text[hit["start"]:hit["end"]],
        "sentence": clause,
        "why": rule["why"],
        "how": rule["fix"]["how"],
        "basis": _basis_text(rule),
    }
    if rule["fix"].get("example"):
        row["example"] = rule["fix"]["example"]
    if hit["level"] == NEEDS_EVIDENCE and rule.get("evidence"):
        row["evidence"] = rule["evidence"]
    if hit["note"]:
        row["note"] = hit["note"]
    if corrected_clause is not None:
        row["rewrite"] = corrected_clause
    return row


def verify_text(
    text: str,
    risk_profile: str = "moderate",
    platform: str | None = None,
    *,
    scene: str | None = None,
    category: str | None = None,
    proven: list[str] | None = None,
    ai_content: bool = False,
) -> dict[str, Any]:
    profile = (risk_profile or "moderate").strip().lower()
    if profile not in RISK_PROFILES:
        profile = "moderate"
    lexicon = load_lexicon()
    raw = lexicon["raw"]
    text = str(text or "")
    proven = [str(p) for p in (proven or []) if str(p or "").strip()]
    context = resolve_context(lexicon, platform, scene, category)
    context["category_labels"] = {key: value["label"] for key, value in raw["categories"].items()}

    hits = find_hits(lexicon, text, context, proven)
    notices = missing_notices(lexicon, text, context)
    corrected = correct_text(lexicon, text, context, proven)

    columns: dict[str, list[dict[str, Any]]] = {raw["levels"][level]["column"]: [] for level in (MUST_FIX, NEEDS_EVIDENCE, SUGGEST)}
    for hit in hits:
        rewrite = None
        if hit["level"] == MUST_FIX:
            start, end = hit["clause"]
            rewrite = _apply_fixes(text[start:end], [{**hit, "start": hit["start"] - start, "end": hit["end"] - start, "clause": (0, end - start)}])
        columns[raw["levels"][hit["level"]]["column"]].append(_row(hit, text, rewrite))
    for item in notices:
        notice = item["notice"]
        columns[raw["levels"][item["level"]]["column"]].append({
            "code": notice["id"],
            "title": notice["title"],
            "matched": "(缺)",
            "sentence": "",
            "why": notice["why"],
            "how": f"补上：{notice['append']}",
            "basis": _basis_text(notice),
            "rewrite": notice["append"] if item["level"] == MUST_FIX else None,
        })

    levels = [hit["level"] for hit in hits] + [item["level"] for item in notices]
    if MUST_FIX in levels:
        status = STATUS_FAIL
    elif NEEDS_EVIDENCE in levels:
        status = STATUS_NEEDS_REVIEW
    elif levels:
        status = STATUS_PASS if profile == "relaxed" else STATUS_NEEDS_REVIEW
    else:
        status = STATUS_PASS
    risk_score = max([1] + [SCORES[level] for level in levels])

    legal = []
    category_info = raw["categories"].get(context["category"], {})
    if category_info.get("notice"):
        legal.append(category_info["notice"])
    if category_info.get("legal_review"):
        legal.append(raw["legal_review_line"])
    reminders = []
    for item in lexicon["reminders"]:
        if item.get("when") == "ai_content":
            if ai_content:
                reminders.append(item["text"])
            continue
        scope = item["scope"]
        if _scope_matches(scope["scenes"], context["scene"]) and _scope_matches(scope["platforms"], context["platform"]) and any(p.search(text) for p in item["_trigger"]):
            reminders.append(item["text"])

    issues = [
        {
            "type": hit["rule"]["id"],
            "matched": text[hit["start"]:hit["end"]],
            "severity": LEGACY_SEVERITY[hit["level"]],
            "level": hit["level"],
            "suggestion": hit["rule"]["fix"]["how"],
        }
        for hit in hits
    ] + [
        {"type": item["notice"]["id"], "matched": "(缺)" + item["notice"]["append"], "severity": LEGACY_SEVERITY[item["level"]], "level": item["level"], "suggestion": f"补上：{item['notice']['append']}"}
        for item in notices
    ]

    if status == STATUS_PASS:
        direct = "可直接使用：查过，没有必须改的说法。"
        review = "需人工确认：无。" if not levels else "需人工确认：建议改的条目可以再看一眼。"
    elif status == STATUS_NEEDS_REVIEW:
        direct = "可直接使用：没有必须改的说法;要证据的条目核实后再用。"
        review = "需人工确认：要证据的说法要用户出示证明(来源、时间、范围),没有就删;建议改的条目按需调整。"
    else:
        direct = "可直接使用：原文不能原样交付，用改好的版本(corrected_text,再改成通顺的整句)。"
        review = "需人工确认：必须改的条目已在改好的版本里删掉或补上提示;要证据的说法要用户出示证明。"

    return {
        "status": status,
        "risk_score": risk_score,
        "risk_profile_used": profile,
        "lexicon_version": raw["version"],
        "context": {k: context[k] for k in ("platform", "scene", "category", "assumed")},
        "columns": columns,
        "corrected_text": corrected,
        "legal_review": legal,
        "reminders": reminders,
        "issues": issues,
        "split_hint": {"可直接使用": direct, "需人工确认": review},
    }


def _handle_honesty_verify(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("honesty_verify expects a JSON object argument")
    text = args.get("text")
    if text is None:
        return tool_error("text is required")
    proven = args.get("proven") or []
    if isinstance(proven, str):
        proven = [proven]
    try:
        result = verify_text(
            str(text),
            risk_profile=str(args.get("risk_profile") or "moderate"),
            platform=str(args.get("platform") or "") or None,
            scene=str(args.get("scene") or "") or None,
            category=str(args.get("category") or "") or None,
            proven=[str(p) for p in proven if p] if isinstance(proven, list) else [],
            ai_content=bool(args.get("ai_content")),
        )
    except LexiconUnavailable as exc:
        return tool_error(
            f"合规词库不可用，这次没做确定性检查({exc})。按 copy-compliance-check 技能人工逐条查，"
            "不要当成通过;桌面端登录后会自动同步技能和词库。"
        )
    return tool_result(**result)


# --------------------------------------------------------------------------- #
# hc-1036 交付诚实：两道钩子，只看工具调用，不改任何工具。规则全文在 honesty-verification 技能里。
#
# 1. 证据等级：要写进技能或记忆的内容(skill_manage / memory / 桌面 apex_memory / 云端 IM memory_ledger，以及写进 skills/、
#    memories/ 目录的 write_file / patch)把资料标成「官方」，或在定义了「✅=官方」的内容里打 ✅，
#    那一行就得写着本会话真打开过的页面(web_extract / browser_navigate 成功过的网址)，或写明是
#    用户给的材料;转述(社媒、博主、公众号)打 ✅、说「直连抖音」也不让存。工具结果说清哪几行、怎么改。
# 2. 不自己换模型：这一轮里 generate_video / generate_image / text_to_speech 已经失败或超时过，
#    又换了一个这一轮没用过的 model / provider，就拦下，让助手先问用户。同样的设置重试不拦，
#    用户回了话(新的一轮)再换也不拦。
# 开关：HONESTY_GUARDS_DISABLE=1 两道都关。
# --------------------------------------------------------------------------- #

DURABLE_WRITE_TOOLS = frozenset({"skill_manage", "memory", "apex_memory", "memory_ledger"})
DURABLE_FILE_TOOLS = frozenset({"write_file", "patch"})
PAGE_OPEN_TOOLS = {"web_extract": ("urls", "url"), "browser_navigate": ("url",)}
SWITCH_KEYS = {"generate_video": ("model", "provider"), "generate_image": ("model", "provider"), "text_to_speech": ("provider",)}
SWITCH_LABELS = {"generate_video": "生成视频", "generate_image": "生成图片", "text_to_speech": "配音"}
FAILED_STATUSES = frozenset({"error", "timeout"})

_TEXT_KEYS = ("content", "new_string", "file_content", "new_text")
_DURABLE_PATH = re.compile(r"(?:^|[\\/])(?:skills|memories)[\\/]")
_LEVEL_MARKS = ("✅", "🔶", "⚠️", "❓")
_OFFICIAL_CLAIM = re.compile(
    r"官方(?:口径|精确值|精确|数据|发布|公布|通知|文件|原文|确认|方案|规定|标准|统计|时间|日期|来源|渠道|值)"
    r"|✅\s*官方|[（(【\[]官方[）)】\]]|官方[:：]"
)
# 图例(一行里有两种以上标记)或定义(「✅=官方口径」)说明这份内容里 ✅ 就是官方。
_CHECK_MEANS_OFFICIAL = re.compile(r"✅\s*[=＝:：]?\s*官方")
_DEFINITION = re.compile(r"✅\s*[=＝:：]")
_DEFERRAL = re.compile(r"以[^，。；;\n]{0,30}为准")
_SECOND_HAND = re.compile(r"社媒|转述|转引|博主|笔记|公众号|网友|自媒体|引官方|二手|搜索结果")
_USER_PROVIDED = re.compile(r"用户(?:提供|给的|发的|上传)|你(?:提供|给|发|上传)的")
_DIRECT_CLAIM = re.compile(
    r"直连(?:抖音|小红书|快手|视频号|B站|微博|知乎|TikTok|平台|官方)|直接(?:对|从)抖音(?:发起|拉取|调用|抓取)"
)
_URL_HOST = re.compile(r"https?://([^/\s)）】\]>'\"，。；?#]+)")
_DOMAIN = re.compile(r"(?<![A-Za-z0-9.-])((?:[A-Za-z0-9-]+\.)+(?:cn|com|org|net|gov|edu))(?![A-Za-z0-9-])", re.IGNORECASE)
_MAX_GUARD_SESSIONS = 512
_MAX_PROBLEM_LINES = 6

_guard_lock = threading.Lock()
_guard_sessions: dict[str, dict[str, Any]] = {}


def _guards_disabled() -> bool:
    return (os.getenv("HONESTY_GUARDS_DISABLE") or "").strip().lower() in {"1", "true", "yes", "on"}


def _guard_session(session_id: str) -> dict[str, Any]:
    """This session's state, most recent last (callers hold _guard_lock)."""
    state = _guard_sessions.pop(session_id, None) or {"turn": 0, "pages": set(), "attempts": {}}
    _guard_sessions[session_id] = state
    while len(_guard_sessions) > _MAX_GUARD_SESSIONS:
        _guard_sessions.pop(next(iter(_guard_sessions)))
    return state


def _hosts(text: str) -> set[str]:
    hosts = {host.strip().lower().split(":")[0] for host in _URL_HOST.findall(text) + _DOMAIN.findall(text)}
    return {host.removeprefix("www.") for host in hosts}


def _is_legend(line: str) -> bool:
    return sum(mark in line for mark in _LEVEL_MARKS) >= 2 or bool(_DEFINITION.search(line))


def _claims_official(line: str, check_means_official: bool) -> bool:
    for match in _OFFICIAL_CLAIM.finditer(line):
        start, end = _span(line, match.start(), match.end())
        if not _DEFERRAL.search(line[start:end]):  # 「以官方通知为准」是提醒，不是说自己是官方
            return True
    return check_means_official and "✅" in line


def _cites_opened_page(line: str, opened: set[str]) -> bool:
    return any(h == o or h.endswith("." + o) or o.endswith("." + h) for h in _hosts(line) for o in opened)


def evidence_problems(text: str, opened: set[str]) -> list[tuple[str, str]]:
    """(kind, line) for each line whose evidence level is higher than this session can back."""
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    check_means_official = any(_is_legend(line) and _CHECK_MEANS_OFFICIAL.search(line) for line in lines)
    problems = []
    for line in lines:
        if _DIRECT_CLAIM.search(line):
            problems.append(("direct", line))
        elif _is_legend(line) or _USER_PROVIDED.search(line):
            continue
        elif "✅" in line and _SECOND_HAND.search(line):
            problems.append(("second_hand", line))
        elif _claims_official(line, check_means_official) and not _cites_opened_page(line, opened):
            problems.append(("official", line))
    return problems


def evidence_block_message(problems: list[tuple[str, str]], opened: set[str]) -> str:
    kinds = {kind for kind, _ in problems}
    parts = ["没存：要写进技能或记忆的内容里，有资料的证据等级写高了。"]
    if "official" in kinds:
        seen = f"这次打开过：{'、'.join(sorted(opened)[:5])}" if opened else "这次一个网页都没打开过"
        parts.append(
            f"标成「官方」(或按「✅=官方」打了 ✅)的条目，那一行要写着这次真打开过的官方页面的网址({seen})，"
            "或写明是用户给的材料。搜索结果、博主笔记、机构和自媒体的公众号都是二手，它们自称「官方口径」也一样。"
        )
    if "second_hand" in kinds:
        parts.append("✅ 只给官方原文和一手数据(你自己打开的页面、工具返回的原始数据、用户给的材料);转述的标 🔶 二手。")
    if "direct" in kinds:
        parts.append("APEX 拿抖音等平台的数据都经第三方数据服务(TikHub)转接，没有直连平台：写成「经 TikHub 拿到的抖音公开数据」。")
    parts.append("照实标等级(官方 / 一手 / 二手 / 推测)并写上来源，再存一次;存进技能和记忆时等级不能往高了写。")
    shown = [f"- {line.lstrip('-*•# ')[:80]}" for _, line in problems[:_MAX_PROBLEM_LINES]]
    if len(problems) > _MAX_PROBLEM_LINES:
        shown.append(f"- ……还有 {len(problems) - _MAX_PROBLEM_LINES} 行")
    return "\n".join(parts) + "\n有问题的行：\n" + "\n".join(shown)


def _durable_texts(tool_name: str, args: dict) -> list[str]:
    if tool_name in DURABLE_FILE_TOOLS and not _DURABLE_PATH.search(str(args.get("path") or args.get("file_path") or "")):
        return []
    items = [args] + [op for op in args.get("operations") or [] if isinstance(op, dict)]
    return [item[key] for item in items for key in _TEXT_KEYS if isinstance(item.get(key), str) and item[key]]


def _call_failed(status: Any, result: Any) -> bool:
    if status:
        return status in FAILED_STATUSES
    if isinstance(result, str):
        if result.startswith("Error executing tool"):
            return True
        try:
            result = json.loads(result)
        except ValueError:
            return False
    return isinstance(result, dict) and bool(result.get("error") or result.get("success") is False or result.get("ok") is False)


def _choice(tool_name: str, args: dict) -> tuple[str, ...]:
    return tuple(str(args.get(key) or "").strip() for key in SWITCH_KEYS[tool_name])


def switch_block_message(tool_name: str, failed: tuple[str, ...], wanted: tuple[str, ...]) -> str:
    def show(choice: tuple[str, ...]) -> str:
        return "、".join(f"{key}={value}" for key, value in zip(SWITCH_KEYS[tool_name], choice) if value) or "平台默认设置"

    return (
        f"没执行：这一轮「{SWITCH_LABELS[tool_name]}」用「{show(failed)}」已经失败或超时过，不能自己换成「{show(wanted)}」。"
        "先告诉用户上次没成功，问他要不要换、换成哪个;他同意了，下一条消息里再换。用同样的设置重试不受这条限制。"
    )


def _switch_block(state: dict[str, Any], tool_name: str, args: dict) -> str | None:
    choice = _choice(tool_name, args)
    record = state["attempts"].get(tool_name)
    if record is None or record["turn"] != state["turn"]:
        record = state["attempts"][tool_name] = {"turn": state["turn"], "tried": set(), "failed": []}
    if record["failed"] and choice not in record["tried"]:
        return switch_block_message(tool_name, record["failed"][-1], choice)
    record["tried"].add(choice)
    return None


def _on_pre_llm_call(session_id: str = "", **_: Any) -> None:
    with _guard_lock:
        _guard_session(session_id or "")["turn"] += 1


def _on_pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "", **_: Any) -> dict | None:
    if not isinstance(args, dict) or _guards_disabled():
        return None
    message = None
    if tool_name in SWITCH_KEYS:
        with _guard_lock:
            message = _switch_block(_guard_session(session_id or ""), tool_name, args)
    elif tool_name in DURABLE_WRITE_TOOLS or tool_name in DURABLE_FILE_TOOLS:
        texts = _durable_texts(tool_name, args)
        if texts:
            with _guard_lock:
                opened = set(_guard_session(session_id or "")["pages"])
            problems = [problem for text in texts for problem in evidence_problems(text, opened)]
            message = evidence_block_message(problems, opened) if problems else None
    return {"action": "block", "message": message} if message else None


def _on_post_tool_call(
    tool_name: str = "", args: Any = None, result: Any = None, status: Any = None, session_id: str = "", **_: Any
) -> None:
    if not isinstance(args, dict) or (tool_name not in PAGE_OPEN_TOOLS and tool_name not in SWITCH_KEYS):
        return
    failed = _call_failed(status, result)
    with _guard_lock:
        state = _guard_session(session_id or "")
        if tool_name in PAGE_OPEN_TOOLS and not failed:
            for key in PAGE_OPEN_TOOLS[tool_name]:
                urls = args.get(key) if isinstance(args.get(key), list) else [args.get(key)]
                state["pages"].update(h for url in urls for h in _hosts(str(url or "")))
        elif tool_name in SWITCH_KEYS and failed:
            record = state["attempts"].get(tool_name)
            if record is not None and record["turn"] == state["turn"]:
                record["failed"].append(_choice(tool_name, args))


def register(ctx):
    ctx.register_tool(
        name="honesty_verify",
        toolset="skills",
        schema=HONESTY_VERIFY_SCHEMA,
        handler=_handle_honesty_verify,
        check_fn=lambda: True,
        requires_env=[],
        description=HONESTY_VERIFY_SCHEMA["description"],
        emoji="🛡️",
    )
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
