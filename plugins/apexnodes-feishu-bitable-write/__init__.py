"""ApexNodes Feishu Bitable (多维表格) record-write tool (desktop variant, hc-581).

Desktop-bundled sibling of the hermes-cloud
``app/runtime_plugins/apexnodes-feishu-bitable-write`` plugin. The tool logic is
identical — it only uses the owner-scoped Feishu/Lark app credentials already
present in the process environment (never platform-wide secrets), and talks to
the Feishu open API with the owner tenant access token — but the availability
gate differs so the tool stays invisible until the desktop user has bound a
Feishu channel.

── Credential source on desktop (hc-417 / hc-444) ───────────────────────────────
When a desktop user binds Feishu, the electron shell injects the owner Feishu app
credential (``FEISHU_APP_ID``/``FEISHU_APP_SECRET``, decrypted just in time) into
BOTH the ``hermes dashboard`` backend and the ``hermes gateway run`` messaging
gateway spawn env — the two surfaces where the agent runs tools — so
``_owner_credentials()`` resolves the same way the cloud container does. These
are full app credentials that mint a *tenant* access token, exactly the scope
this tool needs; no new credential path is invented.

── Availability gate (未绑定飞书 = 不露出) ──────────────────────────────────────
Unlike the cloud plugin (always registered when ``lark_oapi`` is importable, and
error-at-call-time when creds are absent), this desktop copy hides until the
owner Feishu credential is present in the env — the presence of ``FEISHU_APP_ID``
+ ``FEISHU_APP_SECRET`` IS the "Feishu is bound" signal (绑定判据用现有渠道状态).

The user supplies the *Bitable URL* (or app_token + table_id); the owner's Feishu
app must hold the bitable record edit scope and be a collaborator on that base.

The tool is schema-aware: it reads the target table's field metadata and coerces
each supplied value to that field's actual type (number / datetime / url / select
/ checkbox / text), drops columns the table does not have, and honestly reports
fields it cannot set from text (e.g. attachment columns). The caller passes a flat
``{字段名: 值}`` object and does not need to know Feishu field-type encodings.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any

from tools.registry import tool_error, tool_result

_FIELDS_URI = "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields"
_CREATE_RECORD_URI = "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records"
_BATCH_CREATE_URI = "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_create"

# ui_type groups (Feishu Bitable field metadata "ui_type" string is the stable key).
_NUMBER_TYPES = {"Number", "Progress", "Currency", "Rating"}
_DATETIME_TYPES = {"DateTime"}
_URL_TYPES = {"Url"}
_MULTISELECT_TYPES = {"MultiSelect"}
_SINGLESELECT_TYPES = {"SingleSelect"}
_CHECKBOX_TYPES = {"Checkbox"}
_TEXT_TYPES = {"Text", "Barcode", "Phone", "Email"}
# Read-only / computed / reference fields that cannot be written from a flat value.
_READONLY_TYPES = {
    "CreatedTime",
    "ModifiedTime",
    "CreatedUser",
    "ModifiedUser",
    "AutoNumber",
    "Formula",
    "Lookup",
}
# Editable but need structured ids/uploads we don't have from a text/url value.
_UNSETTABLE_TYPES = {"Attachment", "User", "GroupChat", "SingleLink", "DuplexLink", "Location"}


FEISHU_BITABLE_WRITE_SCHEMA = {
    "name": "feishu_bitable_write",
    "description": (
        "把一行数据写入飞书多维表格（Bitable）的某个数据表，使用当前 Agent owner 的飞书应用凭证。"
        "传入表格链接 bitable_url（飞书「分享→复制链接」得到的 /base/ 链接），或显式传 app_token + table_id；"
        "再传 fields（一个 {字段名: 值} 对象，字段名要和表格列名一致）。工具会自动按列的真实类型转换数值/日期/链接/"
        "单选多选/勾选，并跳过表里没有的列。也可传 records 数组一次写多行。返回写入的 record_id。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "bitable_url": {
                "type": "string",
                "description": "飞书多维表格链接（含 /base/<app_token>?table=<table_id>）。提供后自动解析 app_token 与 table_id。",
            },
            "app_token": {
                "type": "string",
                "description": "多维表格 app_token（不传 bitable_url 时必填）。",
            },
            "table_id": {
                "type": "string",
                "description": "数据表 table_id，形如 tblxxxx（不传 bitable_url 或链接中无 table 时必填）。",
            },
            "fields": {
                "type": "object",
                "description": "单行数据：{字段名: 值}。字段名须与表格列名一致；多余字段会被忽略。",
            },
            "records": {
                "type": "array",
                "description": "批量写入：每个元素是一行的 {字段名: 值} 对象。与 fields 二选一即可。",
                "items": {"type": "object"},
            },
        },
        "required": [],
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


def _check_feishu_bitable_write() -> bool:
    """Desktop gate: available only when the Feishu SDK is importable AND an
    owner Feishu binding is present in the env.

    The desktop injects owner ``FEISHU_APP_ID``/``FEISHU_APP_SECRET`` into the
    backend spawn env ONLY when a Feishu channel is bound (hc-417 / hc-444), so
    their presence is the binding signal (绑定判据用现有渠道状态). Not bound, or
    the SDK / credentials absent → the tool self-hides instead of surfacing a
    dead tool. Mirrors the handler credential check so a shown tool always has a
    usable credential.
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


