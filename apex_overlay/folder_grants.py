"""hc-1207: a folder the user hands over in Desktop reaches the agent outside the chat's workspace.

The + menu's 添加文件夹, a Finder drop and a Finder paste all send the folder as ``@folder:<abs>``.
The workspace guard (``agent.context_references._resolve_path``) refuses that whenever the folder is
not under the chat's working directory, which for an assistant is its profile home: the model saw
only "path is outside the allowed workspace". A file is copied into ``attachments/`` by
``file.attach``; a folder of video clips is not copied (hc-906 contract: folders stay references).

Instead the folder is granted to ONE session:

* ``folder.attach`` (registered here, with its contract) takes ``{session_id, path, grant}``. ``grant``
  is an HMAC-SHA256 the Desktop main process signs with a per-launch key that only it and the engines
  it spawned hold (``HERMES_DESKTOP_REFERENCE_GRANT_KEY``). Main signs only paths a trusted source
  gave it: its own native open dialog, or the path preload's ``webUtils.getPathForFile`` read from a
  real dropped/pasted File (``apps/desktop/electron/apex-reference-grants.ts``). The renderer can ask
  for a signature but never for one over a path it made up.
* The folder is resolved (symlinks included) and refused when it is a whole disk, the home folder or
  an ancestor of it, APEX's own data folder or an ancestor of it, or anything the reference
  deny-list refuses (``~/.ssh``, credential files, Hermes internals). Then it is recorded on that
  session's dict, so it ends with the session and is never written anywhere.
* While a Desktop turn's input is prepared (``_prepare_turn_input``, rebound onto ``tui_gateway.server``), the
  session's granted folders are an extra allowed root for ``_resolve_path``: a reference under one
  resolves (after resolving symlinks, so a link inside the folder pointing elsewhere is still
  refused), the credential deny-list still runs on every reference, and anything else gets the same
  refusal as before. IM turns (``gateway/run_inbound.py``) and the CLI never enter that function, so
  nothing changes for them.
"""

from __future__ import annotations

import contextvars
import functools
import hashlib
import hmac
import logging
import os
import sys
from pathlib import Path

from apex_overlay import post_import

logger = logging.getLogger(__name__)

GRANT_KEY_ENV = "HERMES_DESKTOP_REFERENCE_GRANT_KEY"
GRANT_DOMAIN = b"apexnodes-desktop-folder-grant:v1"
SESSION_KEY = "apex_folder_grants"
METHOD = "folder.attach"

_RESOLVE_MODULE = "agent.context_references"
_SERVER_MODULE = "tui_gateway.server"
_MARK = "_apex_folder_grants"
# The one refusal a grant widens; every other ValueError (credential paths, NT namespace) stands.
_OUTSIDE = "path is outside the allowed workspace"

# The granted folders of the session whose turn input is being prepared; empty everywhere else.
_turn_grants: contextvars.ContextVar[tuple[Path, ...]] = contextvars.ContextVar(
    "apex_folder_grants", default=())


class FolderGrantRefused(ValueError):
    """The folder cannot be handed over. ``reason`` is the stable code Desktop words for the user."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def _launch_key() -> bytes | None:
    try:
        key = bytes.fromhex(os.environ.get(GRANT_KEY_ENV, ""))
    except ValueError:
        return None
    return key if len(key) >= 32 else None


def sign(path: str, key: bytes) -> str:
    """The grant Desktop's main process signs for ``path`` (same bytes as apex-reference-grants.ts)."""
    return hmac.new(key, GRANT_DOMAIN + b"\0" + path.encode("utf-8"), hashlib.sha256).hexdigest()


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _too_broad(folder: Path) -> str | None:
    """Why ``folder`` (resolved) is too broad to hand over, or None."""
    from agent.file_safety import _hermes_dirs

    if folder == Path(folder.anchor):
        return "a whole disk"
    if _is_under(Path.home().resolve(), folder):
        return "your home folder"
    if any(_is_under(hermes_dir, folder) for hermes_dir in _hermes_dirs()):
        return "APEX's own data folder"
    return None


def _resolve_folder(raw: str) -> Path:
    """``raw`` as an existing directory, symlinks resolved; raises FolderGrantRefused."""
    from agent.file_safety import is_nt_namespace_path

    if is_nt_namespace_path(raw):  # raw-string check: resolving such a path is the NTLM-leak trigger
        raise FolderGrantRefused("unsupported_path", "this folder path cannot be handed over")
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise FolderGrantRefused("unsupported_path", "folder path must be absolute")
    try:
        folder = candidate.resolve(strict=True)  # symlinks resolved before any check below
    except (OSError, RuntimeError) as exc:
        raise FolderGrantRefused("not_found", "folder not found") from exc
    if not folder.is_dir():
        raise FolderGrantRefused("not_folder", "not a folder")
    return folder


def _check_admissible(folder: Path) -> None:
    """Refuse a folder too broad to hand over, or one the reference deny-list refuses."""
    from agent.context_references import _ensure_reference_path_allowed

    if broad := _too_broad(folder):
        raise FolderGrantRefused("too_broad", f"this folder is too broad to hand over ({broad}); pick a folder inside it")
    try:
        _ensure_reference_path_allowed(folder)
    except ValueError as exc:
        raise FolderGrantRefused("sensitive", str(exc)) from exc


