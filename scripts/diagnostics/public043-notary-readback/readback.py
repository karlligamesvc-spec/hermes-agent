"""Read the exact public packages; never build, install, or launch APEX."""

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
IDENTITY_FILES = (
    "Contents/Info.plist",
    "Contents/Resources/app.asar",
    "Contents/Resources/install-stamp.json",
    "Contents/MacOS/APEX",
)


def hashes(path):
    sha256, sha512 = hashlib.sha256(), hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha256.update(chunk)
            sha512.update(chunk)
    return {
        "size": path.stat().st_size,
        "sha256": sha256.hexdigest(),
        "sha512": base64.b64encode(sha512.digest()).decode(),
    }


def require(condition, message):
    if not condition:
        raise ValueError(message)


class Collector:
    def __init__(self, output):
        require(not output.exists(), "output directory must be new")
        self.output = output
        self.proof_dir = output / "proof"
        self.proof_dir.mkdir(parents=True)
        self.child_env = {k: os.environ[k] for k in ("PATH", "DEVELOPER_DIR") if k in os.environ}
        for key, name in (("HOME", "home"), ("TMPDIR", "tmp")):
            private = output / name
            private.mkdir()
            self.child_env[key] = str(private)
        self.commands = []

    def command(self, argv, label, timeout=90, required=True):
        argv = [str(value) for value in argv]
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        try:
            result = subprocess.run(
                argv, capture_output=True, cwd=REPO, env=self.child_env, timeout=timeout
            )
            code, stdout, stderr = result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired as exc:
            code, stdout, stderr = 124, exc.stdout or b"", exc.stderr or b""
        record = {"argv": argv, "exit": code, "started_at": started, "required": required}
        for field, content in (("stdout", stdout), ("stderr", stderr)):
            path = self.proof_dir / f"{label}.{field}.log"
            path.write_bytes(content)
            record[field] = content.decode(errors="replace")
            record[f"{field}_file"] = path.name
            record[f"{field}_sha256"] = hashes(path)["sha256"]
        self.commands.append(record)
        print(json.dumps({"command": label, "exit": code}), flush=True)
        return record

    def download(self, package):
        path = self.output / package["name"]
        result = self.command(
            [
                "/usr/bin/curl", "--fail", "--location", "--proto", "=https",
                "--connect-timeout", "30", "--max-time", "1200", "--output", path,
                "--write-out", "http=%{http_code} remote_ip=%{remote_ip} tls_verify=%{ssl_verify_result}\n",
                package["url"],
            ],
            package["name"] + ".download", timeout=1230,
        )
        require(result["exit"] == 0, f"download failed: {package['name']}")
        actual = hashes(path)
        require(all(actual[key] == package[key] for key in actual), f"package digest mismatch: {package['name']}")
        return {"name": package["name"], "url": package["url"], "before": actual, "download": result}

    def inspect(self, package, manifest, arch_checker, node):
        label = package["name"]
        path = self.output / label
        prefix = self.output / (label + ".inspection")
        prefix.mkdir()
        mount = prefix / "mount"
        attached = False
        item = {"name": label, "platform": package["platform"], "passed": False}
        try:
            if path.suffix == ".zip":
                app_root = prefix / "unpacked"
                app_root.mkdir()
                result = self.command(["/usr/bin/ditto", "-x", "-k", path, app_root], label + ".extract", 180)
            else:
                mount.mkdir()
                app_root = mount
                attached = True
                result = self.command(
                    ["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, path],
                    label + ".mount", 120,
                )
                # The owned mountpoint is detached even after a partial attach failure.
            require(result["exit"] == 0, f"extraction failed: {label}")
            apps = list(app_root.glob("*.app"))
            require(len(apps) == 1, f"expected one App: {label}")
            app = apps[0]
            item["app"] = str(app)
            item["identity_before"] = {name: hashes(app / name)["sha256"] for name in IDENTITY_FILES}
            bundle = plistlib.loads((app / IDENTITY_FILES[0]).read_bytes())
            item["bundle"] = {key: bundle[key] for key in (
                "CFBundleShortVersionString", "CFBundleVersion", "CFBundleIdentifier"
            )}
            require(bundle["CFBundleShortVersionString"] == manifest["version"] and bundle["CFBundleVersion"] == manifest["version"], "bundle version mismatch")
            require(bundle["CFBundleIdentifier"] == "com.apexnodes.desktop", "bundle identifier mismatch")
            stamp = json.loads((app / "Contents/Resources/install-stamp.json").read_text())
            item["install_stamp"] = stamp
            require(stamp["commit"] == manifest["package_source"] and stamp["source"] == "ci" and stamp["dirty"] is False, "package source identity mismatch")
            arch = package["platform"].removeprefix("mac-")
            commands = {
                "architecture": [node, arch_checker, app, arch],
                "signature_verify": ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app],
                "signature_identity": ["/usr/bin/codesign", "-dv", "--verbose=4", app],
                "gatekeeper": ["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", app],
                "app_ticket": ["/usr/bin/xcrun", "stapler", "validate", app],
            }
            item["assessments"] = {key: self.command(argv, label + "." + key) for key, argv in commands.items()}
            identity = item["assessments"]["signature_identity"]["stderr"]
            cdhash = re.search(r"^CDHash=(\w+)$", identity, re.M)
            item["cdhash"] = cdhash.group(1) if cdhash else None
            item["identity_after"] = {name: hashes(app / name)["sha256"] for name in IDENTITY_FILES}
            if path.suffix == ".dmg":
                item["container_signature"] = self.command(["/usr/bin/codesign", "-dv", "--verbose=2", path], label + ".container_signature", required=False)
                item["container_ticket"] = self.command(["/usr/bin/xcrun", "stapler", "validate", path], label + ".container_ticket", required=False)
            require(all(value["exit"] == 0 for value in item["assessments"].values()), f"required assessment failed: {label}")
            require("TeamIdentifier=Q3S52NJ72G" in identity and "Developer ID Application:" in identity and cdhash, "developer identity mismatch")
            require("source=Notarized Developer ID" in item["assessments"]["gatekeeper"]["stderr"], "Gatekeeper identity mismatch")
            require(item["identity_before"] == item["identity_after"], "App identity bytes changed")
            item["passed"] = True
        except (ValueError, OSError, KeyError) as exc:
            item["failure"] = repr(exc)
        finally:
            if attached:
                item["detach"] = self.command(["/usr/bin/hdiutil", "detach", mount], label + ".detach", 120)
                if item["detach"]["exit"] != 0:
                    item["passed"] = False
                    item["cleanup_failure"] = "owned readonly volume could not be detached"
        return item


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    require(sys.platform == "darwin", "requires actual macOS")
    require(output.parent == Path(os.environ["RUNNER_TEMP"]).resolve(), "output must be an owned runner-temp child")
    collector = Collector(output)
    manifest = json.loads((HERE / "manifest.json").read_text())
    proof = {
        "scope": "Anonymous readonly public package notarization diagnostic; no App launch/build/install/publish",
        "package_source": manifest["package_source"], "formal_release_run": manifest["formal_release_run"],
        "version": manifest["version"], "diagnostic": {key: os.environ.get(key) for key in (
            "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_EVENT_NAME", "GITHUB_REF",
            "GITHUB_REPOSITORY", "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion"
        )},
        "manifest_sha256": hashes(HERE / "manifest.json")["sha256"],
        "downloads": [], "packages": [], "commands": collector.commands, "all_four_passed": False,
    }
    try:
        require(os.environ["GITHUB_REF"] == "refs/heads/codex/hc-901-public043-notary-readback", "diagnostic branch required")
        require(os.environ["GITHUB_SHA"] != manifest["package_source"], "diagnostic and package source must be separate")
        require(hashes(HERE / "original-macos-static-reader.py")["sha256"] == manifest["original_reader_sha256"], "original reader changed")
        checker = REPO / "apps/desktop/scripts/assert-macos-package-arch.mjs"
        require(hashes(checker)["sha256"] == manifest["architecture_checker_sha256"], "architecture checker changed")
        node = shutil.which("node")
        require(node is not None, "Node is required for the unchanged architecture checker")
        checkout = collector.command(["/usr/bin/git", "rev-parse", "HEAD"], "diagnostic_checkout")
        proof["diagnostic"]["actual_checkout_commit"] = checkout["stdout"].strip()
        require(checkout["exit"] == 0 and checkout["stdout"].strip() == os.environ["GITHUB_SHA"], "checkout does not match diagnostic run source")
        collector.command(["/usr/bin/sw_vers"], "runner_os")
        collector.command(["/usr/bin/uname", "-a"], "runner_kernel")
        collector.command([node, "--version"], "node_version")
        # No extraction or ticket request until every whole-body digest has matched.
        for package in manifest["packages"]:
            proof["downloads"].append(collector.download(package))
        proof["all_four_downloads_exact"] = len(proof["downloads"]) == 4
        for package in manifest["packages"]:
            proof["packages"].append(collector.inspect(package, manifest, checker, node))
        for download in proof["downloads"]:
            download["after"] = hashes(output / download["name"])
            require(download["before"] == download["after"], "original package bytes changed")
        pairs = []
        for platform in ("mac-arm64", "mac-x64"):
            pair = [item for item in proof["packages"] if item["platform"] == platform]
            same = len(pair) == 2 and all(item["passed"] for item in pair) and pair[0]["identity_before"] == pair[1]["identity_before"] and pair[0]["cdhash"] == pair[1]["cdhash"]
            pairs.append({"platform": platform, "same_inner_identity_and_cdhash": same})
        proof["zip_dmg_pairs"] = pairs
        proof["all_four_passed"] = len(proof["packages"]) == 4 and all(item["passed"] for item in proof["packages"]) and all(item["same_inner_identity_and_cdhash"] for item in pairs)
    except (ValueError, OSError, KeyError) as exc:
        proof["failure"] = repr(exc)
    finally:
        (collector.proof_dir / "manifest.json").write_bytes((HERE / "manifest.json").read_bytes())
        (collector.proof_dir / "original-macos-static-reader.py").write_bytes((HERE / "original-macos-static-reader.py").read_bytes())
        (collector.proof_dir / "readback.py").write_bytes(Path(__file__).read_bytes())
        (collector.proof_dir / "diagnostic-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"proof": str(collector.proof_dir / "diagnostic-proof.json"), "all_four_passed": proof["all_four_passed"]}), flush=True)
    return 0 if proof["all_four_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
