"""The local-git connector, against real repositories built in a tmpdir.

Real `git init` rather than a mocked subprocess: the things worth testing here
are exactly the things a mock would have to assert do not happen — that a
rename is a delete plus a write, that an unknown cursor degrades to a full
read instead of raising, that a binary blob never reaches the index. A fake
`git` would encode today's beliefs about those and pass forever.

These need the git binary but no database, so they stay in the unit suite.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from commonindex.workers.connectors.git import RepoRef
from commonindex.workers.connectors.localgit import (
    Connector,
    LocalRepo,
    indexable,
    ref_for,
)

REF = RepoRef(org="example", repo="storefront", branch="main", provider="local")


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args],
                          check=True, capture_output=True, text=True).stdout


def commit(repo: Path, message: str) -> str:
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q",
        "-m", message, "--allow-empty")
    return git(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def repo(tmp_path) -> Path:
    path = tmp_path / "storefront"
    path.mkdir()
    git(path, "init", "-q", "-b", "main")
    (path / "checkout.py").write_text("def place_order(cart):\n    return cart\n")
    (path / "README.md").write_text("# Storefront\n")
    commit(path, "initial")
    return path


def connector(repo: Path) -> Connector:
    return Connector([LocalRepo(ref=REF, path=repo)])


async def test_a_first_pull_reads_the_whole_tree(repo):
    records, cursor = await connector(repo).pull(REF.stream_name, None)

    assert sorted(r.props["path"] for r in records) == ["README.md", "checkout.py"]
    assert cursor == git(repo, "rev-parse", "HEAD").strip()
    assert records[0].props["sha"] == cursor


async def test_a_pull_at_the_current_head_does_no_work(repo):
    """The hourly pass over an unchanged repo is the common case. It should not
    re-read a tree to discover that nothing moved."""
    head = git(repo, "rev-parse", "HEAD").strip()

    records, cursor = await connector(repo).pull(REF.stream_name, head)

    assert records == [] and cursor == head


async def test_only_changed_files_come_back_after_the_first_pull(repo):
    _, first = await connector(repo).pull(REF.stream_name, None)
    (repo / "checkout.py").write_text("def place_order(cart):\n    return submit(cart)\n")
    commit(repo, "submit")

    records, _ = await connector(repo).pull(REF.stream_name, first)

    assert [r.props["path"] for r in records] == ["checkout.py"]


async def test_a_deleted_file_arrives_as_a_deletion_not_an_absence(repo):
    """An absence is indistinguishable from "unchanged" on an incremental
    pull, which is how a deleted file stays searchable forever."""
    _, first = await connector(repo).pull(REF.stream_name, None)
    (repo / "README.md").unlink()
    commit(repo, "drop readme")

    records, _ = await connector(repo).pull(REF.stream_name, first)

    assert [(r.props["path"], r.deleted) for r in records] == [("README.md", True)]


async def test_a_rename_is_a_delete_plus_a_write(repo):
    """code_file is keyed by (repo, path), so a rename is genuinely two facts.
    Treating it as an update would leave the old path indexed."""
    _, first = await connector(repo).pull(REF.stream_name, None)
    git(repo, "mv", "checkout.py", "orders.py")
    commit(repo, "rename")

    records, _ = await connector(repo).pull(REF.stream_name, first)

    assert sorted((r.props["path"], r.deleted) for r in records) == [
        ("checkout.py", True), ("orders.py", False),
    ]


async def test_an_unknown_cursor_degrades_to_a_full_read(repo):
    """A force-push or a shallow clone leaves a cursor that cannot be diffed
    from. Re-reading is idempotent by content hash; refusing to index is not
    recoverable without an operator."""
    records, _ = await connector(repo).pull(REF.stream_name, "0" * 40)

    assert sorted(r.props["path"] for r in records) == ["README.md", "checkout.py"]


async def test_binary_and_oversized_blobs_never_reach_the_index(repo):
    (repo / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    (repo / "huge.py").write_text("x = 1\n" * 200_000)
    commit(repo, "assets")

    records, _ = await connector(repo).pull(REF.stream_name, None)
    paths = [r.props["path"] for r in records]

    assert "logo.png" not in paths          # not in SUFFIXES, and binary
    assert "huge.py" not in paths           # over MAX_FILE_BYTES
    assert "checkout.py" in paths


async def test_lockfiles_and_vendored_bundles_are_excluded(repo):
    assert indexable("commonindex/app.py")
    assert not indexable("package-lock.json")
    assert not indexable("uv.lock")
    assert not indexable("logo.png")


async def test_identity_comes_from_the_remote_not_the_checkout_path(repo):
    """A repo indexed from disk must resolve to the same repo_id the GitHub
    connector would produce, or the first API pull silently forks it in two and
    the symptom is a user who can no longer read code they were granted."""
    git(repo, "remote", "add", "origin", "git@github.com:example/storefront.git")

    ref = await ref_for(repo)

    assert (ref.org, ref.repo, ref.provider) == ("example", "storefront", "github")
    assert ref.repo_id == RepoRef(org="example", repo="storefront",
                                  branch="main").repo_id


async def test_an_https_remote_resolves_the_same_way(repo):
    git(repo, "remote", "add", "origin", "https://github.com/example/storefront.git")

    ref = await ref_for(repo)

    assert (ref.org, ref.repo) == ("example", "storefront")


async def test_a_clone_with_no_remote_falls_back_to_its_directory_name(repo):
    ref = await ref_for(repo)

    assert (ref.org, ref.repo, ref.provider) == ("local", "storefront", "local")


async def test_a_non_ascii_path_survives_the_round_trip(repo):
    """core.quotepath=false — otherwise git returns "\\303\\251.py" and the
    path no longer names the file."""
    (repo / "café.py").write_text("x = 1\n")
    commit(repo, "unicode")

    records, _ = await connector(repo).pull(REF.stream_name, None)

    assert "café.py" in [r.props["path"] for r in records]
