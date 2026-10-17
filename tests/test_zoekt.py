"""The Zoekt adapter, against a response captured from the real service.

RESPONSE below is genuine output from `sourcegraph/zoekt-webserver` — not a
hand-written approximation of it. The fields that matter here are exactly the
ones a plausible-looking fixture gets wrong: Duration is nanoseconds, Content is
base64 of raw bytes, and the line number lives on ContentStart rather than on
the match Range. A fixture written from memory would encode those beliefs and
pass forever whether or not they were true.

No service required, so these stay in the unit suite.
"""

from __future__ import annotations

import base64
import json

import pytest

from commonindex.adapters.zoekt import (
    Results,
    Zoekt,
    ZoektUnavailable,
    _parse,
    repo_filter,
)

RESPONSE = json.loads(r"""
{"Result":{"Duration":5399042,"FileCount":1,"MatchCount":1,"FilesSkipped":0,
"FlushReason":0,"Files":[{"FileName":"src/checkout.py",
"Repository":"github.com/example/storefront",
"Version":"58688f4864bffa01505c95e98cfdb6af79c6f708","Language":"Python",
"Branches":["main"],"ChunkMatches":[{"Content":"ZGVmIHBsYWNlX29yZGVyKGNhcnQsIHVzZXIpOgogICAgIiIiRW50cnkgcG9pbnQgZm9yIG9yZGVyIHBsYWNlbWVudCBmcm9tIHRoZSBzdG9yZWZyb250LiIiIgo=",
"Ranges":[{"Start":{"ByteOffset":4,"LineNumber":1,"Column":5},
"End":{"ByteOffset":15,"LineNumber":1,"Column":16}}],
"ContentStart":{"ByteOffset":0,"LineNumber":1,"Column":1},"Score":8301}],
"Score":83000000010}]}}
""")


def test_a_real_response_parses_into_cited_source():
    results = _parse(RESPONSE)
    hit = results.hits[0]

    assert (hit.repo_name, hit.path) == ("github.com/example/storefront", "src/checkout.py")
    assert hit.version == "58688f4864bffa01505c95e98cfdb6af79c6f708"
    assert hit.branches == ("main",)
    assert "def place_order(cart, user):" in hit.chunks[0].body
    assert hit.chunks[0].start_line == 1


def test_duration_is_read_as_nanoseconds():
    """5399042 is 5.4ms, not 5399 seconds. Reporting the wrong unit here is how
    a fast search gets blamed for a slow page."""
    assert _parse(RESPONSE).duration_ms == pytest.approx(5.399042)


def test_line_numbers_survive_so_a_citation_can_be_opened():
    chunk = _parse(RESPONSE).hits[0].chunks[0]

    assert chunk.match_lines == (1,)
    assert chunk.end_line == 2          # two lines in the decoded body


def test_the_repo_filter_is_anchored():
    """Unanchored, `repo:storefront` also matches `evil/storefront-secrets` —
    a substring away from serving code the caller was never granted."""
    assert repo_filter(["github.com/example/storefront"]) == \
        r"repo:^(github\.com/example/storefront)$"


def test_repo_names_are_escaped_and_ordered():
    """A repository is named by its remote, and a remote is not obliged to be
    free of regex metacharacters. Sorted so the query is stable and cacheable."""
    built = repo_filter(["b.repo", "a+repo", "b.repo"])

    assert built.startswith("repo:^(") and built.endswith(")$")
    assert built == r"repo:^(a\+repo|b\.repo)$"


async def test_a_caller_who_may_read_nothing_never_reaches_zoekt():
    """The fail-closed branch. Omitting the filter would search every shard on
    the box, so "may read nothing" must not be expressible as "no filter" —
    and it must not even make the call."""
    class Exploding(Zoekt):
        def _post(self, path, payload):      # pragma: no cover - must not run
            raise AssertionError("zoekt was called for a caller with no repos")

    results = await Exploding("http://unused").search("order", repo_names=[])

    assert results == Results(hits=(), file_count=0, match_count=0, duration_ms=0.0)


