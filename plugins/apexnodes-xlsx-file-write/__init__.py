"""ApexNodes structured Excel workbook export tool (hc-326).

hc-1212: a sheet may carry a ``title`` (one bold row merged across its columns, above the
header), and a cell may hold ``{"image": "<path>"}``, a picture from the tool's working directory
scaled into that cell. A call that uses neither writes the same workbook as before.
"""

from __future__ import annotations

import io
import os
import re
import struct
import uuid
from pathlib import Path
from typing import Any

from tools.registry import tool_error, tool_result

# Row heights are in points, as Excel stores them.
TITLE_ROW_HEIGHT = 48
TITLE_FONT_SIZE = 20
IMAGE_ROW_HEIGHT = 96  # 128 px: a 9:16 keyframe shows about 72 px wide
IMAGE_PADDING = 4  # px kept clear on each side, so a picture never reaches the next cell
# A URL scheme (http:, https:, file:, data:). One letter before the colon is a Windows drive.
_URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]+:")

XLSX_FILE_WRITE_SCHEMA = {
    "name": "xlsx_file_write",
    "description": (
        "Render structured workbook data to a .xlsx file and return its local "
        "path. After calling this, put `MEDIA:<file_path>` on a separate line "
        "in your reply so the file is sent to the user. Input supports multiple "
        "sheets, header columns, rows as arrays or objects, and optional column widths; "
        "a sheet may add a title row, and a cell may hold a local picture."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "sheets": {
                "type": "array",
                "description": (
                    "Workbook sheets. Each item: {name, columns, rows, title}. columns may "
                    "be strings or {key, header, width}; rows may be arrays or objects. "
                    "title is optional: one bold line merged across all columns, above the header row. "
                    'A cell value may be {"image": "<path>"}: a PNG/JPEG/GIF/BMP file inside the working '
                    "directory (a relative path starts there; web links are refused), placed in that cell "
                    "scaled to fit, with its row made taller."
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


class ImageCellError(ValueError):
    """An image cell the tool refuses; the message names the cell and the reason."""


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
    except Exception:
        home = os.getenv("HERMES_HOME") or str(Path.home() / ".hermes")
    cache_dir = Path(home) / "cache" / "documents"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _work_dir() -> Path:
    """The tool's working directory, where video_breakdown leaves its 复刻包 folders."""
    try:
        from agent.runtime_cwd import resolve_agent_cwd
    except ImportError:  # outside the runtime, or an older one
        raw = os.getenv("TERMINAL_CWD", "").strip()
        return Path(raw) if raw and Path(raw).is_dir() else Path.cwd()
    return Path(resolve_agent_cwd())


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


def _row_cells(row: Any, columns: list[dict[str, Any]]) -> list[Any]:
    """What each column shows for one row: by key for an object row, by position for an array row."""
    if isinstance(row, dict):
        return [row.get(column["key"], "") for column in columns]
    if isinstance(row, list | tuple):
        return [row[index] if index < len(row) else "" for index in range(len(columns))]
    return [row, *[""] * (len(columns) - 1)]


def _cell_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, str | int | float | bool):
        return value
    return str(value)


def _load_image(cell: dict, root: Path, where: str) -> dict[str, Any]:
    """Read one image cell's picture. Only a real picture file inside ``root`` is taken."""
    from xlsxwriter.exceptions import XlsxWriterException
    from xlsxwriter.utility import get_image_properties

    text = cell.get("image")
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        raise ImageCellError(f"{where}的 image 要写本机图片的文件路径")
    if _URL_SCHEME.match(text):
        raise ImageCellError(f"{where}的 image 是网址;表格里只能放工作目录里的本机图片，不收网址")
    base = root.resolve()
    path = Path(text).expanduser()
    path = (path if path.is_absolute() else base / path).resolve()
    if not path.is_relative_to(base):
        raise ImageCellError(f"{where}的图片 {text} 不在工作目录 {base} 里;表格里只能放工作目录里的本机图片")
    if not path.is_file():
        raise ImageCellError(f"{where}的图片 {text} 不存在(相对路径从工作目录 {base} 算起)")
    data = path.read_bytes()
    try:
        _kind, width, height, name, x_dpi, y_dpi, _digest = get_image_properties(str(path), io.BytesIO(data))
    except (XlsxWriterException, struct.error, ArithmeticError):
        # What XlsxWriter's probe raises: a format it does not know or no size inside (its own errors),
        # a file cut short (struct), an EMF picture whose frame has no size (division by zero).
        raise ImageCellError(f"{where}的 {text} 不是表格能放的图片(只收 PNG、JPEG、GIF、BMP)") from None
    # Size in screen pixels, the unit XlsxWriter scales from.
    return {"data": data, "name": name, "width": width * 96.0 / x_dpi, "height": height * 96.0 / y_dpi}


def _load_images(
    tables: list[tuple[dict, list, list]], image_root: Path | None
) -> dict[tuple[int, int, int], dict[str, Any]]:
    """Every image cell, checked and read before anything is written; keyed by (sheet, row, column)."""
    images: dict[tuple[int, int, int], dict[str, Any]] = {}
    root = image_root
    for sheet_index, (_raw_sheet, rows, columns) in enumerate(tables):
        for row_index, row in enumerate(rows):
            for column_index, value in enumerate(_row_cells(row, columns)):
                if not (isinstance(value, dict) and "image" in value):
                    continue
                if root is None:
                    root = _work_dir()
                where = f"sheets[{sheet_index}].rows[{row_index}] 的「{columns[column_index]['header']}」列"
                images[sheet_index, row_index, column_index] = _load_image(value, root, where)
    return images


def _fit_in_cell(image: dict[str, Any], column_width: float) -> dict[str, Any]:
    """insert_image options that scale a picture into its cell, keeping its shape, centred."""
    # XlsxWriter's own pixel sizes for a column width in characters and a row height in points.
    cell_width = int(column_width * 12 + 0.5) if column_width < 1 else int(column_width * 7 + 0.5) + 5
    cell_height = int(4.0 / 3.0 * IMAGE_ROW_HEIGHT)
    box_width = max(cell_width - 2 * IMAGE_PADDING, 1)
    box_height = cell_height - 2 * IMAGE_PADDING
    scale = min(box_width / image["width"], box_height / image["height"])
    return {
        "image_data": io.BytesIO(image["data"]),
        "x_scale": scale,
        "y_scale": scale,
        "x_offset": IMAGE_PADDING + (box_width - image["width"] * scale) / 2,
        "y_offset": IMAGE_PADDING + (box_height - image["height"] * scale) / 2,
        "object_position": 1,  # moves and sizes with its cell, so sorting and filtering keep it on its row
    }


def render_workbook_to_xlsx(
    sheets: list[dict[str, Any]], title: str, dest: Path, *, image_root: Path | None = None
) -> Path:
    import xlsxwriter

    tables: list[tuple[dict, list, list]] = []
    for raw_sheet in sheets:
        if not isinstance(raw_sheet, dict):
            raise ValueError("each sheet must be an object")
        rows = raw_sheet.get("rows") or []
        if not isinstance(rows, list):
            raise ValueError("sheet rows must be a list")
        columns = _normalise_columns(rows, raw_sheet.get("columns"))
        tables.append((raw_sheet, rows, columns or [{"key": "value", "header": "Value", "width": None}]))
    images = _load_images(tables, image_root)

    workbook = xlsxwriter.Workbook(str(dest))
    header_format = workbook.add_format({"bold": True, "bg_color": "#EAF2F8", "border": 1})
    text_format = workbook.add_format({"text_wrap": True, "valign": "top"})
    title_format = None
    used_names: set[str] = set()

    try:
        for sheet_index, (raw_sheet, rows, columns) in enumerate(tables):
            sheet_name = _safe_sheet_name(raw_sheet.get("name"), sheet_index)
            original = sheet_name
            suffix = 2
            while sheet_name.lower() in used_names:
                marker = f" {suffix}"
                sheet_name = f"{original[:31 - len(marker)]}{marker}"
                suffix += 1
            used_names.add(sheet_name.lower())

            worksheet = workbook.add_worksheet(sheet_name)
            sheet_title = re.sub(r"\s+", " ", str(raw_sheet.get("title") or "")).strip()
            header_row = 1 if sheet_title else 0
            worksheet.freeze_panes(header_row + 1, 0)
            if sheet_title:
                if title_format is None:
                    title_format = workbook.add_format(
                        {"bold": True, "font_size": TITLE_FONT_SIZE, "align": "center", "valign": "vcenter", "shrink": True}
                    )
                worksheet.set_row(0, TITLE_ROW_HEIGHT)
                if len(columns) > 1:
                    worksheet.merge_range(0, 0, 0, len(columns) - 1, "", title_format)
                worksheet.write_string(0, 0, sheet_title, title_format)

            widths: list[float] = []
            for column_index, column in enumerate(columns):
                worksheet.write(header_row, column_index, column["header"], header_format)
                width = column.get("width")
                if isinstance(width, int | float) and width > 0:
                    width = min(float(width), 80)
                else:
                    width = min(max(len(str(column["header"])) + 4, 12), 36)
                worksheet.set_column(column_index, column_index, width, text_format)
                widths.append(width)

            for row_offset, row in enumerate(rows):
                row_index = header_row + 1 + row_offset
                for column_index, value in enumerate(_row_cells(row, columns)):
                    image = images.get((sheet_index, row_offset, column_index))
                    if image is None:
                        worksheet.write(row_index, column_index, _cell_value(value), text_format)
                        continue
                    worksheet.set_row(row_index, IMAGE_ROW_HEIGHT)
                    worksheet.insert_image(row_index, column_index, image["name"], _fit_in_cell(image, widths[column_index]))

            if rows:
                worksheet.autofilter(header_row, 0, header_row + len(rows), len(columns) - 1)
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
    except ImageCellError as exc:
        return tool_error(f"表格没生成:{exc}")
    except Exception as exc:
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
