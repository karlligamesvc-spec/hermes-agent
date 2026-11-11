# apex_overlay/vendor

Third-party Python code that APEX Desktop's engine ships in source form, pinned and patched. Each package keeps its
upstream license and a `NOTICE`; `<package>.SOURCE.json` records where it came from, every change, and the sha256 of
each file left as upstream wrote it. `tests/apex_overlay/test_vendor_sources.py` fails when a vendored file differs
from that record, so a change here is always a deliberate one.

## pyJianYingDraft 0.3.1 (hc-1219)

Writes 剪映专业版 (JianyingPro) drafts for `apex_overlay/jianying_build.py`. Apache-2.0, Copyright 2024 Gary Guan,
https://github.com/GuanYixuan/pyJianYingDraft.

Kept in source form instead of a PyPI dependency because the wheel's dependencies are what APEX does not want on
Desktop: `pymediainfo` (a 7 MB native libmediainfo on macOS, 3.3 MB on Windows), `imageio` (pulls numpy, used only for
GIF input) and, on Windows, `uiautomation`, imported at package import to drive 剪映's export window. APEX hands the
export to the user, so none of that is needed.

Changes from tag `0.3.1` (commit `1e228479`), each marked in the file:

| File | Change | Why |
|---|---|---|
| `draft_folder.py` | upstream PR #198: the timeline file is `draft_info.json` | 剪映 6.0+ reads only that name; with `draft_content.json` the draft shows 0B / 00:00 and opens to nothing, with no message (measured on 11.7.0) |
| `script_file.py` | upstream PR #198: `save(inline_materials=True)` copies media into `materials/` | 剪映 cannot read Desktop/Documents/Downloads on macOS; media inside the draft also moves with it |
| `local_materials.py` + `_apex_probe.py` | duration and size from ffprobe (bundled with Desktop) | no libmediainfo |
| `__init__.py`, `jianying_controller.py` removed | no Windows UI automation | the user exports in 剪映 themselves |
| `metadata/filter_meta.py`, `metadata/video_scene_effect.py` | empty tables | APEX drafts use local media and the free 叠化 transition only; the full tables (2 799 and 8 191 lines) are over the repository's file-size limits |

**Back to upstream:** when PR #198 is in a release, take that release, drop the two PR #198 rows above, keep or drop
the others, and refresh `pyJianYingDraft.SOURCE.json`.
