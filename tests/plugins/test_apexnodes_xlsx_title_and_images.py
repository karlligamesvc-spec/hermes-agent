"""hc-1212: xlsx_file_write 的表名行和图片单元格(Desktop 用的这份插件)。

分镜脚本表要像代运营团队的原表：第 1 行是跨全部列合并、加粗放大的表名，表头在第 2 行，素材列
每一行放这一镜的关键帧。云端那份在 apex-nodes ``app/runtime_plugins/apexnodes-xlsx-file-write``,
和这份只差 ``# noqa`` 注释;apex-nodes 的 ``tests/test_hc1212_xlsx_title_and_images.py`` 用 openpyxl
读回两份的成品，并核对两份源码一致。fork 的测试环境没有 openpyxl,这里直接读 xlsx 里的 XML
(单元格、合并、冻结、筛选、行高、图片锚点和图片字节),和表格软件读的是同一份东西。

- 表名行(``sheets[].title``):合并 A1 到最后一列，表头下移一行，冻结和筛选跟着下移;只有一列不合并。
- 图片单元格(``{"image": 路径}``):相对路径从工作目录(``agent.runtime_cwd.resolve_agent_cwd``)算起;
  图片缩放后整张落在自己那一格，保持比例，行高加大;网址、工作目录外(含 ``..`` 和软链接)、不存在、
  不是图片都拒绝，报错写明哪一格，并且不写文件。
- 旧调用(没有表名、没有图片)版式不变。
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
import warnings
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

import pytest
from PIL import Image

pytest.importorskip("xlsxwriter")  # ships with the Desktop ([file-export]); CI installs it through [all]

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO_ROOT / "plugins" / "apexnodes-xlsx-file-write"
MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = {
    "m": MAIN,
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
R_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
R_EMBED = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed"
COLUMNS = [
    {"key": "镜头编号", "header": "镜头编号", "width": 9},
    {"key": "时长", "header": "时长", "width": 8},
    {"key": "文案", "header": "文案（台词）", "width": 45},
    {"key": "素材", "header": "素材（图片/视频）", "width": 16},
]
# Excel's pixel width of the 16-character 素材 column (Calibri 11: 7 px a character, plus 5).
MATERIAL_COLUMN_PX = 117
EMU_PER_PX = 9525


@pytest.fixture
def xlsx(tmp_path, monkeypatch):
    module_name = "hermes_plugins.apexnodes_xlsx_file_write"
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "hermes_plugins", namespace)
    spec = importlib.util.spec_from_file_location(
        module_name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)
    cache = tmp_path / "cache" / "documents"
    cache.mkdir(parents=True)
    monkeypatch.setattr(module, "_document_cache_dir", lambda: cache)
    module.test_cache = cache
    return module


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    """The tool's working directory, set the way the runtime sets it (TERMINAL_CWD)."""
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setenv("TERMINAL_CWD", str(work))
    return work


def _picture(path: Path, size: tuple[int, int], color: tuple[int, int, int]) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)
    return path.read_bytes()


def _shot_table(material: list) -> dict:
    rows = [{"镜头编号": n, "时长": "2s", "文案": f"第{n}句", "素材": value} for n, value in enumerate(material, 1)]
    return {"name": "拆解视频脚本", "title": "拆解视频脚本：《样片》", "columns": COLUMNS, "rows": rows}


def _part(book: zipfile.ZipFile, base: str, target: str) -> str:
    """A relationship target, resolved against the part that points at it."""
    parts: list[str] = []
    for piece in (PurePosixPath(base).parent / target).parts:
        if piece == "..":
            parts.pop()
        else:
            parts.append(piece)
    return "/".join(parts)


def _rels(book: zipfile.ZipFile, part: str) -> dict[str, str]:
    path = PurePosixPath(part)
    rels = ET.fromstring(book.read(str(path.parent / "_rels" / f"{path.name}.rels")))
    return {rel.get("Id"): _part(book, part, rel.get("Target")) for rel in rels.findall("rel:Relationship", NS)}


