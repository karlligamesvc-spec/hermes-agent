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


# hc-1203: upstream v0.23.0 moved its CI onto Blacksmith: ``blacksmith-*`` runner labels and
# ``useblacksmith/*`` actions (checkout, cache, docker builder). The fork has no Blacksmith
# installation, so such a job queues until GitHub cancels it and such a step cannot run. Comments
# and READMEs may still name it; a YAML line that does is executable configuration.
_YAML_COMMENT = re.compile(r"(?:^|\s)#.*$")


def test_fork_ci_never_asks_for_a_blacksmith_runner_or_action() -> None:
    github = REPO_ROOT / ".github"
    scanned, offenders = 0, []
    for path in sorted([*github.joinpath("workflows").glob("*.y*ml"), *github.joinpath("actions").rglob("*.y*ml")]):
        scanned += 1
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "blacksmith" in _YAML_COMMENT.sub("", line).lower():
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{number}: {line.strip()}")

    assert scanned >= len(FORK_REQUIRED_WORKFLOWS)  # the scan found the workflows, not an empty directory
    assert offenders == [], (
        "fork CI references Blacksmith runners or actions that cannot run on the fork:\n" + "\n".join(offenders)
    )
