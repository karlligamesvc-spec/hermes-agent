"""Keep required fork CI on runner labels that can actually execute.

The upstream repository can use named 32/96-core runners.  Those labels are
not registered in the ApexNodes fork: affected jobs remain queued until
GitHub cancels them after 24 hours.  Fork-required workflows must therefore
use the standard GitHub-hosted pools.  Docker publish jobs are intentionally
out of scope because their workflow is hard-gated to NousResearch/hermes-agent.
"""

from pathlib import Path
import re


REPO_ROOT = Path(__file__).resolve().parents[2]
FORK_REQUIRED_WORKFLOWS = (
    "e2e-desktop.yml",
    "js-tests.yml",
    "nix.yml",
    "rust-tests.yml",
    "tests-os.yml",
    "tests.yml",
)
UNAVAILABLE_LARGE_RUNNER = re.compile(
    r"(?m)^\s*(?:runs-on|runner):\s*"
    r"((?:ubuntu|windows)-latest-(?:32|64|96)(?:-arm)?-core)\s*$"
)


def test_fork_required_workflows_only_use_available_runner_pools() -> None:
    workflows = REPO_ROOT / ".github" / "workflows"
    offenders: dict[str, list[str]] = {}

    for name in FORK_REQUIRED_WORKFLOWS:
        text = (workflows / name).read_text(encoding="utf-8")
        matches = sorted(set(UNAVAILABLE_LARGE_RUNNER.findall(text)))
        if matches:
            offenders[name] = matches

    assert offenders == {}, (
        "fork-required jobs reference unregistered large-runner labels: "
        f"{offenders}"
    )
