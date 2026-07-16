"""Runtime image contract tests for Hermes Cloud cold-start bundles."""

from pathlib import Path


def _dockerfile_text() -> str:
    return (Path(__file__).parents[2] / "Dockerfile").read_text(encoding="utf-8")


def test_runtime_image_keeps_plugin_tools_gateway_label() -> None:
    df = _dockerfile_text()

    assert 'LABEL hermes.plugin-tools-gateway="true"' in df


def test_runtime_image_bakes_feishu_and_edge_tts_extras() -> None:
    df = _dockerfile_text()

    assert "--extra feishu" in df
    assert "--extra edge-tts" in df


def test_runtime_image_bakes_tirith_binary() -> None:
    df = _dockerfile_text()

    assert "tirith baked into image" in df
    # hc-180 regression guard: the bake installer must run against a
    # throwaway scratch home, never the install tree.  ensure_installed →
    # load_config chmods $HERMES_HOME to 0700, and since upstream dropped
    # the trailing `chmod -R a+rX` repair pass (#49113) those root-only
    # modes would be baked into the image layer — every container then
    # aborts in cont-init with `Permission denied` on /opt/hermes.  Only
    # the verified binary is promoted onto the runtime PATH.
    assert "HERMES_HOME=/opt/hermes" not in df
    assert "HERMES_HOME=/tmp/tirith-bake" in df
    assert "install -m 0755 /tmp/tirith-bake/bin/tirith /opt/hermes/bin/tirith" in df