def grant_session_folder(session: dict, raw: str, grant: str, workspace: Path) -> Path:
    """Verify Desktop's signature over ``raw``, admit the folder, record it on ``session``.

    A folder inside ``workspace`` (the session cwd, resolved) needs no grant: the workspace guard
    already admits it, so it is returned as it was before this seam (no breadth check, nothing
    recorded) and picking the working directory itself keeps working."""
    key = _launch_key()
    if key is None:
        raise FolderGrantRefused("no_key", "folders can only be handed over to an engine this Desktop started")
    if not hmac.compare_digest(sign(raw, key), grant):
        raise FolderGrantRefused("not_handed_over", "this folder was not handed over through Desktop")
    folder = _resolve_folder(raw)
    if _is_under(folder, workspace):
        return folder
    _check_admissible(folder)
    granted = session.setdefault(SESSION_KEY, [])
    if str(folder) not in granted:
        granted.append(str(folder))
    return folder


def session_grants(session) -> tuple[Path, ...]:
    if not isinstance(session, dict):
        return ()
    return tuple(Path(entry) for entry in session.get(SESSION_KEY) or ())


def _wrap_resolve(original):
    @functools.wraps(original)
    def _resolve_path(cwd, target, *, allowed_root=None):
        try:
            return original(cwd, target, allowed_root=allowed_root)
        except ValueError as exc:
            roots = _turn_grants.get()
            if not roots or str(exc) != _OUTSIDE:
                raise
            # A granted folder is one more allowed root: same resolve (symlinks first), same is-under.
            for root in roots:
                try:
                    return original(cwd, target, allowed_root=root)
                except ValueError:
                    continue
            raise

    setattr(_resolve_path, _MARK, True)
    return _resolve_path


def _install_resolve(module) -> bool:
    original = getattr(module, "_resolve_path", None)
    if original is None:
        return False
    if not getattr(original, _MARK, False):
        module._resolve_path = _wrap_resolve(original)
    return True


def _wrap_turn(original):
    @functools.wraps(original)
    def _prepare_turn_input(sid, session, *args, **kwargs):
        token = _turn_grants.set(session_grants(session))
        try:
            return original(sid, session, *args, **kwargs)
        finally:
            _turn_grants.reset(token)

    setattr(_prepare_turn_input, _MARK, True)
    return _prepare_turn_input


def _install_turn(server) -> bool:
    # prompt_turn's functions are rebound onto the server namespace (method_ctx.bind_module), and the
    # turn runner looks ``_prepare_turn_input`` up there: patching tui_gateway.prompt_turn does nothing.
    original = getattr(server, "_prepare_turn_input", None)
    if original is None:
        return False
    if not getattr(original, _MARK, False):
        server._prepare_turn_input = _wrap_turn(original)
    return True


def _folder_attach(rid, params: dict) -> dict:
    server = sys.modules[_SERVER_MODULE]
    session, err = server._sess_building(params, rid)
    if err:
        return err
    raw = str(params.get("path") or "").strip()
    grant = str(params.get("grant") or "").strip()
    if not raw or not grant:
        return server._err(rid, 4015, "path and grant required")
    try:
        folder = grant_session_folder(session, raw, grant, Path(server._session_cwd(session)).resolve())
    except FolderGrantRefused as exc:
        return server._ok(rid, {"attached": False, "reason": exc.reason, "message": str(exc)})
    ref_path = server._attachment_ref_path(session, folder)
    return server._ok(rid, {
        "attached": True, "path": str(folder), "ref_path": ref_path,
        "ref_text": f"@folder:{server._format_ref_value(ref_path)}"})


def _declare_contract() -> None:
    from tui_gateway.contracts import registry
    from tui_gateway.contracts.base import Result
    from tui_gateway.contracts.common import SessionParams

    if METHOD in registry.METHODS:
        return

    class FolderAttachParams(SessionParams):
        """``grant``: Desktop main's signature over exactly ``path``."""

        path: str
        grant: str

    class FolderAttachResult(Result):
        attached: bool
        # Refused: no_key, not_handed_over, unsupported_path, not_found, not_folder, too_broad, sensitive.
        reason: str | None = None
        message: str | None = None
        path: str | None = None
        ref_path: str | None = None
        ref_text: str | None = None

    registry.method(METHOD, params=FolderAttachParams, result=FolderAttachResult,
                    doc="Grant a folder the user handed over in Desktop to this session; returns its @folder: ref.")


def _install_method(server) -> bool:
    if getattr(getattr(server, "_methods", {}).get(METHOD), _MARK, False):
        return True
    _declare_contract()
    setattr(_folder_attach, _MARK, True)
    server.register_method(METHOD, _folder_attach)
    return True


def _install_server(server) -> bool:
    turn_ok = _install_turn(server)
    return _install_method(server) and turn_ok


def apply() -> bool:
    ok = post_import.when_imported(_RESOLVE_MODULE, _install_resolve)
    return post_import.when_imported(_SERVER_MODULE, _install_server) and ok
