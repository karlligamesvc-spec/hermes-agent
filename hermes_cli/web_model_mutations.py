"""Fence Desktop model writes at the actual, canonical profile's disk boundary.

The nonsecret journal coordinates dashboard processes, including synchronous
workers that outlive their HTTP clients. Untagged clients and CLI writes do not
open it. Admission is short; pricing/network work happens before the commit lock.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import sqlite3
import threading
import uuid

# Config/CLI can import the no-op commit guard without dashboard extras installed.
try:
    from starlette.requests import HTTPConnection
except ImportError:
    HTTPConnection = object

AUTHORITY_HEADER = "X-Apex-Model-Authority"
REVISION_HEADER = "X-Apex-Model-Revision"
TARGET_HEADER = "X-Apex-Model-Target"
_MAX_REVISION = 2**53 - 1
_JOURNAL = ".desktop-model-mutations.sqlite3"


@dataclass(frozen=True)
class MutationContext:
    home: Path
    authority: str
    revision: int
    target_id: str
    committed: threading.Event = field(default_factory=threading.Event, compare=False)
    written: threading.Event = field(default_factory=threading.Event, compare=False)


_context = contextvars.ContextVar("desktop_model_mutation", default=None)
_committing = contextvars.ContextVar("desktop_model_mutation_commit", default=None)
_side_committing = contextvars.ContextVar("desktop_side_config_commit", default=None)


def _error(status, detail):
    from fastapi import HTTPException
    return HTTPException(status, detail=detail)


def _uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Noncanonical UUID")
    return value


@contextlib.contextmanager
def _journal(home: Path):
    path = home / _JOURNAL
    if not home.is_dir():
        raise _error(404, "Model mutation profile does not exist")
    if any(Path(str(path) + suffix).is_symlink() for suffix in ("", "-wal", "-shm", "-journal")):
        raise _error(503, "Model mutation journal is unavailable")
    connection = None
    try:
        existed = path.exists()
        connection = sqlite3.connect(path, timeout=30, isolation_level=None)
        if os.name != "nt":
            os.chmod(path, 0o600)
        connection.execute("BEGIN IMMEDIATE")
        if existed and connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='identity'").fetchone() is None:
            raise ValueError("Missing journal identity")
        connection.execute("CREATE TABLE IF NOT EXISTS revisions (authority TEXT PRIMARY KEY, revision INTEGER NOT NULL)")
        connection.execute("CREATE TABLE IF NOT EXISTS identity (target_id TEXT NOT NULL)")
        rows = connection.execute("SELECT target_id FROM identity").fetchall()
        if not rows and not existed:
            connection.execute("INSERT INTO identity VALUES (?)", (str(uuid.uuid4()),))
        elif len(rows) != 1 or _uuid(rows[0][0]) != rows[0][0]:
            raise ValueError("Invalid journal identity")
        # Keep a newly created target identity even when an old captured target
        # is rejected. Existing corrupt identities are never regenerated.
        connection.commit()
        connection.execute("BEGIN IMMEDIATE")
    except BaseException as error:
        if connection is not None:
            connection.close()
        if isinstance(error, (sqlite3.Error, OSError, ValueError)):
            raise _error(503, "Model mutation journal is unavailable") from error
        raise
    try:
        try:
            yield connection
            connection.commit()
        except sqlite3.Error as error:
            connection.rollback()
            raise _error(503, "Model mutation journal is unavailable") from error
        except BaseException:
            connection.rollback()
            raise
    finally:
        connection.close()


def _assert_target(connection, receipt):
    if connection.execute("SELECT target_id FROM identity").fetchone()[0] != receipt.target_id:
        raise _error(409, {"code": "model_mutation_target_changed"})


def _revision(connection, receipt):
    row = connection.execute("SELECT revision FROM revisions WHERE authority = ?", (receipt.authority,)).fetchone()
    if row is not None and (type(row[0]) is not int or not 0 < row[0] <= _MAX_REVISION):
        raise _error(503, "Model mutation journal is unavailable")
    return row[0] if row else None


def _assert_current(connection, receipt):
    _assert_target(connection, receipt)
    if _revision(connection, receipt) != receipt.revision:
        raise _error(409, {"code": "model_mutation_superseded"})


def _admit(receipt):
    with _journal(receipt.home) as connection:
        _assert_target(connection, receipt)
        revision = _revision(connection, receipt)
        if revision is not None and revision >= receipt.revision:
            raise _error(409, {"code": "model_mutation_superseded"})
        connection.execute(
            "INSERT INTO revisions VALUES (?, ?) ON CONFLICT(authority) DO UPDATE SET revision=excluded.revision",
            (receipt.authority, receipt.revision),
        )


def _home(profile):
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_constants import get_hermes_home
    with _config_profile_scope(profile):
        return get_hermes_home().resolve()


def mutation_capabilities(profile):
    with _journal(_home(profile)) as connection:
        target_id = connection.execute("SELECT target_id FROM identity").fetchone()[0]
    return {"version": 1, "target_id": target_id}


def _guarded_path(path):
    return path in {"/api/model/set", "/api/model/moa", "/api/config", "/api/config/raw", "/api/env", "/api/model/mutation/fence"} or (
        path.startswith("/api/providers/custom-endpoints") and path != "/api/providers/custom-endpoints/validate"
    ) or bool(re.fullmatch(r"/api/tools/toolsets/[^/]+/(model|provider|env)", path))


async def model_mutation_dependency(request: HTTPConnection):
    if request.scope["type"] != "http" or request.method not in {"POST", "PUT", "PATCH", "DELETE"} or not _guarded_path(request.url.path):
        yield
        return
    authority, raw_revision, target = (request.headers.get(header) for header in (AUTHORITY_HEADER, REVISION_HEADER, TARGET_HEADER))
    if authority is None and raw_revision is None and target is None:
        if request.url.path == "/api/model/mutation/fence":
            raise _error(422, "Model mutation fence requires a receipt")
        yield
        return
    try:
        authority, target = _uuid(authority), _uuid(target)
        if not raw_revision or not raw_revision.isascii() or not raw_revision.isdecimal():
            raise ValueError("Invalid revision")
        revision = int(raw_revision)
        if not 0 < revision <= _MAX_REVISION:
            raise ValueError("Invalid revision")
    except (TypeError, AttributeError, ValueError) as error:
        raise _error(422, "Invalid model mutation receipt") from error
    profile = request.query_params.get("profile")
    if request.headers.get("content-type", "").startswith("application/json"):
        try:
            body = await request.json()
        except ValueError:
            body = None
        body_profile = request.url.path in {"/api/model/set", "/api/model/moa", "/api/config", "/api/config/raw", "/api/env"} or request.url.path.startswith("/api/tools/toolsets/")
        if body_profile and isinstance(body, dict) and body.get("profile"):
            profile = body["profile"]
    receipt = MutationContext(await asyncio.to_thread(_home, profile), authority, revision, target)
    await asyncio.to_thread(_admit, receipt)
    token = _context.set(receipt)
    try:
        yield
    finally:
        _context.reset(token)


@contextlib.contextmanager
def model_mutation_commit(home=None):
    """Lock through the synchronous writer, including nested config/env saves.

    Cancelling its asyncio await cannot release the worker's transaction. The
    guard is entered before config locks so nested writes share one lock order.
    """
    receipt = _context.get()
    if receipt is None:
        yield
        return
    from hermes_constants import get_hermes_home
    if Path(home or get_hermes_home()).resolve() != receipt.home:
        raise _error(409, {"code": "model_mutation_target_changed"})
    if _committing.get() is receipt:
        yield
        return
    receipt.committed.clear()
    receipt.written.clear()
    with _journal(receipt.home) as connection:
        _assert_current(connection, receipt)
        token = _committing.set(receipt)
        try:
            yield
        finally:
            _committing.reset(token)
    receipt.committed.set()


def model_mutation_fence():
    receipt = _context.get()
    if receipt is None:
        raise _error(422, "Model mutation fence requires a receipt")
    with _journal(receipt.home) as connection:
        _assert_current(connection, receipt)
    return {"ok": True, "revision": receipt.revision, "target_id": receipt.target_id}


@contextlib.contextmanager
def config_mutation_commit():
    """Coordinate a short latest-state field edit with existing Desktop writers.

    Side-section edits carry no owner claim. When this profile already has a
    Desktop journal, share its actual-write lock so a field edit cannot capture
    and restore an older model snapshot. A CLI-only profile creates no journal.
    Callers enter this before the config lock and keep all preparation outside.
    """
    if _context.get() is not None:
        with model_mutation_commit():
            yield
        return
    from hermes_constants import get_hermes_home
    home = get_hermes_home().resolve()
    path = home / _JOURNAL
    if _side_committing.get() == home or not (path.exists() or path.is_symlink()):
        yield
        return
    with _journal(home):
        token = _side_committing.set(home)
        try:
            yield
        finally:
            _side_committing.reset(token)


def model_mutation_active():
    return _context.get() is not None


def model_mutation_ack():
    receipt = _context.get()
    if receipt is None or not receipt.committed.is_set() or not receipt.written.is_set():
        return {}
    return {"model_mutation": {"target_id": receipt.target_id, "revision": receipt.revision}}


def model_mutation_written():
    receipt = _context.get()
    if receipt is not None and _committing.get() is receipt:
        receipt.written.set()