async def test_the_query_carries_the_filter_and_the_terms():
    sent: dict = {}

    class Recording(Zoekt):
        def _post(self, path, payload):
            sent.update(json.loads(payload))
            sent["path"] = path
            return RESPONSE

    await Recording("http://unused").search(
        "place_order", repo_names=["github.com/example/storefront"])

    assert sent["path"] == "/api/search"
    assert sent["Q"] == r"repo:^(github\.com/example/storefront)$ place_order"
    assert sent["Opts"]["ChunkMatches"] is True


async def test_an_unreachable_service_raises_rather_than_reporting_no_results():
    """No hits and "the index is down" are different answers. Collapsing them
    tells a caller their code does not mention what they searched for."""
    client = Zoekt("http://127.0.0.1:1", timeout_seconds=0.2)

    with pytest.raises(ZoektUnavailable):
        await client.search("order", repo_names=["github.com/example/storefront"])


def test_an_early_flush_is_reported_as_truncated():
    """A prefix of the matches presented as all of them is how a partial answer
    becomes a confident wrong one."""
    assert _parse({"Result": {**RESPONSE["Result"], "FlushReason": 1}}).truncated
    assert not _parse(RESPONSE).truncated


def test_invalid_utf8_in_a_matched_line_does_not_fail_the_search():
    payload = {"Result": {"Files": [{"FileName": "a.py", "Repository": "r",
               "ChunkMatches": [{"Content": base64.b64encode(b"caf\xe9\n").decode(),
                                 "ContentStart": {"LineNumber": 3}}]}]}}

    assert _parse(payload).hits[0].chunks[0].start_line == 3


def test_from_env_is_none_when_unconfigured(monkeypatch):
    """Search getting worse is recoverable; search disappearing because a
    sidecar is missing is not — so an unset URL falls back rather than fails."""
    monkeypatch.delenv("COMMONINDEX_ZOEKT_URL", raising=False)

    assert Zoekt.from_env() is None


def test_a_query_zoekt_cannot_parse_is_its_own_error(monkeypatch):
    """Zoekt answers 400 with "error parsing regexp" when a term is not a
    regex — `*` with nothing to repeat. That is a different fact from Zoekt
    being down, so it gets a different error; still a ZoektUnavailable, so a
    caller that only knows that one falls back as before."""
    import io
    from urllib.error import HTTPError

    from commonindex.adapters import zoekt as z

    def refuse(*_, **__):
        raise HTTPError("http://zoekt/api/search", 400, "Bad Request", {}, io.BytesIO(
            b'{"Error":"error parsing regexp: missing argument to repetition operator: `*`"}'))

    monkeypatch.setattr(z, "urlopen", refuse)
    client = z.Zoekt("http://zoekt")
    with pytest.raises(z.ZoektBadQuery, match="repetition operator"):
        client._post("/api/search", b"{}")
    assert issubclass(z.ZoektBadQuery, z.ZoektUnavailable)

    def down(*_, **__):
        raise HTTPError("http://zoekt/api/search", 502, "Bad Gateway", {}, io.BytesIO(b""))

    monkeypatch.setattr(z, "urlopen", down)
    with pytest.raises(z.ZoektUnavailable) as e:
        client._post("/api/search", b"{}")
    assert not isinstance(e.value, z.ZoektBadQuery)


async def test_a_large_repository_is_not_cut_off_by_zoekts_per_shard_cap():
    """One repository is one shard, and Zoekt stops a shard at ShardMaxMatchCount
    whatever the total allows: a common word came back as 2 files of 20."""
    sent = []

    class Capture(Zoekt):
        def _post(self, path, payload):
            sent.append(json.loads(payload))
            return {"Result": {"Files": []}}

    await Capture("http://zoekt").search("request", repo_names=["example/mono"], max_files=20)
    opts = sent[0]["Opts"]
    assert opts["MaxDocDisplayCount"] == 20
    assert opts["ShardMaxMatchCount"] >= 20 * 60 and opts["TotalMaxMatchCount"] >= opts["ShardMaxMatchCount"]
