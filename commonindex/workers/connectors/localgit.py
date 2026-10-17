"""A clone on disk, on the same ingestion contract as the API connectors.

Not a test double. Zoekt indexes a git directory natively, an enterprise's
repositories are cloned somewhere regardless, and any self-hosted git
server is reachable by clone long before anyone writes an API connector for
it — so reading a working copy is a real source, and it is the one that makes
the rest of Code Query demonstrable without a network round trip.

`pull`'s cursor is the last-indexed commit SHA, exactly as git.py defines it, so
the two connectors resume identically and the repo's own history remains the
resumability mechanism. An unknown cursor — history rewritten, branch
force-pushed, shallow clone — degrades to a full re-read rather than raising:
re-reading is idempotent by content hash, and refusing to index is the worse
failure.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import ACL, Record, Stream
from .git import RepoRef

#: What counts as source. An allowlist rather than a denylist: the cost of
#: missing a language is a follow-up commit, the cost of indexing a 40 MB
#: vendored bundle is a corpus nobody can search.
SUFFIXES = {".c", ".cc", ".cfg", ".cpp", ".cs", ".css", ".go", ".h", ".hpp",
            ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".md",
            ".php", ".proto", ".py", ".pyi", ".rb", ".rs", ".rst", ".scala",
            ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue",
            ".yaml", ".yml",
            # Build, infra and schema files are where "how is it built / what
            # is the table" is answered; a large repository's database schema
            # and Dockerfiles were missing.
            ".bazel", ".bzl", ".cql", ".dockerfile", ".gql", ".graphql", ".hcl", ".mk",
            ".tf", ".tmpl"}
#: Source files known by name rather than suffix.
NAMES = {"Makefile", "makefile", "GNUmakefile", "Dockerfile", "Containerfile",
         "Justfile", "BUILD", "WORKSPACE", "Jenkinsfile", "Procfile"}
EXCLUDED_NAMES = {".env", "package-lock.json", "pnpm-lock.yaml", "uv.lock",
                  "yarn.lock", "Cargo.lock", "poetry.lock", "go.sum"}
#: Zoekt indexes files up to 2 MB, so a lower limit here meant real matches
#: (a large repository's 270 KB handler tests) found by search and then dropped as "not
#: indexed". 1 MB keeps generated bundles out.
MAX_FILE_BYTES = 1_000_000


def _rules() -> str:
    """What decides which files are indexed, as one short fingerprint. Stored
    beside a repository's cursor: when it changes, the next index reads the
    whole tree instead of only what changed since the last commit — a widened
    allowlist otherwise never reached files untouched since."""
    import hashlib

    spec = repr((sorted(SUFFIXES), sorted(NAMES), sorted(EXCLUDED_NAMES), MAX_FILE_BYTES))
    return hashlib.sha256(spec.encode()).hexdigest()[:12]


RULES = _rules()

LANGUAGES = {".py": "python", ".pyi": "python", ".ts": "typescript", ".tsx": "tsx",
             ".js": "javascript", ".jsx": "jsx", ".go": "go", ".rs": "rust",
             ".java": "java", ".rb": "ruby", ".kt": "kotlin", ".scala": "scala",
             ".swift": "swift", ".sh": "shell", ".sql": "sql", ".css": "css",
             ".html": "html", ".vue": "vue", ".json": "json", ".yaml": "yaml",
             ".yml": "yaml", ".toml": "toml", ".ini": "ini", ".cfg": "ini",
             ".proto": "protobuf", ".c": "c", ".h": "c", ".cc": "cpp",
             ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php",
             ".md": "markdown", ".rst": "restructuredtext", ".txt": "text",
             ".cql": "sql", ".dockerfile": "dockerfile", ".mk": "makefile", ".hcl": "hcl",
             ".tf": "hcl", ".graphql": "graphql", ".gql": "graphql", ".bzl": "starlark",
             ".bazel": "starlark", ".tmpl": "text"}


@dataclass(slots=True)
class LocalRepo:
    """A configured clone. `ref` is identity — the same RepoRef the GitHub
    connector uses, so a repo indexed from disk today and from the API later
    keeps its object ids and, with them, its grants."""

    ref: RepoRef
    path: Path


def language_of(path: str) -> str | None:
    name = Path(path).name
    if name in NAMES:
        return "dockerfile" if name in ("Dockerfile", "Containerfile") else "makefile" if "akefile" in name else None
    return LANGUAGES.get(Path(path).suffix.lower())


def indexable(path: str) -> bool:
    name = Path(path).name
    return (name in NAMES or Path(path).suffix.lower() in SUFFIXES) and name not in EXCLUDED_NAMES


class GitError(RuntimeError):
    """git itself failed — not a missing revision, which callers handle."""


#: git@host:example/storefront.git · https://host/example/storefront.git · ssh://…
_REMOTE = re.compile(r"[:/](?P<org>[^/:]+)/(?P<repo>[^/]+?)(?:\.git)?/?$")


async def ref_for(path: Path, *, space_id: str = "pay") -> RepoRef:
    """Derive a repo's identity from the clone itself.

    Taken from `origin` rather than from the directory name so that a repo
    indexed from disk today and through the GitHub connector tomorrow resolves
    to the SAME `repo_id` — and therefore the same object ids and the same
    grants. Deriving identity from the checkout path instead would silently
    fork the repo in two the first time someone ran the API connector, and the
    symptom would be a user who could no longer read code they were granted.

    A clone with no remote falls back to org "local" and the directory name.
    """
    try:
        remote = (await _git(path, "remote", "get-url", "origin")).strip()
    except GitError:
        remote = ""
    match = _REMOTE.search(remote) if remote else None
    org = match.group("org") if match else "local"
    repo = match.group("repo") if match else path.resolve().name
    branch = (await _git(path, "rev-parse", "--abbrev-ref", "HEAD")).strip()
    return RepoRef(org=org, repo=repo, branch=branch, space_id=space_id,
                   provider="github" if match else "local")


async def _git(repo: Path, *args: str) -> str:
    """One git invocation. `-c core.quotepath=false` so a non-ASCII path comes
    back as itself rather than as escapes that no longer match the file."""
    proc = await asyncio.create_subprocess_exec(
        "git", "-C", str(repo), "-c", "core.quotepath=false", *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {err.decode(errors='replace').strip()}")
    return out.decode(errors="replace")


class Connector:
    """Implements the shared five. `subscribe` stays unimplemented for the same
    reason git.py's does — the trigger is a scheduled pass, not a hook."""

    def __init__(self, repos: list[LocalRepo]) -> None:
        self._repos = repos
        self._by_stream = {r.ref.stream_name: r for r in repos}
        #: Streams whose last pull read the whole tree, as in git.py.
        self.full_reads: set[str] = set()

    async def discover(self) -> list[Stream]:
        return [Stream(name=r.ref.stream_name, canonical_type="code_file")
                for r in self._repos]

    async def head(self, stream: str) -> str:
        repo = self._by_stream[stream]
        return (await _git(repo.path, "rev-parse", repo.ref.branch)).strip()

    async def pull(self, stream: str, cursor: str | None) -> tuple[list[Record], str | None]:
        """Files changed since `cursor`, plus the new HEAD to store as the next
        one. A first pull (cursor None) reads the whole tree."""
        repo = self._by_stream[stream]
        head = await self.head(stream)
        self.full_reads.discard(stream)

        if cursor and cursor != head and await self._has_revision(repo.path, cursor):
            paths, deleted = await self._changed_since(repo.path, cursor, head)
        elif cursor == head:
            return [], head          # nothing moved; not even a tree read
        else:
            paths, deleted = await self._tree(repo.path, head), []
            self.full_reads.add(stream)

        records = [r for r in
                   [await self._record(repo, path, head) for path in paths]
                   if r is not None]
        records += [Record(id=path, stream=stream, deleted=True,
                           props={"path": path, "sha": head})
                    for path in deleted]
        return records, head

    async def _has_revision(self, path: Path, rev: str) -> bool:
        """A cursor from before a force-push or outside a shallow clone is not
        an error — it is a cursor we cannot diff from, and the answer is a full
        re-read."""
        try:
            await _git(path, "cat-file", "-e", f"{rev}^{{commit}}")
        except GitError:
            return False
        return True

    async def _tree(self, path: Path, rev: str) -> list[str]:
        out = await _git(path, "ls-tree", "-r", "--name-only", rev)
        return [p for p in out.splitlines() if p and indexable(p)]

    async def _changed_since(self, path: Path, cursor: str,
                             head: str) -> tuple[list[str], list[str]]:
        """--name-status over the range. A rename arrives as R<score> old new
        and is recorded as a delete of the old path plus a write of the new —
        the file object is keyed by (repo, path), so a rename genuinely is one
        of each rather than an update."""
        out = await _git(path, "diff", "--name-status", "-M",
                         f"{cursor}..{head}")
        changed: list[str] = []
        deleted: list[str] = []
        for line in out.splitlines():
            if not line:
                continue
            parts = line.split("\t")
            status = parts[0]
            if status.startswith("R") and len(parts) >= 3:
                old, new = parts[1], parts[2]
                if indexable(old):
                    deleted.append(old)
                if indexable(new):
                    changed.append(new)
            elif len(parts) >= 2 and indexable(parts[1]):
                (deleted if status.startswith("D") else changed).append(parts[1])
        return changed, deleted

    async def _record(self, repo: LocalRepo, path: str, rev: str) -> Record | None:
        """Read one blob at `rev`. Returns None for anything that should not
        reach the index — oversized, or binary."""
        try:
            raw = await _git_bytes(repo.path, "show", f"{rev}:{path}")
        except GitError:
            return None              # vanished between listing and read
        if len(raw) > MAX_FILE_BYTES or b"\0" in raw[:8000]:
            return None
        body = raw.decode("utf-8", errors="replace")
        return Record(
            id=path, stream=repo.ref.stream_name,
            props={"path": path, "sha": rev, "size": len(raw),
                   "language": language_of(path), "body": body},
        )

    async def subscribe(self, hook: Callable[[Record], None]) -> None:
        raise NotImplementedError

    async def fetch(self, external_id: str) -> Record:
        raise NotImplementedError

    async def pull_acls(self) -> list[ACL]:
        """A clone carries no permission model of its own — the filesystem's is
        the operator's, not the source's. Repo-level access is administered as
        a grant on the repo object instead (see RepoRef.acl_key), so this
        returns nothing rather than inventing an authority it does not have."""
        return []


async def _git_bytes(repo: Path, *args: str) -> bytes:
    """`git show` on a blob, kept as bytes — decoding before the binary check
    would turn a PNG into replacement characters and index it as text."""
    proc = await asyncio.create_subprocess_exec(
        "git", "-C", str(repo), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {err.decode(errors='replace').strip()}")
    return out
