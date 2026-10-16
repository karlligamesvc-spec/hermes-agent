#!/usr/bin/env python3
"""ApexNodes hc-911: the upstream release an upstream-sync PR merges, verified, or nothing.

A sync PR merges a NousResearch release into the fork and so carries thousands of upstream
changes that the diff-based gates (code-health ratchet, supply-chain scan, catalog admission)
would otherwise judge as if the PR had written them. Such a PR records the release it merges
in .github/apex-upstream-baseline.json, and those gates then also compare against that release:
only what is new against BOTH the fork base and upstream is judged.

The record only counts when it changed between base and head, GitHub confirms that the tag
resolves to that commit in NousResearch/hermes-agent, and, where the checkout has full
history, the commit is an ancestor of head. Prints ``commit=<sha>`` and ``tag=<tag>`` (for
$GITHUB_OUTPUT) on a verified sync PR, nothing on an ordinary PR, and exits 1 when a changed
record cannot be verified. Standard library only: workflows run it before any setup.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from typing import Callable

RECORD = ".github/apex-upstream-baseline.json"
UPSTREAM_REPO = "NousResearch/hermes-agent"
_SHA = re.compile(r"^[0-9a-f]{40}$")
_TAG = re.compile(r"^v\d+\.\d+\.\d+$")


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    # A shallow fetch of one commit is the slowest call; nothing here should take minutes.
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=check, timeout=300)


def read_record(rev: str) -> dict | None:
    shown = _git("show", f"{rev}:{RECORD}", check=False)
    if shown.returncode != 0:
        return None
    record = json.loads(shown.stdout)
    tag, commit = record.get("tag", ""), record.get("commit", "")
    if not (_TAG.match(tag) and _SHA.match(commit)):
        raise ValueError(f"{RECORD} on {rev} needs a vX.Y.Z tag and a full commit sha")
    return {"tag": tag, "commit": commit}


def resolve_upstream_tag(tag: str) -> str:
    """The commit ``tag`` names in the upstream repository, as GitHub reports it."""
    request = urllib.request.Request(
        f"https://api.github.com/repos/{UPSTREAM_REPO}/commits/{tag}",
        headers={"Accept": "application/vnd.github.sha", "User-Agent": "apex-upstream-sync-baseline"},
    )
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode().strip()


def _ensure_commit(commit: str, fetch: bool) -> None:
    if _git("cat-file", "-e", f"{commit}^{{commit}}", check=False).returncode == 0:
        return
    if not fetch:
        raise RuntimeError(f"{commit} is not in this checkout (pass --fetch)")
    _git("fetch", "--no-tags", "--depth=1", "origin", commit)


def _shallow() -> bool:
    return _git("rev-parse", "--is-shallow-repository").stdout.strip() == "true"


def sync_baseline(base: str, head: str, *, fetch: bool = False,
                  resolve: Callable[[str], str] | None = None) -> dict | None:
    """The verified upstream release ``head`` newly merges relative to ``base``, else None."""
    record = read_record(head)
    if record is None or record == read_record(base):
        return None
    resolved = (resolve or resolve_upstream_tag)(record["tag"])
    if resolved != record["commit"]:
        raise RuntimeError(f"{UPSTREAM_REPO} {record['tag']} is {resolved}, not the recorded {record['commit']}")
    _ensure_commit(record["commit"], fetch)
    if not _shallow() and _git("merge-base", "--is-ancestor", record["commit"], head, check=False).returncode != 0:
        raise RuntimeError(f"{record['tag']} ({record['commit'][:12]}) is not merged into {head}")
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True, help="the fork base the PR targets")
    parser.add_argument("--head", required=True, help="the PR head or merge commit")
    parser.add_argument("--fetch", action="store_true", help="fetch the release commit if absent")
    args = parser.parse_args(argv)
    try:
        record = sync_baseline(args.base, args.head, fetch=args.fetch)
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"::error::upstream sync baseline: {exc}", file=sys.stderr)
        return 1
    if record:
        print(f"commit={record['commit']}")
        print(f"tag={record['tag']}")
        print(f"upstream sync baseline: {record['tag']} {record['commit'][:12]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