def _read(path: Path, sheet_number: int = 1) -> dict:
    """What a spreadsheet program shows for one sheet: cells, fonts, merges, frozen rows, filter, row heights, pictures."""
    with zipfile.ZipFile(path) as book:
        names = book.namelist()
        strings = []
        if "xl/sharedStrings.xml" in names:
            for item in ET.fromstring(book.read("xl/sharedStrings.xml")).findall("m:si", NS):
                strings.append("".join(text.text or "" for text in item.iter(f"{{{MAIN}}}t")))
        styles = ET.fromstring(book.read("xl/styles.xml"))
        fonts = styles.find("m:fonts", NS).findall("m:font", NS)
        formats = styles.find("m:cellXfs", NS).findall("m:xf", NS)
        sheet_part = f"xl/worksheets/sheet{sheet_number}.xml"
        sheet = ET.fromstring(book.read(sheet_part))
        cells, bold, size = {}, {}, {}
        for cell in sheet.iter(f"{{{MAIN}}}c"):
            font = fonts[int(formats[int(cell.get("s", "0"))].get("fontId", "0"))]
            bold[cell.get("r")] = font.find("m:b", NS) is not None
            size[cell.get("r")] = float(font.find("m:sz", NS).get("val"))
            value = cell.find("m:v", NS)
            if value is not None:
                cells[cell.get("r")] = strings[int(value.text)] if cell.get("t") == "s" else value.text
        pane = sheet.find(".//m:pane", NS)
        auto_filter = sheet.find("m:autoFilter", NS)
        pictures = []
        drawing = sheet.find("m:drawing", NS)
        if drawing is not None:
            drawing_part = _rels(book, sheet_part)[drawing.get(R_ID)]
            media = _rels(book, drawing_part)
            for anchor in ET.fromstring(book.read(drawing_part)).findall("xdr:twoCellAnchor", NS):
                start, end = anchor.find("xdr:from", NS), anchor.find("xdr:to", NS)

                def at(marker, tag):
                    return int(marker.find(f"xdr:{tag}", NS).text)

                blip = anchor.find(".//a:blip", NS)
                pictures.append({
                    "cell": (at(start, "row"), at(start, "col")), "ends_in": (at(end, "row"), at(end, "col")),
                    "left": at(start, "colOff"), "right": at(end, "colOff"),
                    "top": at(start, "rowOff"), "bottom": at(end, "rowOff"),
                    "bytes": book.read(media[blip.get(R_EMBED)]),
                })
        return {
            "cells": cells,
            "bold": bold,
            "size": size,
            "merges": [merge.get("ref") for merge in sheet.iter(f"{{{MAIN}}}mergeCell")],
            "frozen_at": pane.get("topLeftCell") if pane is not None else None,
            "filter": auto_filter.get("ref") if auto_filter is not None else None,
            "row_heights": {int(row.get("r")): float(row.get("ht")) for row in sheet.iter(f"{{{MAIN}}}row") if row.get("ht")},
            "pictures": sorted(pictures, key=lambda item: item["cell"]),
        }


# ── 表名行 ──────────────────────────────────────────────────────────────────────


def test_title_row_is_merged_above_the_header(xlsx, tmp_path):
    dest = tmp_path / "shots.xlsx"
    xlsx.render_workbook_to_xlsx([_shot_table(["实拍视频", "截图"])], "拆解视频脚本", dest)

    sheet = _read(dest)
    assert sheet["merges"] == ["A1:D1"]
    assert sheet["cells"]["A1"] == "拆解视频脚本：《样片》"
    assert sheet["bold"]["A1"] is True and sheet["size"]["A1"] > sheet["size"]["A2"]
    assert sheet["row_heights"][1] > 30
    assert [sheet["cells"][ref] for ref in ("A2", "B2", "C2", "D2")] == ["镜头编号", "时长", "文案（台词）", "素材（图片/视频）"]
    assert [sheet["cells"][ref] for ref in ("A3", "B3", "C3", "D3")] == ["1", "2s", "第1句", "实拍视频"]
    assert sheet["frozen_at"] == "A3"
    assert sheet["filter"] == "A2:D4"


def test_title_with_one_column_is_written_without_a_merge(xlsx, tmp_path):
    dest = tmp_path / "one.xlsx"
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        xlsx.render_workbook_to_xlsx([{"title": "  选题\n清单 ", "columns": ["选题"], "rows": [["A"], ["B"]]}], "x", dest)

    assert [str(item.message) for item in caught] == []
    sheet = _read(dest)
    assert sheet["merges"] == []
    assert sheet["cells"]["A1"] == "选题 清单"
    assert [sheet["cells"]["A2"], sheet["cells"]["A3"]] == ["选题", "A"]
    assert (sheet["frozen_at"], sheet["filter"]) == ("A3", "A2:A4")


# ── 图片单元格 ──────────────────────────────────────────────────────────────────


