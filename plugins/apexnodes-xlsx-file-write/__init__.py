"""ApexNodes structured Excel workbook export tool (hc-326)."""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any

from tools.registry import tool_error, tool_result

XLSX_FILE_WRITE_SCHEMA = {
    "name": "xlsx_file_write",
    "description": (
        "Render structured workbook data to a .xlsx file and return its local "
        "path. After calling this, put `MEDIA:<file_path>` on a separate line "
        "in your reply so the file is sent to the user. Input supports multiple "
        "sheets, header columns, rows as arrays or objects, and optional column widths."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "sheets": {
                "type": "array",
                "description": (
                    "Workbook sheets. Each item: {name, columns, rows}. columns may "
                    "be strings or {key, header, width}; rows may be arrays or objects."
                ),
            },
            "title": {
                "type": "string",
                "description": "Workbook title / file name (defaults to Agent workbook).",
            },
        },
        "required": ["sheets"],
    },
}


def _check_xlsx_file_write() -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec("xlsxwriter") is not None
    except (ImportError, ValueError):
        return False


def _document_cache_dir() -> Path:
    home: str | None = None
    try:
        from hermes_constants import get_hermes_home

        home = str(get_hermes_home())
    except Exception:  # noqa: BLE001
        home = os.getenv("HERMES_HOME") or str(Path.home() / ".hermes")
    cache_dir = Path(home) / "cache" / "documents"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _safe_filename(title: str) -> str:
    base = re.sub(r"[\\/\x00-\x1f]", " ", title or "").strip()
    base = re.sub(r"\s+", " ", base) or "Agent workbook"
    return base[:60]


def _safe_sheet_name(name: Any, index: int) -> str:
    base = re.sub(r"[\[\]:*?/\\]", " ", str(name or "").strip())
    base = re.sub(r"\s+", " ", base).strip("' ") or f"Sheet {index + 1}"
    return base[:31]


def _normalise_columns(rows: list[Any], columns: Any) -> list[dict[str, Any]]:
    normalised: list[dict[str, Any]] = []
    if isinstance(columns, list):
        for column in columns:
            if isinstance(column, dict):
                key = str(column.get("key") or column.get("header") or "").strip()
                header = str(column.get("header") or key).strip()
                width = column.get("width")
            else:
                key = str(column).strip()
                header = key
                width = None
            if key or header:
                normalised.append({"key": key or header, "header": header or key, "width": width})

    if normalised:
        return normalised

    keys: list[str] = []
    for row in rows:
        if isinstance(row, dict):
            for key in row:
                text = str(key)
                if text not in keys:
                    keys.append(text)
    if keys:
        return [{"key": key, "header": key, "width": None} for key in keys]

    max_len = max((len(row) for row in rows if isinstance(row, list | tuple)), default=0)
    return [{"key": str(i), "header": f"Column {i + 1}", "width": None} for i in range(max_len)]


def _cell_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, str | int | float | bool):
        return value
    return str(value)


def render_workbook_to_xlsx(sheets: list[dict[str, Any]], title: str, dest: Path) -> Path:
    import xlsxwriter

    workbook = xlsxwriter.Workbook(str(dest))
    header_format = workbook.add_format({"bold": True, "bg_color": "#EAF2F8", "border": 1})
    text_format = workbook.add_format({"text_wrap": True, "valign": "top"})
    used_names: set[str] = set()

    try:
        for sheet_index, raw_sheet in enumerate(sheets):
            if not isinstance(raw_sheet, dict):
                raise ValueError("each sheet must be an object")
            rows = raw_sheet.get("rows") or []
            if not isinstance(rows, list):
                raise ValueError("sheet rows must be a list")
            columns = _normalise_columns(rows, raw_sheet.get("columns"))
            if not columns:
                columns = [{"key": "value", "header": "Value", "width": None}]

            sheet_name = _safe_sheet_name(raw_sheet.get("name"), sheet_index)
            original = sheet_name
            suffix = 2
            while sheet_name.lower() in used_names:
                marker = f" {suffix}"
                sheet_name = f"{original[:31 - len(marker)]}{marker}"
                suffix += 1
            used_names.add(sheet_name.lower())

            worksheet = workbook.add_worksheet(sheet_name)
            worksheet.freeze_panes(1, 0)
            for column_index, column in enumerate(columns):
                worksheet.write(0, column_index, column["header"], header_format)
                width = column.get("width")
                if isinstance(width, int | float) and width > 0:
                    worksheet.set_column(column_index, column_index, min(float(width), 80), text_format)
                else:
                    worksheet.set_column(column_index, column_index, min(max(len(str(column["header"])) + 4, 12), 36), text_format)

            for row_index, row in enumerate(rows, start=1):
                for column_index, column in enumerate(columns):
                    if isinstance(row, dict):
                        value = row.get(column["key"], "")
                    elif isinstance(row, list | tuple):
                        try:
                            value = row[column_index]
                        except IndexError:
                            value = ""
                    else:
                        value = row if column_index == 0 else ""
                    worksheet.write(row_index, column_index, _cell_value(value), text_format)

            if rows:
                worksheet.autofilter(0, 0, len(rows), len(columns) - 1)
        workbook.set_properties({"title": title[:120]})
    finally:
        workbook.close()
    return dest


def _handle_xlsx_file_write(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("xlsx_file_write expects a JSON object argument")

    sheets = args.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        return tool_error("sheets must be a non-empty list")

    title = str(args.get("title") or "Agent workbook").strip() or "Agent workbook"
    try:
        cache_dir = _document_cache_dir()
        dest = cache_dir / f"{_safe_filename(title)}_{uuid.uuid4().hex[:8]}.xlsx"
        render_workbook_to_xlsx(sheets, title, dest)
    except ImportError:
        return tool_error("XlsxWriter is not installed in this runtime image")
    except Exception as exc:  # noqa: BLE001
        return tool_error(f"Failed to render the Excel file: {exc}")

    path = str(dest)
    return tool_result(
        success=True,
        file_path=path,
        media_tag=f"MEDIA:{path}",
        instruction="在回复里单独一行输出 media_tag 的值即可把 Excel 文件发给用户;另附不超过五行的核心摘要。",
    )


def register(ctx):
    ctx.register_tool(
        name="xlsx_file_write",
        toolset="doc_delivery",
        schema=XLSX_FILE_WRITE_SCHEMA,
        handler=_handle_xlsx_file_write,
        check_fn=_check_xlsx_file_write,
        requires_env=[],
        description=XLSX_FILE_WRITE_SCHEMA["description"],
        emoji="📊",
    )
