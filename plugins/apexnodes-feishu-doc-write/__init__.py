"""ApexNodes Feishu document write tool (desktop variant, hc-581).

This is the desktop-bundled sibling of the hermes-cloud
``app/runtime_plugins/apexnodes-feishu-doc-write`` plugin. The tool logic is
identical — it uses the owner-scoped Feishu/Lark app credentials already present
in the process environment and never reads platform-wide secrets — but the
availability gate differs so the tool stays invisible until the desktop user has
actually bound a Feishu channel.

── Credential source on desktop (hc-417 / hc-444) ───────────────────────────────
When a desktop user binds Feishu (IM 入口 device-code flow, hc-417, or the
hc-444 cloud-agent credential bridge), the electron shell injects the owner
Feishu app credential into the backend spawn env just-in-time and decrypted:
``FEISHU_APP_ID`` / ``FEISHU_APP_SECRET`` (+ ``FEISHU_DOMAIN``). This lands in
BOTH the ``hermes dashboard`` backend (in-app chat) and the ``hermes gateway
run`` messaging gateway (inbound Feishu chat) processes — the two surfaces where
the agent runs tools — so ``_owner_credentials()`` resolves the same way the
cloud container does. These are full app credentials that mint a *tenant* access
token, exactly the scope this tool needs; no new credential path is invented.

── Availability gate (未绑定飞书 = 不露出) ──────────────────────────────────────
Unlike the cloud plugin (always registered when ``lark_oapi`` is importable, and
error-at-call-time when creds are absent), this desktop copy hides until the
owner Feishu credential is present in the env — the presence of
``FEISHU_APP_ID`` + ``FEISHU_APP_SECRET`` IS the "Feishu is bound" signal
(绑定判据用现有渠道状态). Not bound (or SDK absent) → the tool self-hides rather
than surfacing a dead tool that would only fail at call time.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from tools.registry import tool_error, tool_result

FEISHU_DOC_URL_BASE = os.getenv("FEISHU_DOC_URL_BASE", "https://www.feishu.cn/docx").rstrip("/")
FEISHU_DOC_FOLDER_TOKEN = os.getenv("FEISHU_DOC_FOLDER_TOKEN", "").strip()

_CREATE_DOC_URI = "/open-apis/docx/v1/documents"
_APPEND_BLOCKS_URI = "/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children"
_DESCENDANT_URI = "/open-apis/docx/v1/documents/:document_id/blocks/:block_id/descendant"


FEISHU_DOC_WRITE_SCHEMA = {
    "name": "feishu_doc_write",
    "description": (
        "Create or append to a Feishu/Lark docx document using the current "
        "agent owner's Feishu app credentials. Pass an empty doc_id to create "
        "a new document. Returns the document id and URL."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "doc_id": {
                "type": "string",
                "description": "Existing Feishu docx document_id. Leave empty to create a new document.",
            },
            "content": {
                "type": "string",
                "description": (
                    "Markdown text (headings/lists/tables/code/dividers/bold are "
                    "rendered as native docx structure), plain text, or a JSON "
                    "string containing Feishu docx blocks."
                ),
            },
            "title": {
                "type": "string",
                "description": "Title to use when doc_id is empty and a new document is created.",
            },
        },
        "required": ["content"],
    },
}


def _lark_oapi_available() -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec("lark_oapi") is not None
    except (ImportError, ValueError):
        return False


def _owner_credentials() -> tuple[str, str]:
    """Return owner-scoped credentials from native or managed container env."""
    candidates = [
        ("FEISHU_APP_ID", "FEISHU_APP_SECRET"),
        ("LARK_APP_ID", "LARK_APP_SECRET"),
        ("OWNER_FEISHU_APP_ID", "OWNER_FEISHU_APP_SECRET"),
    ]
    for app_key, secret_key in candidates:
        app_id = (os.getenv(app_key) or "").strip()
        app_secret = (os.getenv(secret_key) or "").strip()
        if app_id and app_secret:
            return app_id, app_secret
    return "", ""


def _check_feishu_doc_write() -> bool:
    """Desktop gate: available only when the Feishu SDK is importable AND an
    owner Feishu binding is present in the env.

    The desktop injects owner ``FEISHU_APP_ID``/``FEISHU_APP_SECRET`` into the
    backend spawn env ONLY when a Feishu channel is bound (hc-417 / hc-444), so
    their presence is the binding signal (绑定判据用现有渠道状态). Not bound, or
    the SDK / credentials absent → the tool self-hides instead of surfacing a
    dead tool. Mirrors the cloud plugin's handler credential check so a shown
    tool always has a usable credential.
    """
    if not _lark_oapi_available():
        return False
    app_id, app_secret = _owner_credentials()
    return bool(app_id and app_secret)


def _build_client(app_id: str, app_secret: str):
    import lark_oapi as lark
    from lark_oapi.core.const import FEISHU_DOMAIN

    return (
        lark.Client.builder()
        .app_id(app_id)
        .app_secret(app_secret)
        .domain(FEISHU_DOMAIN)
        .log_level(lark.LogLevel.WARNING)
        .build()
    )


def _do_request(client, method: str, uri: str, *, paths=None, queries=None, body=None) -> tuple[int | None, str, dict]:
    from lark_oapi.core import AccessTokenType, HttpMethod
    from lark_oapi.core.model import BaseRequest

    http_method = HttpMethod.GET
    if method.upper() == "POST":
        http_method = HttpMethod.POST
    elif method.upper() == "PATCH":
        http_method = HttpMethod.PATCH
    elif method.upper() == "PUT":
        http_method = HttpMethod.PUT

    builder = (
        BaseRequest.builder()
        .http_method(http_method)
        .uri(uri)
        .token_types({AccessTokenType.TENANT})
    )
    if paths:
        builder = builder.paths(paths)
    if queries:
        builder = builder.queries(queries)
    if body is not None:
        builder = builder.body(body)

    response = client.request(builder.build())
    code = getattr(response, "code", None)
    msg = getattr(response, "msg", "")

    data: dict[str, Any] = {}
    raw = getattr(response, "raw", None)
    content = getattr(raw, "content", None)
    if content:
        try:
            body_json = json.loads(content)
            data = body_json.get("data", {}) or {}
            if code is None:
                code = body_json.get("code")
            if not msg:
                msg = body_json.get("msg", "")
        except (TypeError, json.JSONDecodeError):
            pass
    if not data:
        response_data = getattr(response, "data", None)
        if isinstance(response_data, dict):
            data = response_data
        elif response_data and hasattr(response_data, "__dict__"):
            data = vars(response_data)
    return code, msg, data


def _doc_text_block(content: str) -> dict:
    return {
        "block_type": 2,
        "text": {
            "elements": [
                {
                    "text_run": {
                        "content": content,
                    }
                }
            ]
        },
    }


def _split_doc_chunks(text: str, *, chunk_size: int = 1800) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in (text or "").split("\n"):
        piece = paragraph.rstrip()
        while len(piece) > chunk_size:  # hc-164: a single unbroken line (long
            # transcript sentence run) must still be hard-split to stay within
            # the docx text-block size limit.
            if current:
                chunks.append("\n".join(current).strip())
                current = []
                current_len = 0
            chunks.append(piece[:chunk_size])
            piece = piece[chunk_size:]
        projected = current_len + len(piece) + 1
        if current and projected > chunk_size:
            chunks.append("\n".join(current).strip())
            current = []
            current_len = 0
        current.append(piece)
        current_len += len(piece) + 1
    if current:
        chunks.append("\n".join(current).strip())
    return [chunk for chunk in chunks if chunk]


# ── HC-164 v1: markdown → native docx blocks ────────────────────────────────
# Replaces the old 1800-char plain-text chunking for markdown content, so a
# breakdown report keeps its structure (headings, lists, tables, code,
# dividers, bold) instead of arriving as one wall of text.

_INLINE_TOKEN_RE = re.compile(r"(\*\*.+?\*\*|`[^`]+`)", re.DOTALL)
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_DIVIDER_RE = re.compile(r"^(-{3,}|\*{3,}|_{3,})$")
_BULLET_RE = re.compile(r"^\s*[-*+]\s+(.+)$")
_ORDERED_RE = re.compile(r"^\s*\d+[.)]\s+(.+)$")
_TABLE_SEP_RE = re.compile(r"^\|?[\s:|-]+\|?$")


def _parse_inline(text: str) -> list[dict]:
    elements: list[dict] = []
    for part in _INLINE_TOKEN_RE.split(text or ""):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            elements.append({"text_run": {"content": part[2:-2], "text_element_style": {"bold": True}}})
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            elements.append({"text_run": {"content": part[1:-1], "text_element_style": {"inline_code": True}}})
        else:
            elements.append({"text_run": {"content": part}})
    return elements or [{"text_run": {"content": ""}}]


def _element_block(block_type: int, field: str, text: str) -> dict:
    return {"block_type": block_type, field: {"elements": _parse_inline(text)}}


def _split_table_row(line: str) -> list[str]:
    cells = line.strip().strip("|").split("|")
    return [cell.strip() for cell in cells]


def _markdown_to_blocks(text: str) -> list[dict]:
    blocks: list[dict] = []
    paragraph: list[str] = []
    lines = (text or "").split("\n")

    def flush_paragraph() -> None:
        if not paragraph:
            return
        joined = "\n".join(paragraph)
        paragraph.clear()
        for chunk in _split_doc_chunks(joined):
            blocks.append(_element_block(2, "text", chunk))

    i = 0
    total = len(lines)
    while i < total:
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            flush_paragraph()
            buf: list[str] = []
            i += 1
            while i < total and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1  # skip the closing fence when present
            blocks.append({
                "block_type": 14,
                "code": {"elements": [{"text_run": {"content": "\n".join(buf)}}], "style": {"language": 1}},
            })
            continue

        if (
            stripped.startswith("|")
            and "|" in stripped[1:]
            and i + 1 < total
            and _TABLE_SEP_RE.match(lines[i + 1].strip())
            and "-" in lines[i + 1]
        ):
            flush_paragraph()
            rows = [_split_table_row(stripped)]
            i += 2  # past header + separator
            while i < total and lines[i].strip().startswith("|") and "|" in lines[i].strip()[1:]:
                rows.append(_split_table_row(lines[i].strip()))
                i += 1
            columns = max(len(row) for row in rows)
            cells = [row + [""] * (columns - len(row)) for row in rows]
            blocks.append({
                "block_type": 31,
                "table": {"property": {"row_size": len(cells), "column_size": columns}},
                "_table_cells": cells,
            })
            continue

        if _DIVIDER_RE.match(stripped):
            flush_paragraph()
            blocks.append({"block_type": 22, "divider": {}})
            i += 1
            continue

        heading = _HEADING_RE.match(stripped)
        if heading:
            flush_paragraph()
            level = len(heading.group(1))
            blocks.append(_element_block(2 + level, f"heading{level}", heading.group(2).strip()))
            i += 1
            continue

        ordered = _ORDERED_RE.match(line)
        if ordered:
            flush_paragraph()
            blocks.append(_element_block(13, "ordered", ordered.group(1).strip()))
            i += 1
            continue

        bullet = _BULLET_RE.match(line)
        if bullet:
            flush_paragraph()
            blocks.append(_element_block(12, "bullet", bullet.group(1).strip()))
            i += 1
            continue

        if not stripped:
            flush_paragraph()
            i += 1
            continue

        paragraph.append(stripped)
        i += 1

    flush_paragraph()
    return blocks


def _blocks_from_content(content: Any) -> list[dict]:
    """Accept plain text, markdown-like text, or JSON-encoded docx blocks."""
    raw = content
    if isinstance(content, str):
        stripped = content.strip()
        if stripped.startswith("[") or stripped.startswith("{"):
            try:
                raw = json.loads(stripped)
            except json.JSONDecodeError:
                raw = content

    if isinstance(raw, dict):
        children = raw.get("children")
        if isinstance(children, list):
            return [block for block in children if isinstance(block, dict)]
        if "block_type" in raw:
            return [raw]
    if isinstance(raw, list):
        return [block for block in raw if isinstance(block, dict)]

    return _markdown_to_blocks(str(content or ""))


def _permission_hint(code: int | None, msg: str) -> str:
    return (
        f"Feishu doc API failed: code={code} msg={msg or 'unknown error'}. "
        "请确认该 owner 飞书应用已开通并授权云文档 docx 创建/编辑权限。"
    )


def _create_document(client, title: str) -> str:
    payload: dict[str, Any] = {"title": (title or "Agent report")[:800]}
    if FEISHU_DOC_FOLDER_TOKEN:
        payload["folder_token"] = FEISHU_DOC_FOLDER_TOKEN

    code, msg, data = _do_request(client, "POST", _CREATE_DOC_URI, body=payload)
    if code != 0:
        raise RuntimeError(_permission_hint(code, msg))
    document = data.get("document") or {}
    document_id = document.get("document_id")
    if not document_id:
        raise RuntimeError(f"Feishu doc create returned no document_id: {data}")
    return str(document_id)


def _append_simple_blocks(client, document_id: str, children: list[dict], *, batch_tag: str) -> None:
    for index in range(0, len(children), 50):
        code, msg, _data = _do_request(
            client,
            "POST",
            _APPEND_BLOCKS_URI,
            paths={"document_id": document_id, "block_id": document_id},
            queries={
                "document_revision_id": "-1",
                "client_token": f"{document_id}-{batch_tag}-{index}",
            },
            body={"children": children[index:index + 50]},
        )
        if code != 0:
            raise RuntimeError(_permission_hint(code, msg))


def _append_table_block(client, document_id: str, table_block: dict, *, batch_tag: str) -> None:
    """Tables need the descendant endpoint: the table, its cells, and the cell
    text are created as one nested tree in a single call."""
    cells: list[list[str]] = table_block.pop("_table_cells", [])
    children_ids: list[str] = []
    descendants: list[dict] = [
        {
            "block_id": "tbl",
            "block_type": 31,
            "table": table_block.get("table") or {},
            "children": children_ids,
        }
    ]
    for r, row in enumerate(cells):
        for c, cell_text in enumerate(row):
            cell_id = f"cell_{r}_{c}"
            text_id = f"txt_{r}_{c}"
            children_ids.append(cell_id)
            descendants.append({"block_id": cell_id, "block_type": 32, "table_cell": {}, "children": [text_id]})
            descendants.append({"block_id": text_id, "block_type": 2, "text": {"elements": _parse_inline(cell_text)}})
    code, msg, _data = _do_request(
        client,
        "POST",
        _DESCENDANT_URI,
        paths={"document_id": document_id, "block_id": document_id},
        # the descendant endpoint rejects a client_token query (1770001).
        queries={"document_revision_id": "-1"},
        body={"children_id": ["tbl"], "index": 0, "descendants": descendants},
    )
    if code != 0:
        raise RuntimeError(_permission_hint(code, msg))


def _append_blocks(client, document_id: str, blocks: list[dict]) -> None:
    """Append in order; simple blocks go in batches, tables via descendant."""
    if not blocks:
        return
    pending: list[dict] = []
    sequence = 0

    def flush() -> None:
        nonlocal sequence
        if pending:
            _append_simple_blocks(client, document_id, list(pending), batch_tag=f"{int(time.time())}-{sequence}")
            pending.clear()
            sequence += 1

    for block in blocks:
        if "_table_cells" in block:
            flush()
            _append_table_block(client, document_id, dict(block), batch_tag=f"{int(time.time())}-{sequence}")
            sequence += 1
        else:
            pending.append(block)
    flush()


def _handle_feishu_doc_write(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("feishu_doc_write expects a JSON object argument")

    app_id, app_secret = _owner_credentials()
    if not app_id or not app_secret:
        return tool_error(
            "Owner Feishu app credentials are not configured in this agent container; cannot write Feishu docs."
        )

    try:
        client = _build_client(app_id, app_secret)
    except ImportError:
        return tool_error("lark_oapi is not installed in this runtime image")
    except Exception as exc:
        return tool_error(f"Failed to initialize Feishu SDK client: {exc}")

    doc_id = str(args.get("doc_id") or "").strip()
    title = str(args.get("title") or "Agent report").strip()
    content = args.get("content")
    if content is None or (isinstance(content, str) and not content.strip()):
        return tool_error("content is required")

    try:
        blocks = _blocks_from_content(content)
        if not doc_id:
            doc_id = _create_document(client, title)
        _append_blocks(client, doc_id, blocks)
        return tool_result(
            success=True,
            doc_id=doc_id,
            document_id=doc_id,
            url=f"{FEISHU_DOC_URL_BASE}/{doc_id}",
            blocks_written=len(blocks),
        )
    except Exception as exc:
        return tool_error(str(exc))


def register(ctx):
    ctx.register_tool(
        name="feishu_doc_write",
        toolset="feishu_doc",
        schema=FEISHU_DOC_WRITE_SCHEMA,
        handler=_handle_feishu_doc_write,
        check_fn=_check_feishu_doc_write,
        requires_env=[],
        description=FEISHU_DOC_WRITE_SCHEMA["description"],
        emoji="📝",
    )
