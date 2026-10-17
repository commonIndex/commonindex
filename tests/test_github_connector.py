"""The GitHub code connector, against the shapes the real API returns.

The payload shapes here were taken from live calls to api.github.com while
building this (against a public repository), not written from memory — the fields that matter
are the ones an invented fixture gets subtly wrong: `status` is "removed" rather
than "deleted", a rename carries `previous_filename`, and contents come back
base64 under an `encoding` key that is "none" rather than absent when the file
is too large.

Network is stubbed at `_open`, so the tarball path exercises real gzip and real
tarfile streaming rather than a mock of them.
"""

from __future__ import annotations

import base64
import io
import json
import tarfile

import pytest

from commonindex.workers.connectors.git import (
    COMPARE_FILE_LIMIT,
    Connector,
    GitHubError,
    RateLimited,
    RepoRef,
)

REF = RepoRef(org="example", repo="storefront", branch="main", space_id="pay")
HEAD = "3cbaa76b6014f0d0e0f8b0a1c2d3e4f5a6b7c8d9"


def tarball(files: dict[str, bytes]) -> bytes:
    """A real gzipped tar shaped like GitHub's: everything under one wrapper
    directory named for the org, repo and sha."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, body in files.items():
            info = tarfile.TarInfo(f"example-storefront-{HEAD[:7]}/{path}")
            info.size = len(body)
            archive.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class Stub(Connector):
    """Answers by path prefix. Records every request so a test can assert on
    request COUNT — the difference between one tarball and 155 blob fetches is
    the point of the design, and only a count can prove it."""

    def __init__(self, routes: dict, **kw):
        super().__init__([REF], **kw)
        self._routes = routes
        self.requests: list[str] = []

    def _open(self, path: str, want_json: bool = False):
        self.requests.append(path)
        for prefix, payload in self._routes.items():
            if path.startswith(prefix):
                if isinstance(payload, Exception):
                    raise payload
                if isinstance(payload, bytes):
                    return FakeResponse(payload)
                return FakeResponse(json.dumps(payload).encode())
        raise GitHubError(f"unrouted {path}")


def commit(sha: str = HEAD) -> dict:
    return {"sha": sha}


def contents(body: str) -> dict:
    return {"encoding": "base64",
            "content": base64.b64encode(body.encode()).decode()}


async def test_a_backfill_reads_the_whole_repository_in_one_request():
    """The design's central claim. Walking the tree API and fetching each blob
    costs a request per file, which exhausts an authenticated hour on one
    mid-sized repository; the tarball costs one regardless of size."""
    stub = Stub({
        "/repos/example/storefront/commits/main": commit(),
        "/repos/example/storefront/tarball/": tarball({
            "src/checkout.py": b"def place_order():\n    pass\n",
            "README.md": b"# storefront\n",
        }),
    })

    records, cursor = await stub.pull(REF.stream_name, None)

    assert sorted(r.props["path"] for r in records) == ["README.md", "src/checkout.py"]
    assert cursor == HEAD
    # One commit lookup, one tarball. Not one per file.
    assert len(stub.requests) == 2


async def test_the_wrapper_directory_is_stripped_from_every_path():
    """GitHub nests everything under "<org>-<repo>-<sha>/". Leaving it on would
    make every citation point at a path that does not exist in the repository."""
    stub = Stub({"/repos/example/storefront/commits/main": commit(),
                 "/repos/example/storefront/tarball/": tarball({"a/b.py": b"x = 1\n"})})

    records, _ = await stub.pull(REF.stream_name, None)

    assert records[0].props["path"] == "a/b.py"


async def test_binary_and_oversized_members_never_reach_the_index():
    from commonindex.workers.connectors.localgit import MAX_FILE_BYTES

    stub = Stub({"/repos/example/storefront/commits/main": commit(),
                 "/repos/example/storefront/tarball/": tarball({
                     "ok.py": b"x = 1\n",
                     "logo.png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 64,
                     "big.py": b"x" * (MAX_FILE_BYTES + 1),
                 })})

    records, _ = await stub.pull(REF.stream_name, None)

    assert [r.props["path"] for r in records] == ["ok.py"]


async def test_a_pull_at_the_current_head_does_no_work():
    stub = Stub({"/repos/example/storefront/commits/main": commit()})

    records, cursor = await stub.pull(REF.stream_name, HEAD)

    assert records == [] and cursor == HEAD
    assert len(stub.requests) == 1          # the head check, and nothing else


async def test_an_incremental_pull_fetches_only_changed_files():
    stub = Stub({
        "/repos/example/storefront/commits/main": commit(),
        "/repos/example/storefront/compare/": {"files": [
            {"filename": "src/checkout.py", "status": "modified"}]},
        "/repos/example/storefront/contents/": contents("def place_order():\n    pass\n"),
    })

    records, _ = await stub.pull(REF.stream_name, "older" + "0" * 35)

    assert [r.props["path"] for r in records] == ["src/checkout.py"]
    assert not any("tarball" in r for r in stub.requests)
    assert REF.stream_name not in stub.full_reads     # a diff names its own deletions


async def test_a_removed_file_arrives_as_a_deletion():
    """"removed", not "deleted" — getting that string wrong leaves the file
    indexed forever and it fails silently."""
    stub = Stub({
        "/repos/example/storefront/commits/main": commit(),
        "/repos/example/storefront/compare/": {"files": [
            {"filename": "src/old.py", "status": "removed"}]},
    })

    records, _ = await stub.pull(REF.stream_name, "older" + "0" * 35)

    assert [(r.props["path"], r.deleted) for r in records] == [("src/old.py", True)]


async def test_a_rename_is_a_delete_plus_a_write():
    stub = Stub({
        "/repos/example/storefront/commits/main": commit(),
        "/repos/example/storefront/compare/": {"files": [
            {"filename": "src/orders.py", "status": "renamed",
             "previous_filename": "src/checkout.py"}]},
        "/repos/example/storefront/contents/": contents("x = 1\n"),
    })

    records, _ = await stub.pull(REF.stream_name, "older" + "0" * 35)

    assert sorted((r.props["path"], r.deleted) for r in records) == [
        ("src/checkout.py", True), ("src/orders.py", False)]


async def test_a_large_changeset_falls_back_to_one_whole_read():
    """Past the threshold a "smaller" incremental read is slower and far more
    expensive in rate-limit budget than starting over — measured, not assumed."""
    stub = Stub({
        "/repos/example/storefront/commits/main": commit(),
        "/repos/example/storefront/compare/": {"files": [
            {"filename": f"f{i}.py", "status": "modified"}
            for i in range(COMPARE_FILE_LIMIT + 1)]},
        "/repos/example/storefront/tarball/": tarball({"f0.py": b"x = 1\n"}),
    })

    records, _ = await stub.pull(REF.stream_name, "older" + "0" * 35)

    assert any("tarball" in r for r in stub.requests)
    assert [r.props["path"] for r in records] == ["f0.py"]
    # Told apart from a diff, so the indexer retires what the whole read left out.
    assert REF.stream_name in stub.full_reads


async def test_an_unknown_base_falls_back_instead_of_failing():
    """A force-push or rebase leaves a cursor the repository no longer
    contains. Re-reading is idempotent by content hash downstream; refusing to
    index needs an operator."""
    stub = Stub({
        "/repos/example/storefront/commits/main": commit(),
        "/repos/example/storefront/compare/": GitHubError("404"),
        "/repos/example/storefront/tarball/": tarball({"a.py": b"x = 1\n"}),
    })

    records, _ = await stub.pull(REF.stream_name, "gone" + "0" * 36)

    assert [r.props["path"] for r in records] == ["a.py"]


def _raising(monkeypatch, status: int, headers: dict) -> Connector:
    """Patched at urlopen, NOT at _open — the translation from an HTTPError to
    our own exception types lives inside _open, so a stub that replaced _open
    would assert against logic it had just removed."""
    from urllib.error import HTTPError

    from commonindex.workers.connectors import git

    def boom(*_args, **_kw):
        raise HTTPError("u", status, "denied", headers, None)

    monkeypatch.setattr(git, "urlopen", boom)
    return Connector([REF])


async def test_rate_limiting_is_not_reported_as_a_broken_connector(monkeypatch):
    """Wait is a different remedy from fix-your-token, so it is a different
    exception — and it must not be swallowed by the fall-back-to-tarball path,
    which would turn one throttled call into a much larger one."""
    connector = _raising(monkeypatch, 403,
                         {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "123"})

    with pytest.raises(RateLimited):
        await connector.pull(REF.stream_name, None)


async def test_a_forbidden_private_repo_is_not_mistaken_for_throttling(monkeypatch):
    """403 with budget remaining is a permissions problem. Telling an operator
    to wait for a reset that will not help is worse than saying nothing."""
    connector = _raising(monkeypatch, 403, {"x-ratelimit-remaining": "4999"})

    with pytest.raises(GitHubError) as caught:
        await connector.pull(REF.stream_name, None)

    assert not isinstance(caught.value, RateLimited)
    assert "CODEQUERY_GITHUB_TOKEN" in str(caught.value)


async def test_a_throttled_compare_does_not_silently_become_a_full_read(monkeypatch):
    """_compare swallows GitHubError to fall back to the tarball. If it swallowed
    RateLimited too, being throttled would trigger the single most expensive
    request available — turning a pause into a much worse one."""
    connector = _raising(monkeypatch, 429, {"x-ratelimit-remaining": "0"})

    with pytest.raises(RateLimited):
        await connector._compare(REF, "a" * 40, "b" * 40)


async def test_an_oversized_file_reports_no_content_rather_than_garbage():
    """Over 1 MB the contents API returns encoding "none" and an empty body.
    Treating that as text would index an empty file over a real one."""
    stub = Stub({
        "/repos/example/storefront/commits/main": commit(),
        "/repos/example/storefront/compare/": {"files": [
            {"filename": "huge.py", "status": "modified"}]},
        "/repos/example/storefront/contents/": {"encoding": "none", "content": ""},
    })

    records, _ = await stub.pull(REF.stream_name, "older" + "0" * 35)

    assert records == []


def test_both_connectors_agree_on_what_counts_as_source():
    """Two definitions would mean a repository's contents changed depending on
    which connector read it — and the switch from a local clone to the API is
    exactly when that would be discovered."""
    from commonindex.workers.connectors import git, localgit

    assert git.MAX_FILE_BYTES == localgit.MAX_FILE_BYTES
    assert git._indexable("a/b.py") and not git._indexable("package-lock.json")
