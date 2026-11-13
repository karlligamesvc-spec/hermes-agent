"""hc-1219 Finding 剪映专业版 and reading its plaintext list of drafts (apex_overlay/jianying_install.py)."""

from __future__ import annotations

import json
import plistlib
from pathlib import Path

import pytest

from apex_overlay import jianying_install as install


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # The line as 剪映 11.7.0 writes it on macOS (measured 2026-11-11).
        ("[General]\ncacheDate=30\ncurrentCustomDraftPath=/Users/u/Movies/JianyingPro/User Data/Projects/"
         "com.lveditor.draft\ncustomMaterialPath=/x\n",
         "/Users/u/Movies/JianyingPro/User Data/Projects/com.lveditor.draft"),
        # The line as 剪映 11.7.0.14652 writes it on Windows (measured 2026-11-12): backslashes doubled.
        ("currentCustomDraftPath=C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\JianyingPro\\\\User Data\\\\Projects\\\\"
         "com.lveditor.draft\n",
         "C:\\Users\\u\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft"),
        # Qt quotes a value it cannot write bare, and escapes characters outside ASCII as \xHHHH.
        ('currentCustomDraftPath="D:/\\x526a\\x6620/\\x8349\\x7a3f"\n', "D:/剪映/草稿"),
        ("currentCustomDraftPath=C:\\\\Users\\\\u\\\\drafts\n", "C:\\Users\\u\\drafts"),
        ("  currentCustomDraftPath = /spaced/around \n", "/spaced/around"),
        ("currentCachePath=/c\n", None),
        ("currentCustomDraftPath=\n", None),
        ("", None),
    ],
)
def test_the_draft_folder_is_read_from_globalsetting(text, expected):
    assert install.draft_root_from_setting(text) == expected


def _mac_app(folder: Path, bundle_id: str = install.BUNDLE_ID, version: str = "11.7.0") -> None:
    plist = folder / install.MAC_APP_NAME / "Contents" / "Info.plist"
    plist.parent.mkdir(parents=True)
    plist.write_bytes(plistlib.dumps({"CFBundleIdentifier": bundle_id, "CFBundleShortVersionString": version}))


def _setting(user_data: Path, draft_root: str) -> None:
    config = user_data / "Config"
    config.mkdir(parents=True)
    (config / "globalSetting").write_text(f"[General]\ncurrentCustomDraftPath={draft_root}\n", encoding="utf-8")


def test_mac_finds_the_app_its_version_and_the_chosen_draft_folder(tmp_path):
    apps = tmp_path / "Applications"
    _mac_app(apps)
    chosen = tmp_path / "elsewhere" / "drafts"
    chosen.mkdir(parents=True)
    _setting(tmp_path / "Movies" / "JianyingPro" / "User Data", str(chosen))

    found = install.find(platform="darwin", home=tmp_path, app_folders=(apps,))

    assert found is not None
    assert (found.app, found.version, found.draft_root) == (apps / install.MAC_APP_NAME, "11.7.0", chosen)


def test_mac_falls_back_to_the_default_draft_folder_and_is_none_before_the_first_start(tmp_path):
    apps = tmp_path / "Applications"
    _mac_app(apps)
    user_data = tmp_path / "Movies" / "JianyingPro" / "User Data"
    _setting(user_data, str(tmp_path / "gone"))

    assert install.find(platform="darwin", home=tmp_path, app_folders=(apps,)).draft_root is None

    (user_data / install.DEFAULT_DRAFTS).mkdir(parents=True)
    assert install.find(platform="darwin", home=tmp_path, app_folders=(apps,)).draft_root == (
        user_data / install.DEFAULT_DRAFTS)


@pytest.mark.parametrize("bundle_id", ["com.lemon.lvoverseas", "com.example.other"])
def test_mac_another_bundle_under_the_same_name_is_not_jianying(tmp_path, bundle_id):
    apps = tmp_path / "Applications"
    _mac_app(apps, bundle_id=bundle_id)
    assert install.find(platform="darwin", home=tmp_path, app_folders=(apps,)) is None


def test_windows_reads_the_newest_version_folder_numerically(tmp_path):
    jianying = tmp_path / "JianyingPro"
    apps = jianying / "Apps"
    for name in ("5.9.0.11632", "10.2.0.1234", "9.8.0.1", "notes"):
        (apps / name).mkdir(parents=True)
    (apps / install.WINDOWS_EXE).write_bytes(b"")
    drafts = jianying / "User Data" / install.DEFAULT_DRAFTS
    drafts.mkdir(parents=True)

    found = install.find(env={"LOCALAPPDATA": str(tmp_path)}, platform="win32", home=tmp_path)

    assert found is not None
    assert (found.app, found.version, found.draft_root) == (apps / install.WINDOWS_EXE, "10.2.0.1234", drafts)


def test_windows_without_the_launcher_is_not_installed(tmp_path):
    (tmp_path / "JianyingPro" / "Apps" / "10.2.0.1234").mkdir(parents=True)
    assert install.find(env={"LOCALAPPDATA": str(tmp_path)}, platform="win32", home=tmp_path) is None


def test_other_platforms_have_no_jianying(tmp_path):
    assert install.find(env={}, platform="linux", home=tmp_path) is None


def _root_meta(root: Path, entries: list) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / install.ROOT_META).write_text(json.dumps({"all_draft_store": entries, "root_path": str(root)}),
                                          encoding="utf-8")


def test_registration_judges_the_entry_for_that_folder(tmp_path):
    root = tmp_path / "drafts"
    good, stale, empty = root / "好", root / "旧", root / "空"
    for folder in (good, empty):
        folder.mkdir(parents=True)
        (folder / "draft_info.json").write_text("{}", encoding="utf-8")
    _root_meta(root, [
        {"draft_fold_path": str(good), "draft_json_file": str(good / "draft_info.json"), "tm_duration": 14_000_000},
        {"draft_fold_path": str(stale), "draft_json_file": str(stale / "draft_info.json"), "tm_duration": 9},
        {"draft_fold_path": str(empty) + "/", "draft_json_file": str(empty / "draft_info.json"), "tm_duration": 0},
        "not an entry",
    ])

    assert install.registration(good) == {"timeline_exists": True, "duration_us": 14_000_000}
    assert install.registration(stale) == {"timeline_exists": False, "duration_us": 9}
    assert install.registration(empty) == {"timeline_exists": True, "duration_us": 0}
    assert install.registration(root / "never") is None
    assert install.listed_names(root) == {"好", "旧", "空"}


@pytest.mark.parametrize("content", ["", "not json", "[]", '{"all_draft_store": 3}'])
def test_an_unreadable_list_means_no_entry(tmp_path, content):
    (tmp_path / install.ROOT_META).write_text(content, encoding="utf-8")
    assert install.registration(tmp_path / "x") is None
    assert install.listed_names(tmp_path) == set()