def test_each_picture_sits_inside_its_own_cell(xlsx, tmp_path, workdir):
    tall = _picture(workdir / "复刻包-样片" / "frames" / "001-b.jpg", (405, 720), (200, 40, 40))
    wide = _picture(workdir / "复刻包-样片" / "frames" / "002-b.png", (720, 405), (40, 40, 200))
    material = [{"image": "复刻包-样片/frames/001-b.jpg"}, {"image": str(workdir / "复刻包-样片/frames/002-b.png")}, "截图"]

    result = json.loads(xlsx._handle_xlsx_file_write({"title": "拆解", "sheets": [_shot_table(material)]}))

    assert result.get("success") is True, result
    sheet = _read(Path(result["file_path"]))
    pictures = sheet["pictures"]
    # Rows 3 and 4 (0-based 2 and 3) hold the pictures, in the 素材 column (D, 0-based 3).
    assert [(item["cell"], item["ends_in"], item["bytes"]) for item in pictures] == [
        ((2, 3), (2, 3), tall),
        ((3, 3), (3, 3), wide),
    ]
    assert "D3" not in sheet["cells"] and sheet["cells"]["D5"] == "截图"
    assert sheet["row_heights"][3] == sheet["row_heights"][4] > 60
    assert 5 not in sheet["row_heights"]  # a row without a picture keeps the default height
    image_row_px = sheet["row_heights"][3] * 4 / 3
    for item, (width, height) in zip(pictures, ((405, 720), (720, 405)), strict=True):
        shown_w = (item["right"] - item["left"]) / EMU_PER_PX
        shown_h = (item["bottom"] - item["top"]) / EMU_PER_PX
        assert item["right"] <= MATERIAL_COLUMN_PX * EMU_PER_PX and item["bottom"] <= image_row_px * EMU_PER_PX
        assert shown_w / shown_h == pytest.approx(width / height, rel=0.01)
        assert max(shown_w / MATERIAL_COLUMN_PX, shown_h / image_row_px) > 0.9
        assert item["left"] / EMU_PER_PX == pytest.approx(MATERIAL_COLUMN_PX - item["right"] / EMU_PER_PX, abs=1)


def test_array_rows_take_pictures_too(xlsx, tmp_path, workdir):
    frame = _picture(workdir / "a.png", (300, 300), (10, 120, 10))
    dest = tmp_path / "grid.xlsx"
    xlsx.render_workbook_to_xlsx([{"columns": ["名称", "图"], "rows": [["绿", {"image": "a.png"}], ["空"]]}], "x", dest)

    sheet = _read(dest)
    assert [(item["cell"], item["ends_in"], item["bytes"]) for item in sheet["pictures"]] == [((1, 1), (1, 1), frame)]
    assert [sheet["cells"]["A2"], sheet["cells"]["A3"]] == ["绿", "空"]


def test_without_the_runtime_resolver_terminal_cwd_is_the_working_directory(xlsx, workdir, monkeypatch):
    frame = _picture(workdir / "frames" / "001-b.jpg", (405, 720), (200, 40, 40))
    monkeypatch.setitem(sys.modules, "agent.runtime_cwd", None)  # an older runtime without the module

    result = json.loads(xlsx._handle_xlsx_file_write({"sheets": [_shot_table([{"image": "frames/001-b.jpg"}])]}))

    assert result.get("success") is True, result
    assert [item["bytes"] for item in _read(Path(result["file_path"]))["pictures"]] == [frame]


def test_a_session_working_directory_comes_before_terminal_cwd(xlsx, tmp_path, workdir):
    from agent.runtime_cwd import reset_session_cwd, set_session_cwd

    session = tmp_path / "session-work"
    frame = _picture(session / "frames" / "001-b.jpg", (405, 720), (200, 40, 40))
    _picture(workdir / "frames" / "001-b.jpg", (405, 720), (0, 0, 0))
    token = set_session_cwd(str(session))
    try:
        result = json.loads(xlsx._handle_xlsx_file_write({"sheets": [_shot_table([{"image": "frames/001-b.jpg"}])]}))
    finally:
        reset_session_cwd(token)

    assert result.get("success") is True, result
    assert [item["bytes"] for item in _read(Path(result["file_path"]))["pictures"]] == [frame]