def _parse_bitable_url(url: str) -> tuple[str, str]:
    """Extract (app_token, table_id) from a Feishu bitable share URL.

    Handles ``/base/<app_token>?table=<table_id>`` and the path form
    ``/base/<app_token>/table/<table_id>``. Wiki-hosted bases (``/wiki/<node>``)
    carry a wiki node token, not an app_token — those return ('', table_id) so
    the caller can ask for an explicit app_token honestly."""
    app_token = ""
    table_id = ""
    base_match = re.search(r"/base/([A-Za-z0-9]+)", url or "")
    if base_match:
        app_token = base_match.group(1)
    table_match = re.search(r"[?&]table=([A-Za-z0-9]+)", url or "") or re.search(r"/table/([A-Za-z0-9]+)", url or "")
    if table_match:
        table_id = table_match.group(1)
    return app_token, table_id


def _permission_hint(code: int | None, msg: str) -> str:
    return (
        f"Feishu Bitable API failed: code={code} msg={msg or 'unknown error'}. "
        "请确认该 owner 飞书应用已开通多维表格(bitable)记录读写权限，且已被添加为这张多维表格的协作者（可编辑）。"
    )


def _field_type_map(client, app_token: str, table_id: str) -> dict[str, str]:
    """Return {field_name: ui_type} for the target table, paginating defensively."""
    type_map: dict[str, str] = {}
    page_token = ""
    for _ in range(20):  # safety bound; a schema this flow targets has ~18 columns
        queries = {"page_size": "100"}
        if page_token:
            queries["page_token"] = page_token
        code, msg, data = _do_request(
            client, "GET", _FIELDS_URI, paths={"app_token": app_token, "table_id": table_id}, queries=queries
        )
        if code != 0:
            raise RuntimeError(_permission_hint(code, msg))
        for item in data.get("items", []) or []:
            if not isinstance(item, dict):
                continue
            name = item.get("field_name")
            if not name:
                continue
            ui_type = item.get("ui_type")
            if not ui_type:
                ui_type = _INT_TYPE_TO_UI.get(item.get("type"), "Text")
            type_map[str(name)] = str(ui_type)
        if not data.get("has_more"):
            break
        page_token = data.get("page_token") or ""
        if not page_token:
            break
    return type_map


# Numeric Bitable field-type fallback when ui_type is absent (older API responses).
_INT_TYPE_TO_UI = {
    1: "Text",
    2: "Number",
    3: "SingleSelect",
    4: "MultiSelect",
    5: "DateTime",
    7: "Checkbox",
    11: "User",
    13: "Phone",
    15: "Url",
    17: "Attachment",
    18: "SingleLink",
    20: "Formula",
    21: "DuplexLink",
    22: "Location",
    23: "GroupChat",
    1001: "CreatedTime",
    1002: "ModifiedTime",
    1003: "CreatedUser",
    1004: "ModifiedUser",
    1005: "AutoNumber",
}


