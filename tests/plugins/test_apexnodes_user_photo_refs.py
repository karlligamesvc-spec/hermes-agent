"""hc-939: a user's own photo as a reference on the Desktop generate_video / generate_image.

On 2026-10-22 a user attached shop photos in the APEX Desktop composer and asked twice for
them to be the reference. The composer writes an attached photo as ``@image:`<path>```;
the tools only named ``[Image attached at: …]``, and the clip went out text-only while
the reply said it followed "the details in your photo". Pinned here, for the shared
helper in plugins/apexnodes_gateway.py and both Desktop plugins:

* every attachment form names its file and the photo is uploaded;
* a token whose file is gone fails the call naming the path, never a text-only render;
* the platform's ``input_mode`` / ``input_images`` (``text_only`` when no image was used)
  reach the Desktop result, so a reply can be checked against them.

The platform side (the face rule, the late-answer submit) lives in apex-nodes,
tests/test_hc939_user_photo_refs.py.
"""

from __future__ import annotations

import json

import pytest

from tests.plugins.test_apexnodes_input_images import (  # _env / image_mod / video_mod are fixtures
    UPLOADED,
    Gateway,
    _env,
    _gateway,
    image_mod,
    video_mod,
)

GENERATE = {"image": "/tools/v1/image/generate", "video": "/tools/v1/video/jobs"}


def _handle(module, kind: str, args: dict) -> dict:
    handler = module._handle_generate_image if kind == "image" else module._handle_generate_video
    return json.loads(handler(args))


@pytest.fixture
def plugins(request):
    return {kind: request.getfixturevalue(f"{kind}_mod") for kind in ("image", "video")}


@pytest.mark.parametrize("kind", ["image", "video"])
@pytest.mark.parametrize(
    "shape",
    ["@image:`{p}`", "@image:{p}", '@file:"{p}"', "[Image attached at: {p}]", "file://{u}", "{p}"],
    ids=["composer", "composer-bare", "dragged-file", "runtime-hint", "file-url", "plain-path"],
)
def test_every_attachment_form_uploads_the_photo_it_names(monkeypatch, tmp_path, plugins, kind, shape):
    fake = Gateway(monkeypatch)
    photo = tmp_path / "Application Support" / "ApexNodes" / "composer-images" / "IMG_6352_d081c2.jpg"
    photo.parent.mkdir(parents=True)
    photo.write_bytes(b"\xff\xd8-composer-photo")
    source = shape.format(p=photo, u=str(photo).replace(" ", "%20"))
    result = _handle(plugins[kind], kind, {"prompt": "x", "images": [{"source": source, "role": "reference", "kind": "scene"}]})
    assert "error" not in result, result
    (upload,) = [c for c in fake.calls if c["path"] == "/tools/v1/media/reference-upload"]
    assert upload["files"]["file"][1] == b"\xff\xd8-composer-photo"
    assert fake.generate(GENERATE[kind])["images"][0]["ref"] == UPLOADED


@pytest.mark.parametrize("kind", ["image", "video"])
def test_an_attachment_whose_file_is_gone_fails_naming_its_path(monkeypatch, tmp_path, plugins, kind):
    fake = Gateway(monkeypatch)
    gone = tmp_path / "composer-images" / "gone.jpg"
    result = _handle(plugins[kind], kind, {"prompt": "x", "images": [{"source": f"@image:`{gone}`", "role": "reference"}]})
    assert "error" in result and "找不到第 1 张图" in result["error"]
    assert "composer-images/gone.jpg" in result["error"], "a long path keeps its file name"
    assert "@image:" not in result["error"]
    assert GENERATE[kind] not in fake.paths(), "never a request without the image"


@pytest.mark.parametrize(
    ("source", "path"),
    [
        ("@image:`/Users/a b/x.jpg`", "/Users/a b/x.jpg"),
        ("@image:'/Users/a b/x.jpg'", "/Users/a b/x.jpg"),
        ("@file:\"C:\\Users\\a b\\x.png\"", "C:\\Users\\a b\\x.png"),
        ("[Image attached at: /tmp/x.png]", "/tmp/x.png"),
        ("file:///C:/Users/a%20b/x.png", "C:/Users/a b/x.png"),
        ("file:///Users/a%20b/x.png", "/Users/a b/x.png"),
        ("media:" + "a" * 32 + "/ref_1.png", "media:" + "a" * 32 + "/ref_1.png"),
        ("https://example.com/@image:x.png", "https://example.com/@image:x.png"),
        ("@image:", "@image:"),
    ],
)
def test_attachment_tokens_unwrap_to_their_path(source, path):
    assert _gateway().attachment_path(source) == path


@pytest.mark.parametrize("kind", ["image", "video"])
@pytest.mark.parametrize(
    ("mode", "used"),
    [("text_only", []), ("reference", [{"index": 1, "role": "reference", "kind": "scene", "origin": "upload"}])],
)
def test_the_platforms_input_fields_reach_the_desktop_result(monkeypatch, plugins, kind, mode, used):
    """What the reply is checked against: the Desktop's localizing keeps both fields."""
    data = {"input_mode": mode, "input_images": used}
    if kind == "image":
        data.update(image_url="https://cdn.example/i.png", image_ref="media:" + "e" * 32 + "/image_1.png")
    else:
        data.update(video_url="https://cdn.example/o.mp4", video_path="/data/x.mp4")
    Gateway(monkeypatch, generate={"ok": True, "data": data})
    result = _handle(plugins[kind], kind, {"prompt": "x"})
    assert (result["input_mode"], result["input_images"]) == (mode, used)
