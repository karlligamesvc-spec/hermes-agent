"""ApexNodes CN mirror seam on v0.22's package manager (hc-911).

v0.22 moved every pinned binary (uv, Python, Node, tools) behind ``pm.artifact_mirror.
pinned_source``. In CN mode the mainland COS copy of the same content-addressed object
must be tried first, with the original URL and the public mirror as fallbacks, and the
pinned sha256 must never change. Outside CN mode upstream behaviour must be untouched.
The bash bootstrap (scripts/install.sh ensure_uv, which runs before pm exists) applies
the same rule to the pinned uv.
"""

from __future__ import annotations

from pathlib import Path
import subprocess

import pytest

from pm import artifact_mirror

SHA = "a" * 64
URL = "https://github.com/astral-sh/uv/releases/download/0.12.3/uv-aarch64-apple-darwin.tar.gz"
COS = "https://apex-runtime.cos.ap-shanghai.myqcloud.com/runtime"
REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def clean_env(monkeypatch):
    for key in ("HERMES_CN_MIRRORS", "HERMES_RUNTIME_COS_BASE", "npm_config_registry", "NPM_CONFIG_REGISTRY"):
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


def test_outside_cn_mode_upstream_order_is_unchanged(clean_env, tmp_path):
    clean_env.setenv("HERMES_RUNTIME_COS_BASE", COS)  # COS alone is not CN mode
    source = artifact_mirror.pinned_source(URL, tmp_path / "uv.tar.gz", SHA)
    assert source.url == URL
    assert source.fallbacks == (artifact_mirror.mirror_url(SHA),)
    assert source.sha256 == SHA


def test_cn_mode_tries_cos_copy_first_with_the_same_digest(clean_env, tmp_path):
    clean_env.setenv("HERMES_CN_MIRRORS", "1")
    clean_env.setenv("HERMES_RUNTIME_COS_BASE", COS + "/")
    source = artifact_mirror.pinned_source(URL, tmp_path / "uv.tar.gz", SHA)
    assert source.url == f"{COS}/upstream/sha256/{SHA}"
    assert source.fallbacks == (URL, artifact_mirror.mirror_url(SHA))
    assert source.sha256 == SHA


@pytest.mark.parametrize("base", ["", "http://insecure.example/runtime", "  "])
def test_cn_mode_without_an_https_cos_base_keeps_upstream(clean_env, tmp_path, base):
    clean_env.setenv("HERMES_CN_MIRRORS", "1")
    clean_env.setenv("HERMES_RUNTIME_COS_BASE", base)
    source = artifact_mirror.pinned_source(URL, tmp_path / "uv.tar.gz", SHA)
    assert source.url == URL


def _bootstrap_uv_urls(env: dict[str, str]) -> tuple[str, str]:
    """Run install.sh's real pin + seam code for this host and report the two URLs."""
    script = f"""
set -u
source "{REPO}/scripts/install.sh" --manifest >/dev/null 2>&1 || true
source "{REPO}/scripts/lib/apexnodes-region-detect.sh"
target="$(uv_bootstrap_target)" && uv_bootstrap_pin "$target"
# The exact seam block from ensure_uv, extracted so no download runs:
eval "$(awk '/ApexNodes overlay seam: in CN mode fetch the COS copy/,/^    fi$/' "{REPO}/scripts/install.sh")"
printf '%s\\n%s\\n%s\\n' "$UV_PIN_URL" "${{UV_PIN_MIRROR:-}}" "$UV_PIN_SHA256"
"""
    out = subprocess.run(["bash", "-c", script], env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", **env},
                         capture_output=True, text=True, check=True).stdout.splitlines()
    return out[0], out[1], out[2]


def test_install_sh_bootstrap_uv_prefers_cos_only_in_cn_mode():
    plain_url, _, sha = _bootstrap_uv_urls({"HERMES_RUNTIME_COS_BASE": COS})
    assert plain_url.startswith("https://github.com/astral-sh/uv/releases/")
    cn_url, cn_fallback, cn_sha = _bootstrap_uv_urls({"HERMES_CN_MIRRORS": "1", "HERMES_RUNTIME_COS_BASE": COS})
    assert cn_url == f"{COS}/upstream/sha256/{sha}"
    assert cn_fallback == plain_url
    assert cn_sha == sha