def _to_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value).strip().replace(",", "").replace("，", "")
    text = re.sub(r"[^0-9.\-]", "", text)
    if text in ("", "-", ".", "-."):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _to_epoch_ms(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        # < 1e12 → seconds; otherwise already milliseconds.
        return int(number * 1000) if number < 1_000_000_000_000 else int(number)
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        number = float(text)
        return int(number * 1000) if number < 1_000_000_000_000 else int(number)
    normalized = text.replace("/", "-").replace("Z", "+00:00")
    for parser in (
        lambda s: datetime.fromisoformat(s),
        lambda s: datetime.strptime(s, "%Y-%m-%d %H:%M:%S"),
        lambda s: datetime.strptime(s, "%Y-%m-%d %H:%M"),
        lambda s: datetime.strptime(s, "%Y-%m-%d"),
    ):
        try:
            parsed = parser(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            continue
    return None


def _coerce_value(value: Any, ui_type: str) -> tuple[Any, str | None]:
    """Coerce ``value`` to the encoding Bitable expects for ``ui_type``.

    Returns ``(coerced_value, skip_reason)``. A non-None skip_reason means the
    field should be omitted from the record (and reported honestly)."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, "empty"
    if ui_type in _READONLY_TYPES:
        return None, f"{ui_type}（只读/自动计算列，无法写入）"
    if ui_type in _UNSETTABLE_TYPES:
        return None, f"{ui_type}（需文件/成员等结构化数据，文本无法直接写入）"
    if ui_type in _NUMBER_TYPES:
        number = _to_number(value)
        return (number, None) if number is not None else (None, "无法解析为数字")
    if ui_type in _DATETIME_TYPES:
        ms = _to_epoch_ms(value)
        return (ms, None) if ms is not None else (None, "无法解析为日期时间")
    if ui_type in _CHECKBOX_TYPES:
        if isinstance(value, bool):
            return value, None
        return str(value).strip().lower() in ("true", "1", "yes", "是", "✓", "y"), None
    if ui_type in _URL_TYPES:
        link = str(value).strip()
        return {"link": link, "text": link}, None
    if ui_type in _MULTISELECT_TYPES:
        if isinstance(value, list):
            options = [str(item).strip() for item in value if str(item).strip()]
        else:
            options = [part.strip() for part in re.split(r"[,，、;；]", str(value)) if part.strip()]
        return options, None
    if ui_type in _SINGLESELECT_TYPES:
        if isinstance(value, list):
            return (str(value[0]).strip() if value else None), None
        return str(value).strip(), None
    # Text / Phone / Barcode / Email / anything else → string.
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False), None
    return str(value), None


def _build_fields(raw_fields: dict, type_map: dict[str, str]) -> tuple[dict, list[str], list[str]]:
    """Map a flat {name: value} dict to a Bitable ``fields`` payload.

    Returns (fields_payload, skipped_unknown, skipped_typed). ``skipped_unknown``
    are names not present in the table; ``skipped_typed`` are present-but-not-
    settable-from-text columns (with the reason)."""
    payload: dict[str, Any] = {}
    skipped_unknown: list[str] = []
    skipped_typed: list[str] = []
    for name, value in (raw_fields or {}).items():
        key = str(name).strip()
        if key not in type_map:
            skipped_unknown.append(key)
            continue
        coerced, skip_reason = _coerce_value(value, type_map[key])
        if skip_reason == "empty":
            continue
        if skip_reason:
            skipped_typed.append(f"{key}: {skip_reason}")
            continue
        payload[key] = coerced
    return payload, skipped_unknown, skipped_typed


def _create_records(client, app_token: str, table_id: str, rows: list[dict]) -> list[str]:
    """Create one or many records; returns the new record_ids."""
    if len(rows) == 1:
        code, msg, data = _do_request(
            client,
            "POST",
            _CREATE_RECORD_URI,
            paths={"app_token": app_token, "table_id": table_id},
            queries={"client_token": f"{table_id}-{int(time.time() * 1000)}"},
            body={"fields": rows[0]},
        )
        if code != 0:
            raise RuntimeError(_permission_hint(code, msg))
        record = data.get("record") or {}
        return [str(record.get("record_id"))] if record.get("record_id") else []
    code, msg, data = _do_request(
        client,
        "POST",
        _BATCH_CREATE_URI,
        paths={"app_token": app_token, "table_id": table_id},
        queries={"client_token": f"{table_id}-{int(time.time() * 1000)}"},
        body={"records": [{"fields": row} for row in rows]},
    )
    if code != 0:
        raise RuntimeError(_permission_hint(code, msg))
    return [str(rec.get("record_id")) for rec in (data.get("records") or []) if rec.get("record_id")]


def _handle_feishu_bitable_write(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("feishu_bitable_write expects a JSON object argument")

    app_id, app_secret = _owner_credentials()
    if not app_id or not app_secret:
        return tool_error(
            "Owner Feishu app credentials are not configured in this agent container; cannot write Feishu Bitable."
        )

    bitable_url = str(args.get("bitable_url") or "").strip()
    app_token = str(args.get("app_token") or "").strip()
    table_id = str(args.get("table_id") or "").strip()
    if bitable_url:
        url_app, url_table = _parse_bitable_url(bitable_url)
        app_token = app_token or url_app
        table_id = table_id or url_table
    if not app_token:
        return tool_error(
            "缺少多维表格 app_token。请提供 /base/ 形式的多维表格链接（bitable_url），"
            "或直接传 app_token。注意 /wiki/ 链接里的是 wiki 节点 token，不是 app_token。"
        )
    if not table_id:
        return tool_error("缺少 table_id（数据表 id，形如 tblxxxx）。请在多维表格链接里带上 ?table=tblxxxx，或显式传 table_id。")

    raw_rows: list[dict] = []
    if isinstance(args.get("records"), list) and args.get("records"):
        raw_rows = [row for row in args["records"] if isinstance(row, dict)]
    elif isinstance(args.get("fields"), dict) and args.get("fields"):
        raw_rows = [args["fields"]]
    if not raw_rows:
        return tool_error("请提供 fields（单行 {字段名: 值}）或 records（多行数组）。")

    try:
        client = _build_client(app_id, app_secret)
    except ImportError:
        return tool_error("lark_oapi is not installed in this runtime image")
    except Exception as exc:  # noqa: BLE001 — surface SDK init failure honestly
        return tool_error(f"Failed to initialize Feishu SDK client: {exc}")

    try:
        type_map = _field_type_map(client, app_token, table_id)
        if not type_map:
            return tool_error(_permission_hint(None, "该数据表未返回任何字段，请确认 table_id 正确且应用有访问权限。"))
        prepared: list[dict] = []
        skipped_unknown: list[str] = []
        skipped_typed: list[str] = []
        for row in raw_rows:
            payload, unknown, typed = _build_fields(row, type_map)
            if not payload:
                return tool_error(
                    "没有任何字段可以写入：传入的字段名都不在表格列里，或都无法按列类型写入。"
                    f" 表格现有列：{', '.join(sorted(type_map)) or '（空）'}。"
                )
            prepared.append(payload)
            skipped_unknown.extend(unknown)
            skipped_typed.extend(typed)
        record_ids = _create_records(client, app_token, table_id, prepared)
        return tool_result(
            success=True,
            app_token=app_token,
            table_id=table_id,
            record_ids=record_ids,
            records_written=len(record_ids),
            bitable_url=bitable_url or None,
            skipped_unknown_fields=sorted(set(skipped_unknown)) or None,
            skipped_fields=sorted(set(skipped_typed)) or None,
        )
    except RuntimeError as exc:
        return tool_error(str(exc))
    except Exception as exc:  # noqa: BLE001 — never leak a raw traceback to the model
        return tool_error(f"写入多维表格失败: {exc}")


def register(ctx):
    ctx.register_tool(
        name="feishu_bitable_write",
        toolset="feishu_doc",
        schema=FEISHU_BITABLE_WRITE_SCHEMA,
        handler=_handle_feishu_bitable_write,
        check_fn=_check_feishu_bitable_write,
        requires_env=[],
        description=FEISHU_BITABLE_WRITE_SCHEMA["description"],
        emoji="📊",
    )
