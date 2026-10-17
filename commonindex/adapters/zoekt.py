"""Zoekt — trigram code search, as a candidate generator only.

Lives in ``commonindex.adapters`` for the reason the package exists: it names a
third-party product and speaks its response vocabulary. ``commonindex.core`` may not
import it, and the isolation guard enforces that.

**Zoekt never makes an authorization decision.** It is handed a repository
filter built from the caller's own grants, and every hit it returns is joined
back to a ``code_file`` row and re-authorized in Postgres before any body
reaches an API response or a model. A shard hit alone grants nothing. Two
independent reasons, both of which have to hold: the filter narrows what is
searched, and the join re-checks what is returned. If the filter were ever
wrong, the join still refuses.

Why this rather than the tsvector leg alone: ``chunks.tsv`` is
``to_tsvector('english', body)``, and English stemming over source code does not
unify ``placeOrder`` with ``place_order``, splits identifiers on punctuation, and
cannot express a regex at all. For "where does order placement happen" across
several repositories that is a recall failure, not a rough edge.

The search API is unversioned and was confirmed against
``sourcegraph/zoekt-webserver`` directly: ``POST /api/search`` with ``{"Q", "Opts"}``
returns ``{"Result": {"Files": [...]}}`` where each file carries ``Repository``,
``Version`` (the indexed commit SHA — the join key back to ``code_file.sha``),
``Language``, ``Branches`` and ``ChunkMatches`` whose ``Content`` is base64.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ZoektUnavailable(RuntimeError):
    """The search service could not be reached or did not answer usefully.

    Raised rather than returned as an empty result: no hits and "the index is
    down" are different answers, and collapsing them tells a caller their code
    does not mention what they searched for.
    """


class ZoektBadQuery(ZoektUnavailable):
    """Zoekt refused the query itself — it reads every term as a regular
    expression, so code such as `func (e *engine) Poll` is an invalid one
    (`*` with nothing to repeat, `(` never closed). A subclass, so a caller
    that only knows "Zoekt did not answer" still falls back as before; one
    that knows better can ask again with the text taken literally."""


@dataclass(frozen=True, slots=True)
class Chunk:
    """One matched run of lines, already decoded and line-numbered."""

    body: str
    start_line: int
    #: Lines within this chunk that actually matched, for highlighting and for
    #: choosing what to expand around.
    match_lines: tuple[int, ...] = ()

    @property
    def end_line(self) -> int:
        """Counting newlines overshoots by one on the usual case of a body that
        ends in one — a citation to `L1-L3` for two lines of code sends a reader
        past the end of what was actually matched."""
        return self.start_line + max(len(self.body.splitlines()), 1) - 1


@dataclass(frozen=True, slots=True)
class Hit:
    """One file with matches. Deliberately not "the answer" — this is a
    candidate that has not yet been re-authorized."""

    repo_name: str
    path: str
    #: The commit the shard was built from. Joined against `code_file.sha` to
    #: notice that the shard is describing a version Postgres no longer holds.
    version: str
    language: str
    branches: tuple[str, ...]
    score: float
    chunks: tuple[Chunk, ...] = ()


@dataclass(frozen=True, slots=True)
class Results:
    hits: tuple[Hit, ...]
    file_count: int
    match_count: int
    duration_ms: float
    #: Zoekt stopped early — the caller is seeing a prefix of what matched, and
    #: should say so rather than presenting it as exhaustive.
    truncated: bool = False
    #: Repositories excluded by the ACL filter before the search ran. Reported
    #: so a thin answer is legible as "you cannot see those" rather than as
    #: "there is nothing there".
    withheld_repos: int = 0


@dataclass(frozen=True, slots=True)
class Repo:
    name: str
    branches: tuple[str, ...] = ()


def repo_filter(names: list[str]) -> str:
    """An anchored alternation over exactly the repositories the caller may read.

    Anchored because an unanchored `repo:storefront` also matches
    `evil/storefront-secrets`, which is a substring away from being a leak.
    Each name is escaped: a repository is named by its remote, and a remote is
    not required to be free of regex metacharacters.
    """
    return "repo:^(" + "|".join(re.escape(n) for n in sorted(set(names))) + ")$"


@dataclass(frozen=True, slots=True)
class Zoekt:
    base_url: str
    timeout_seconds: float = 10.0
    #: How many files to ask for. A cap here rather than only at the gateway so
    #: a missing limit downstream cannot pull an entire corpus into memory.
    max_files: int = 50

    @classmethod
    def from_env(cls) -> Zoekt | None:
        """None when unconfigured, so the gateway falls back to the Postgres
        leg instead of failing. Search getting worse is recoverable; search
        going away because a sidecar is missing is not."""
        base_url = os.environ.get("COMMONINDEX_ZOEKT_URL", "").rstrip("/")
        if not base_url:
            return None
        return cls(base_url,
                   float(os.environ.get("COMMONINDEX_ZOEKT_TIMEOUT_SECONDS", "10")),
                   int(os.environ.get("COMMONINDEX_ZOEKT_MAX_FILES", "50")))

    async def search(self, query: str, *, repo_names: list[str],
                     max_files: int | None = None) -> Results:
        """Search only `repo_names`.

        An empty list returns empty WITHOUT calling Zoekt. That is the whole
        fail-closed contract in one branch: omitting the filter would search
        every shard on the box, so "this caller may read nothing" must never be
        expressible as "no filter".
        """
        if not repo_names:
            return Results(hits=(), file_count=0, match_count=0, duration_ms=0.0)

        limit = max_files or self.max_files
        # Zoekt stops a shard at ShardMaxMatchCount matches, whatever the total
        # allows, and a large repository is one shard. Left at its default, a
        # word in every file stopped after ~124 matches — two files of a
        # 20,000-file repository whose files each said it 60 times — and
        # came back marked truncated with 2 of the 20 files asked for.
        budget = limit * 100
        payload = json.dumps({
            "Q": f"{repo_filter(repo_names)} {query}",
            "Opts": {"ChunkMatches": True, "NumContextLines": 2, "MaxDocDisplayCount": limit,
                     "ShardMaxMatchCount": budget, "TotalMaxMatchCount": budget},
        }).encode()
        raw = await asyncio.to_thread(self._post, "/api/search", payload)
        return _parse(raw)

    async def repos(self) -> list[Repo]:
        """What Zoekt actually has, under the names it actually assigned.

        `zoekt-git-index` has no flag to set a repository's name — it derives it
        from the clone's remote — so the mapping back to our own repo ids is
        read from the service rather than reconstructed by re-implementing that
        derivation and hoping the two stay in step.
        """
        raw = await asyncio.to_thread(self._post, "/api/list", json.dumps({}).encode())
        listed = (raw.get("List") or {}).get("Repos") or []
        out = []
        for entry in listed:
            repo = entry.get("Repository") or {}
            if repo.get("Name"):
                out.append(Repo(name=repo["Name"],
                                branches=tuple(b.get("Name", "") for b in
                                               (repo.get("Branches") or []))))
        return out

    def _post(self, path: str, payload: bytes) -> dict:
        request = Request(f"{self.base_url}{path}", payload,
                          {"content-type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode())
        except HTTPError as error:
            detail = ""
            try:
                detail = str((json.loads(error.read().decode() or "{}") or {}).get("Error") or "")
            except (ValueError, OSError):
                pass
            if error.code == 400 and "pars" in detail.lower():
                raise ZoektBadQuery(f"zoekt could not parse the query: {detail}") from error
            raise ZoektUnavailable(
                f"zoekt {path} returned {error.code}" + (f": {detail}" if detail else "")) from error
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            raise ZoektUnavailable(f"zoekt {path}: {error}") from error


def _parse(raw: dict) -> Results:
    result = raw.get("Result") or {}
    hits = tuple(_hit(f) for f in (result.get("Files") or []))
    return Results(
        hits=hits,
        file_count=int(result.get("FileCount") or 0),
        match_count=int(result.get("MatchCount") or 0),
        # Zoekt reports nanoseconds.
        duration_ms=float(result.get("Duration") or 0) / 1_000_000,
        # A non-zero FlushReason means the search returned early, so what came
        # back is a prefix rather than everything that matched.
        truncated=bool(result.get("FlushReason")) or bool(result.get("FilesSkipped")),
    )


def _hit(file: dict) -> Hit:
    return Hit(
        repo_name=file.get("Repository", ""),
        path=file.get("FileName", ""),
        version=file.get("Version", ""),
        language=file.get("Language", ""),
        branches=tuple(file.get("Branches") or ()),
        score=float(file.get("Score") or 0.0),
        chunks=tuple(_chunk(c) for c in (file.get("ChunkMatches") or [])),
    )


def _chunk(chunk: dict) -> Chunk:
    """`Content` is base64 of raw bytes. Decoded with replacement rather than
    strictly: a file Zoekt considered text can still hold a byte sequence that
    is not valid UTF-8, and one such line should not fail a whole search."""
    body = base64.b64decode(chunk.get("Content") or b"").decode("utf-8", errors="replace")
    start = int((chunk.get("ContentStart") or {}).get("LineNumber") or 1)
    matches = tuple(sorted({
        int((r.get("Start") or {}).get("LineNumber") or start)
        for r in (chunk.get("Ranges") or [])
    }))
    return Chunk(body=body, start_line=start, match_lines=matches)
