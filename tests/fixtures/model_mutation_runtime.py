"""Isolated loopback server for real Runtime mutation tests; never runs lifespan.

External pricing/model metadata and disk-write scheduling are controlled. Routes, config writes,
profile resolution, session authentication and SQLite transactions are production
code. Only this fixture's bound loopback listener is allowed, and all keys are fixtures.
"""

import asyncio
import functools
import ipaddress
import io
import json
import os
from pathlib import Path
import socket
import sys
import threading
from types import SimpleNamespace


def main():
    home, ready, mode = sys.argv[1:4]
    os.environ["HERMES_HOME"] = home
    os.environ["HOME"] = str(Path(home).parent)
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = "hc903-fixture-session"
    os.environ["HERMES_TEST_ISOLATION"] = home
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    owned_port = listener.getsockname()[1]
    connect = socket.socket.connect
    connect_ex = socket.socket.connect_ex

    def require_owned_listener(address):
        if not isinstance(address, tuple) or not ipaddress.ip_address(address[0]).is_loopback or address[1] != owned_port:
            raise AssertionError("Only the owned HTTP listener is allowed in Runtime fixture")

    def owned_listener_only(sock, address):
        require_owned_listener(address)
        return connect(sock, address)

    def owned_listener_only_ex(sock, address):
        require_owned_listener(address)
        return connect_ex(sock, address)

    socket.socket.connect = owned_listener_only
    socket.socket.connect_ex = owned_listener_only_ex
    import uvicorn
    from hermes_cli import config, model_selection_guards, models_validate, web_model_mutations, web_server

    pricing_entered, pricing_release = threading.Event(), threading.Event()
    write_entered, write_release = threading.Event(), threading.Event()
    admit_entered, worker_finished = threading.Event(), threading.Event()
    task_cancelled = threading.Event()
    active = {}

    def pricing(model, **kwargs):
        if mode == "pricing" and model == "owner-a":
            pricing_entered.set()
            if not pricing_release.wait(20):
                raise AssertionError("Test did not release pricing barrier")
        if mode == "confirmation":
            return SimpleNamespace(message="Fixture requires explicit confirmation")
        return None

    model_selection_guards.combined_selection_warning = pricing
    original_validate = models_validate.validate_requested_model

    def validate(model, *args, **kwargs):
        if mode == "validation" and model == "owner-a":
            pricing_entered.set()
            if not pricing_release.wait(20):
                raise AssertionError("Test did not release validation barrier")
        return original_validate(model, *args, **kwargs)

    models_validate.validate_requested_model = validate
    if mode in {"env-preparation", "env-persist", "env-write"}:
        from hermes_cli import auth, copilot_auth
        from agent import credential_pool

        def preparation(value):
            if mode == "env-preparation" and value.endswith("owner-a"):
                pricing_entered.set()
                if not pricing_release.wait(20):
                    raise AssertionError("Test did not release env preparation barrier")

        def detect_zai(value):
            preparation(value)
            return {"id": "fixture", "base_url": "https://fixture.zai.invalid/v4",
                    "model": "fixture-model", "label": "Fixture"}

        def exchange(req, timeout):
            value = req.get_header("Authorization").removeprefix("token ")
            preparation(value)
            return io.BytesIO(json.dumps({"token": "exchanged-" + value, "expires_at": 4102444800,
                                          "endpoints": {"api": "https://fixture.copilot.invalid"}}).encode())

        auth.detect_zai_endpoint = detect_zai
        copilot_auth._urlopen_bounded = exchange
        original_auth_save = credential_pool._save_auth_store
        auth_failures = []

        def auth_save(store):
            if mode == "env-persist" and not auth_failures:
                auth_failures.append(True)
                raise OSError("Fixture credential pool persistence failure")
            try:
                return original_auth_save(store)
            finally:
                if mode == "env-write":
                    worker_finished.set()

        credential_pool._save_auth_store = auth_save
        original_env_write = config._write_env_lines

        def env_write(*args, **kwargs):
            if mode == "env-write" and any("owner-a" in str(arg) for arg in args):
                write_entered.set()
                if not write_release.wait(20):
                    raise AssertionError("Test did not release env write barrier")
            return original_env_write(*args, **kwargs)

        config._write_env_lines = env_write
    tool_mode = mode.removeprefix("legacy-")
    if tool_mode in {"tool-model-preparation", "tool-provider-preparation", "tool-env-preparation"}:
        from hermes_cli.web_routers import tools
        original_catalog = tools._toolset_model_catalog
        original_rows = tools._category_providers

        def tool_preparation():
            receipt = web_model_mutations._context.get()
            if (receipt is not None and receipt.revision == 1) or mode.startswith("legacy-"):
                pricing_entered.set()
                if not pricing_release.wait(20):
                    raise AssertionError("Test did not release tool preparation barrier")

        def catalog(*args, **kwargs):
            if tool_mode == "tool-model-preparation":
                tool_preparation()
            return original_catalog(*args, **kwargs)

        def rows(*args, **kwargs):
            if tool_mode != "tool-model-preparation":
                tool_preparation()
            return original_rows(*args, **kwargs)

        tools._toolset_model_catalog = catalog
        tools._category_providers = rows
    if mode == "gateway-preparation":
        from hermes_cli import web_server_config
        from hermes_cli.model_switch import ModelSwitchResult
        original_selection = web_server_config._validated_main_model_selection

        def selection(cfg, provider, model, base_url, api_key="", **kwargs):
            if provider == "nous" and model == "owner-a":
                return ModelSwitchResult(success=True, new_model=model, target_provider="nous", base_url=base_url,
                                         api_key=api_key, api_mode="chat_completions")
            return original_selection(cfg, provider, model, base_url, api_key, **kwargs)

        def gateway_defaults(cfg):
            pricing_entered.set()
            if not pricing_release.wait(20):
                raise AssertionError("Test did not release gateway preparation barrier")
            return []

        web_server_config._validated_main_model_selection = selection
        web_server_config._apply_nous_gateway_defaults = gateway_defaults
    original_write = config.atomic_yaml_write
    failures = []

    def write(path, data, **kwargs):
        if mode == "persist" and not failures:
            failures.append(True)
            raise OSError("Fixture persistence failure")
        if mode == "registration" and data.get("custom_providers") and not failures:
            failures.append(True)
            raise OSError("Fixture secondary catalog failure")
        if mode == "write" and isinstance(data.get("model"), dict) and data["model"].get("default") == "owner-a":
            write_entered.set()
            if not write_release.wait(20):
                raise AssertionError("Test did not release write barrier")
        try:
            return original_write(path, data, **kwargs)
        finally:
            if write_entered.is_set():
                worker_finished.set()

    config.atomic_yaml_write = write
    original_admit = web_model_mutations._admit

    def admit(receipt):
        if receipt.revision == 2:
            admit_entered.set()
        original_admit(receipt)
        if mode == "admission" and receipt.revision == 1:
            pricing_entered.set()
            if not pricing_release.wait(20):
                raise AssertionError("Test did not release admission barrier")

    web_model_mutations._admit = admit
    # Cancels the actual route task, not its worker. This is stronger than an
    # HTTP client disconnect (uvicorn normally lets disconnected handlers finish).
    route = next(route for route in web_server.app.routes if getattr(route, "path", None) == "/api/model/set")
    original_assignment = route.dependant.call

    @functools.wraps(original_assignment)
    async def assignment(*args, **kwargs):
        if kwargs["body"].model == "owner-a":
            active["a"] = asyncio.current_task()
        try:
            return await original_assignment(*args, **kwargs)
        except asyncio.CancelledError:
            task_cancelled.set()
            raise

    route.dependant.call = assignment
    if mode == "env-write":
        route = next(route for route in web_server.app.routes if getattr(route, "path", None) == "/api/env" and "PUT" in route.methods)
        original_env_assignment = route.dependant.call

        @functools.wraps(original_env_assignment)
        async def env_assignment(*args, **kwargs):
            if kwargs["body"].value.endswith("owner-a"):
                active["a"] = asyncio.current_task()
            try:
                return await original_env_assignment(*args, **kwargs)
            except asyncio.CancelledError:
                task_cancelled.set()
                raise

        route.dependant.call = env_assignment

    @web_server.app.get("/__fixture/state")
    async def state():
        return {name: event.is_set() for name, event in {
            "pricing_entered": pricing_entered, "write_entered": write_entered,
            "admit_entered": admit_entered, "task_cancelled": task_cancelled,
            "worker_finished": worker_finished,
        }.items()}

    @web_server.app.post("/__fixture/release")
    async def release():
        pricing_release.set()
        write_release.set()
        return {"ok": True}

    @web_server.app.post("/__fixture/cancel")
    async def cancel():
        active["a"].cancel()
        return {"ok": True}

    # Production's SPA catch-all precedes test-added routes; move only our
    # fixture controls ahead of it without changing any production API route.
    controls = [route for route in web_server.app.routes if getattr(route, "path", "").startswith("/__fixture/")]
    for control in controls:
        web_server.app.router.routes.remove(control)
    web_server.app.router.routes[:0] = controls

    server = uvicorn.Server(uvicorn.Config(web_server.app, lifespan="off", log_level="critical", access_log=False))
    ready_path = Path(ready)
    pending_ready = ready_path.with_name(ready_path.name + ".tmp")
    pending_ready.write_text(json.dumps({"port": listener.getsockname()[1]}))
    pending_ready.replace(ready_path)
    server.run(sockets=[listener])


if __name__ == "__main__":
    main()
