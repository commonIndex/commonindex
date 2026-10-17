"""Code Query's connector on the shared ingestion contract.

Tier 2 (mirror), same as github.py — this is the codebase-indexing half of the
GitHub connection, not a second connection. `discover()` returns one stream per
configured (org/repo, branch); `pull`'s cursor is the last-indexed commit SHA,
not a page token, so a repo's own history is the resumability mechanism and no
side table is needed to remember where a backfill stopped.

**A backfill is one request, not one per file.** The obvious implementation —
walk the tree API, then fetch each blob — costs a request per file, which
exhausts an authenticated hour's budget (5000) on a single mid-sized repository
and takes minutes of round trips to do it. Reading the tarball instead costs one
request for the whole repository regardless of size. Incremental pulls then use
the compare API, where the number of changed files is small by construction.

subscribe() is deliberately unimplemented in v1: the trigger is an hourly k8s
CronJob, not a webhook. Wiring a GitHub webhook here
later is the natural upgrade to near-real-time and does not change the shape
of `pull` or `fetch`.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import tarfile
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from . import ACL, Record, Stream

#: Anything outside this class is folded to "-" when building a repo id. A repo
#: id becomes an ACL resource (`object:<repo_id>`), and commonindex/gateway/access.py
#: rejects a resource outside `[A-Za-z0-9_.:-]` — so an unsanitised branch name
#: with a slash in it ("release/2024-06") would produce a grant that cannot be
#: written, or worse, one that is written and silently matches nothing.
_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]+")

API = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")

#: Above this many changed files, re-read the whole repository instead of
#: fetching each one.
#:
#: Not the compare API's own 300-file ceiling, which is far too high to be the
#: deciding number. A diff costs one request per changed file; the tarball costs
#: one request total. Measured against pallets/click: 28 changed files took
#: 13.8s over 29 requests, while the entire 155-file repository took 1.5s over
#: one. The crossover is low, and past it a "smaller" incremental read is slower
#: and far more expensive in rate-limit budget than simply starting over. A full
#: re-read is safe to prefer because unchanged content is skipped by hash
#: downstream, so it costs bandwidth but writes nothing.
COMPARE_FILE_LIMIT = 20


@dataclass(slots=True)
class RepoRef:
    """What's configured, not what's discovered — this connector has no notion
    of an enterprise's whole GitHub org, only the repos it has been pointed at.
    Read from CODEQUERY_REPOS by commonindex/workers/codequery.py; see its
    docstring for why an env var is enough for the one connector v1 ships."""

    org: str
    repo: str
    branch: str
    #: Which space this repo's objects belong to: the deployment's own
    #: (COMMONINDEX_SPACE) unless the repo list names one.
    space_id: str = field(default_factory=lambda: os.environ.get("COMMONINDEX_SPACE") or "pay")
    #: Which connector produced this repo. "local" is a clone on disk read by
    #: connectors/localgit.py; "github" is this API connector.
    provider: str = "github"

    @property
    def stream_name(self) -> str:
        return f"{self.org}/{self.repo}#{self.branch}"

    @property
    def repo_id(self) -> str:
        """The code_repo object id. Lives here rather than in the worker because
        it is the repo's identity, and both the ingest path and the ACL grant
        have to derive the same string or a caller is granted read on a repo
        that does not exist under that name."""
        raw = f"code_repo-{self.org}-{self.repo}-{self.branch}".lower()
        return _UNSAFE.sub("-", raw)

    @property
    def acl_key(self) -> str:
        """The permission handle every file in this repo carries.

        Deliberately NOT `space:<id>`. `acl_keys && $keys` is an overlap test,
        so an additional key can only ever widen access — a code file carrying
        both `space:pay` and its repo key is readable by anyone in the space and
        the repo grant decides nothing. Repo-scoped code therefore carries the
        repo key alone, and space isolation stays where it already was: a
        separate `space_id` clause on the same statement.
        """
        return f"object:{self.repo_id}"


class GitHubError(RuntimeError):
    """The API refused or could not be reached."""


class RateLimited(GitHubError):
    """Distinct from a generic failure because the remedy is different: wait,
    rather than fix a token or a name. The worker reports it per repo so one
    throttled repository does not read as a broken connector."""


class Connector:
    def __init__(self, repos: list[RepoRef], token: str | None = None) -> None:
        self._repos = repos
        #: A PAT for v1 — a GitHub App is the upgrade
        #: once more than one org is connected. Unauthenticated works for public
        #: repositories at 60 requests/hour, which is enough to try one repo and
        #: not enough to run a schedule.
        self._token = token or os.environ.get("CODEQUERY_GITHUB_TOKEN") \
            or os.environ.get("GITHUB_TOKEN")
        self._by_stream = {r.stream_name: r for r in repos}
        #: Streams whose last pull read the whole tree rather than a diff. What
        #: such a read leaves out is gone, and only the ingest side knows what
        #: was there before — see codequery._retire_absent.
        self.full_reads: set[str] = set()

    async def discover(self) -> list[Stream]:
        """One Stream per configured repo. Pure local mapping, not a network
        call — what the connector was constructed with IS the discovery."""
        return [Stream(name=r.stream_name, canonical_type="code_file") for r in self._repos]

    async def head(self, stream: str) -> str:
        ref = self._by_stream[stream]
        commit = await self._json(f"/repos/{ref.org}/{ref.repo}/commits/{ref.branch}")
        return commit["sha"]

    async def pull(self, stream: str, cursor: str | None) -> tuple[list[Record], str | None]:
        """cursor is the last-indexed commit SHA (None on first pull, which is a
        full tree read rather than a diff). Returns one Record per file changed
        since that SHA, and the new HEAD SHA to store as the next cursor."""
        ref = self._by_stream[stream]
        head = await self.head(stream)
        self.full_reads.discard(stream)
        if cursor == head:
            return [], head           # nothing moved; no tree read at all

        if cursor:
            changed = await self._compare(ref, cursor, head)
            if changed is not None:
                return changed, head
            # Too many files to diff, or a cursor this repo no longer contains
            # (force-push, rebase). Re-reading the tree is idempotent by content
            # hash; refusing to index is not recoverable without an operator.
        records = await self._whole_tree(ref, head)
        self.full_reads.add(stream)
        return records, head

    async def _compare(self, ref: RepoRef, base: str, head: str) -> list[Record] | None:
        """Files changed between two commits, or None when a diff is not the
        cheaper read after all and the caller should fall back to the tree."""
        try:
            diff = await self._json(
                f"/repos/{ref.org}/{ref.repo}/compare/{base}...{head}")
        except RateLimited:
            raise
        except GitHubError:
            return None               # unknown base — force-pushed or rebased
        files = diff.get("files") or []
        if len(files) >= COMPARE_FILE_LIMIT or diff.get("truncated"):
            return None

        records: list[Record] = []
        for entry in files:
            path = entry.get("filename") or ""
            status = entry.get("status")
            # code_file is keyed by (repo, path), so a rename is genuinely a
            # delete plus a write rather than an update of one row.
            previous = entry.get("previous_filename")
            if status == "renamed" and previous and _indexable(previous):
                records.append(_tombstone(ref, previous, head))
            if status == "removed":
                if _indexable(path):
                    records.append(_tombstone(ref, path, head))
                continue
            if not _indexable(path):
                continue
            body = await self._contents(ref, path, head)
            if body is not None:
                records.append(_record(ref, path, head, body))
        return records

    async def _whole_tree(self, ref: RepoRef, sha: str) -> list[Record]:
        """The whole repository at `sha`, from its tarball — one request.

        Streamed, never buffered: a monorepo's tarball is hundreds of megabytes,
        and reading one into a bytes object to hand to tarfile would hold all of
        it in memory at once for no benefit. `r|gz` is the non-seekable mode, so
        the archive is decompressed as it arrives and only one member is
        resident at a time.

        Members are read out of the stream rather than extracted to disk: there
        is nothing to clean up afterwards, and an archive cannot write outside a
        directory it is never unpacked into — which is the whole class of
        tar-path-traversal bugs, avoided by construction rather than by
        sanitising names.
        """
        return await asyncio.to_thread(
            self._read_tarball, ref, f"/repos/{ref.org}/{ref.repo}/tarball/{sha}", sha)

    def _read_tarball(self, ref: RepoRef, path: str, sha: str) -> list[Record]:
        records: list[Record] = []
        with self._open(path) as response, \
                tarfile.open(fileobj=response, mode="r|gz") as archive:
            for member in archive:
                if not member.isfile() or member.size > MAX_FILE_BYTES:
                    continue
                # GitHub wraps everything in "<org>-<repo>-<sha>/".
                entry = member.name.split("/", 1)[-1]
                if not entry or not _indexable(entry):
                    continue
                handle = archive.extractfile(member)
                if handle is None:
                    continue
                blob = handle.read()
                if b"\0" in blob[:8000]:
                    continue          # binary that slipped the suffix allowlist
                records.append(_record(ref, entry, sha,
                                       blob.decode("utf-8", errors="replace")))
        return records

    async def _contents(self, ref: RepoRef, path: str, sha: str) -> str | None:
        """One file at one revision. Returns None for anything that should not
        reach the index rather than raising, so one unreadable file does not
        fail a pull."""
        from urllib.parse import quote

        try:
            payload = await self._json(
                f"/repos/{ref.org}/{ref.repo}/contents/{quote(path)}?ref={sha}")
        except RateLimited:
            raise
        except GitHubError:
            return None
        if payload.get("encoding") != "base64" or not payload.get("content"):
            # Over 1 MB comes back with an empty body and encoding "none"; it is
            # past MAX_FILE_BYTES anyway.
            return None
        blob = base64.b64decode(payload["content"])
        if len(blob) > MAX_FILE_BYTES or b"\0" in blob[:8000]:
            return None
        return blob.decode("utf-8", errors="replace")

    async def subscribe(self, hook: Callable[[Record], None]) -> None:
        raise NotImplementedError

    async def fetch(self, external_id: str) -> Record:
        """One file at its current version — repair, and code.query's fallback
        when a citation points at a chunk whose rev has moved on.

        `external_id` is "<org>/<repo>#<branch>:<path>".
        """
        stream, _, path = external_id.partition(":")
        ref = self._by_stream[stream]
        sha = await self.head(stream)
        body = await self._contents(ref, path, sha)
        if body is None:
            raise GitHubError(f"{external_id} is not readable at {sha}")
        return _record(ref, path, sha, body)

    async def pull_acls(self) -> list[ACL]:
        """Repo and branch read access (collaborators, team grants, visibility)
        as ACL tuples in this source's namespace. Crawled on aclcrawl.py's
        shorter, separate cadence — N1 rule 2 — never inferred from content.

        Still unimplemented. Until it lands, access is administered at the
        repository level: every file carries `RepoRef.acl_key` and a grant on
        that resource is what makes the repository readable. That is a strict
        subset of real GitHub permissions, so this landing later only ever
        widens reach — it cannot retroactively expose anything.
        """
        raise NotImplementedError

    # ── HTTP ─────────────────────────────────────────────────────────────

    async def _json(self, path: str) -> dict:
        raw = await asyncio.to_thread(self._get_bytes, path, True)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise GitHubError(f"{path}: unparseable response") from error

    def _get_bytes(self, path: str, want_json: bool = False) -> bytes:
        with self._open(path, want_json) as response:
            return response.read()

    def _open(self, path: str, want_json: bool = False):
        """The raw response, so a large body can be streamed rather than held."""
        headers = {
            "accept": "application/vnd.github+json" if want_json
                      else "application/vnd.github.raw",
            "user-agent": "commonindex-codequery",
            "x-github-api-version": "2022-11-28",
        }
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        try:
            return urlopen(Request(f"{API}{path}", headers=headers), timeout=120)
        except HTTPError as error:
            # 403 and 429 both carry the rate-limit headers; only a zero
            # remaining budget actually means throttled, and a 403 for a private
            # repository must not be reported as "wait and retry".
            if error.code in (403, 429) and error.headers.get("x-ratelimit-remaining") == "0":
                raise RateLimited(
                    f"github rate limit exhausted; resets at "
                    f"{error.headers.get('x-ratelimit-reset', 'unknown')}") from error
            detail = "set CODEQUERY_GITHUB_TOKEN" if error.code in (401, 403) else ""
            raise GitHubError(f"github {path} returned {error.code} {detail}".strip()) from error
        except (URLError, TimeoutError) as error:
            raise GitHubError(f"github {path}: {error}") from error


def _record(ref: RepoRef, path: str, sha: str, body: str) -> Record:
    return Record(id=path, stream=ref.stream_name,
                  props={"path": path, "sha": sha, "size": len(body),
                         "language": _language_of(path), "body": body})


def _tombstone(ref: RepoRef, path: str, sha: str) -> Record:
    return Record(id=path, stream=ref.stream_name, deleted=True,
                  props={"path": path, "sha": sha})


def _indexable(path: str) -> bool:
    """Deferred to localgit so both connectors agree on what counts as source.
    Two definitions would mean a repository's contents changed depending on
    which connector read it."""
    from .localgit import indexable

    return indexable(path)


def _language_of(path: str) -> str | None:
    from .localgit import language_of

    return language_of(path)


def _max_file_bytes() -> int:
    from .localgit import MAX_FILE_BYTES as limit

    return limit


MAX_FILE_BYTES = _max_file_bytes()