def _refused_cell(case: str, work: Path, outside: Path):
    if case == "symlink":
        (work / "link-out.png").symlink_to(outside / "secret.png")
        return {"image": "link-out.png"}
    return {
        "https": {"image": "https://example.com/frame.png"},
        "data-url": {"image": "data:image/png;base64,iVBORw0KGgo="},
        "dot-dot": {"image": "../outside/secret.png"},
        "absolute-outside": {"image": str(outside / "secret.png")},
        "missing": {"image": "frames/none.jpg"},
        "not-a-picture": {"image": "notes.png"},
        "webp": {"image": "frame.webp"},
        "empty-file": {"image": "empty.png"},
        "zero-size-emf": {"image": "flat.emf"},
        "empty": {"image": ""},
    }[case]


def _unusable_files(work: Path) -> None:
    """Files with picture names that XlsxWriter cannot place, one per way its probe fails."""
    (work / "notes.png").write_text("这不是图片，只是名字像" * 20, encoding="utf-8")  # unknown format
    Image.new("RGB", (40, 30)).save(work / "frame.webp")  # a real picture, in a format Excel cells do not take
    (work / "empty.png").write_bytes(b"")  # too short to read a header from
    # An EMF header whose frame is 0 x 0: the probe divides by the frame size.
    (work / "flat.emf").write_bytes((1).to_bytes(4, "little") + (108).to_bytes(4, "little") + bytes(32) + b" EMF" + bytes(64))


@pytest.mark.parametrize(
    ("case", "reason"),
    [
        ("https", "网址"),
        ("data-url", "网址"),
        ("dot-dot", "不在工作目录"),
        ("absolute-outside", "不在工作目录"),
        ("symlink", "不在工作目录"),
        ("missing", "不存在"),
        ("not-a-picture", "不是表格能放的图片"),
        ("webp", "不是表格能放的图片"),
        ("empty-file", "不是表格能放的图片"),
        ("zero-size-emf", "不是表格能放的图片"),
        ("empty", "文件路径"),
    ],
)
def test_a_refused_picture_names_its_cell_and_writes_nothing(xlsx, tmp_path, workdir, case, reason):
    outside = tmp_path / "outside"
    _picture(workdir / "frames" / "ok.png", (100, 100), (1, 2, 3))
    _picture(outside / "secret.png", (100, 100), (4, 5, 6))
    _unusable_files(workdir)
    material = [{"image": "frames/ok.png"}, _refused_cell(case, workdir, outside)]

    result = json.loads(xlsx._handle_xlsx_file_write({"sheets": [_shot_table(material)]}))

    assert "success" not in result, result
    assert result["error"].startswith("表格没生成"), result
    assert "sheets[0].rows[1] 的「素材（图片/视频）」列" in result["error"]
    assert reason in result["error"]
    assert list(xlsx.test_cache.iterdir()) == []


# ── 旧调用 ──────────────────────────────────────────────────────────────────────


def test_a_call_without_title_or_pictures_keeps_the_old_layout(xlsx, tmp_path):
    sheets = [
        {
            "name": "月度销售",
            "columns": [{"key": "sku", "header": "SKU", "width": 16}, {"key": "name", "header": "商品"}, "amount"],
            "rows": [{"sku": "A-001", "name": "便携榨汁杯", "amount": 12800}, {"sku": "B-002", "name": "折叠水杯", "amount": 8600}],
        },
        {"name": "月度销售", "rows": [["a", 1, {"note": "不是图片的对象照旧写成文字"}]]},
    ]
    dest = tmp_path / "old.xlsx"
    xlsx.render_workbook_to_xlsx(sheets, "销售清单", dest)

    first, second = _read(dest, 1), _read(dest, 2)
    for sheet in (first, second):
        assert sheet["merges"] == [] and sheet["pictures"] == [] and sheet["row_heights"] == {}
        assert sheet["frozen_at"] == "A2"
    assert [first["cells"][ref] for ref in ("A1", "B1", "C1", "A2", "C2")] == ["SKU", "商品", "amount", "A-001", "12800"]
    assert first["filter"] == "A1:C3"
    assert second["cells"]["C2"] == "{'note': '不是图片的对象照旧写成文字'}"


def test_a_malformed_sheet_still_says_what_it_said_and_writes_nothing(xlsx):
    result = json.loads(xlsx._handle_xlsx_file_write({"sheets": [{"rows": [["a"]]}, "not a sheet"]}))
    assert result == {"error": "Failed to render the Excel file: each sheet must be an object"}
    assert list(xlsx.test_cache.iterdir()) == []
