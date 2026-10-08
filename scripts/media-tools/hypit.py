"""Verify the licensed Hypit npm mirror; installation still resolves npm dependencies."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path


def verify_archive(archive: Path, record: dict) -> None:
    digest = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if "sha512-" + digest != record["integrity"]:
        raise ValueError("Hypit npm integrity mismatch")
    with tarfile.open(archive) as tar:
        metadata = json.load(tar.extractfile("package/package.json"))
        license_text = tar.extractfile("package/LICENSE").read().decode()
        if metadata["name"] != "@hypit/hypit" or metadata["version"] != record["version"]:
            raise ValueError("Hypit package identity mismatch")
        if "Hypit" not in license_text or "Commercial redistribution" not in license_text:
            raise ValueError("Hypit license changed; review before redistribution")


def prepare(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    record = json.loads(Path(__file__).with_name("source-lock.json").read_text())["hypit"]
    archive = destination / f"hypit-{record['version']}.tgz"
    with urllib.request.urlopen(record["url"], timeout=120) as response:
        with archive.open("wb") as output:
            shutil.copyfileobj(response, output)
    verify_archive(archive, record)
    with tempfile.TemporaryDirectory() as temporary:
        project = Path(temporary)
        (project / "package.json").write_text('{"private":true}')
        npm = shutil.which("npm")
        node = shutil.which("node")
        if not npm or not node:
            raise ValueError("Node 22.15+ and npm are required")
        # npm.cmd needs cmd.exe on Windows; invoke npm's JS entry with Node instead.
        if platform.system() == "Windows":
            npm_cli = Path(node).parent / "node_modules/npm/bin/npm-cli.js"
            npm_command = [node, str(npm_cli)]
        else:
            npm_command = [npm]
        subprocess.run([*npm_command, "install", "--no-audit", "--no-fund", str(archive.resolve())],
                       cwd=project, timeout=600, check=True)
        result = subprocess.run([node, str(project / "node_modules/@hypit/hypit/bin/hypit.mjs"),
                                 "version"], cwd=project, capture_output=True, text=True,
                                timeout=90, check=True)
        if record["version"] not in result.stdout:
            raise ValueError("Hypit CLI did not report expected version")
    proof = {"schema": 1, "version": record["version"], "integrity": record["integrity"],
             "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
             "system": platform.system(), "machine": platform.machine(),
             "checks": ["npm-integrity", "license-preserved", "npm-install", "cli-version"],
             "renderVerified": False, "dependenciesMirrored": False}
    (destination / "hypit-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    prepare(parser.parse_args().directory.resolve())
