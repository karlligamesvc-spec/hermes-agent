from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "lockfile-diff.yml"


def test_lockfile_diff_fetches_only_comparison_histories():
    text = WORKFLOW.read_text(encoding="utf-8")
    executable = "\n".join(line.split("#", 1)[0] for line in text.splitlines())

    assert "fetch-depth: 1" in executable
    assert "fetch-depth: 0" not in executable
    assert 'BASE_SPEC="+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"' in executable
    assert 'HEAD_SPEC="+refs/pull/${PR_NUMBER}/head:refs/remotes/pull/${PR_NUMBER}/head"' in executable
    assert 'git fetch --no-tags --prune --depth=256 origin "$BASE_SPEC" "$HEAD_SPEC"' in executable
    assert 'git fetch --no-tags --prune --unshallow origin "$BASE_SPEC" "$HEAD_SPEC"' in executable


def test_lockfile_diff_compares_merge_base_to_pr_head():
    text = WORKFLOW.read_text(encoding="utf-8")

    assert 'HEAD_REF="refs/remotes/pull/${{ github.event.pull_request.number }}/head"' in text
    assert 'BASE_SHA=$(git merge-base "origin/${{ github.base_ref }}" "$HEAD_REF")' in text
    assert '--head "$HEAD_REF"' in text
