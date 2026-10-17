"""Index a repository into Code query from the page.

Indexing was a terminal command — `make code-index REPOS=…` — so Code query
was a dead end for anyone without one: the page said nothing was indexed and
offered a command. This starts the same indexing from the page: the connector,
per-repo transaction, tombstones and read grant that `scripts/index_repos.py`
uses (one function, `index_local`), run in the gateway's background, with its
progress kept where the page reads it.

A repository arrives one of two ways:

* **a URL** — any https git remote the caller can read: a public repository,
  or a private one with an access token. The gateway keeps a shallow clone of
  it under COMMONINDEX_CODE_CLONES and indexes that. The token is never logged
  or written into the clone's remote; it is kept only encrypted, for the
  scheduled re-index (commonindex/workers/coderefresh.py).
* **a folder** on the gateway's own machine — only under a folder the operator
  listed in COMMONINDEX_CODE_ROOTS, because which parts of a disk become searchable
  is the operator's decision, not any admin's.

Either way indexing is an admin's act: it makes code readable in the space.

Postgres is written first, then the Zoekt shard (when COMMONINDEX_ZOEKT_URL is
set), the same two stores `make code-index` writes — a repository the page
indexed into Postgres alone was reported as "not yet in Zoekt's index" and
dropped from every search until somebody ran the Makefile.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()

ROOT = Path(__file__).resolve().parent.parent.parent
CLONE_TIMEOUT_SECONDS = 600

#: Indexing runs as a job (commonindex/workers/jobs.py): its progress is a row
#: every gateway can read, and a restart does not lose it halfway.


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "field": field}})


def roots() -> list[Path]:
    """The folders clones may be indexed from, as the operator listed them."""
    listed = os.environ.get("COMMONINDEX_CODE_ROOTS", "")
    return [Path(r).expanduser().resolve() for r in listed.split(os.pathsep) if r.strip()]


def clones_dir() -> Path:
    """Where clones of URL-indexed repositories are kept between indexes."""
    return Path(os.environ.get("COMMONINDEX_CODE_CLONES") or ROOT / ".code-clones").resolve()


async def jobs(pool, space: str) -> list[dict[str, Any]]:
    """What the page is waiting on, newest first — finished ones only if they
    failed in the last day."""
    rows = await pool.fetch(
        "select id, state, progress, error, created_at, finished_at from jobs"
        " where kind = 'code_index' and space_id = $1"
        "   and (state in ('queued', 'running') or (state = 'failed' and finished_at > now() - interval '1 day'))"
        " order by created_at desc limit 50", space)
    out = []
    for r in rows:
        p = r["progress"] if isinstance(r["progress"], dict) else json.loads(r["progress"] or "{}")
        out.append({**p, "state": "failed" if r["state"] == "failed" else "indexing",
                    "error": r["error"], "started_at": r["created_at"].isoformat(),
                    "finished_at": r["finished_at"].isoformat() if r["finished_at"] else None})
    return out


class CloneError(RuntimeError):
    """A clone or fetch that failed, with the reason git gave — token removed."""


def parse_url(raw: str) -> tuple[str, Path]:
    """The canonical https URL and where its clone lives, or ValueError.

    `github.com/org/repo` is taken as https. Credentials in the URL are refused
    rather than stripped: they would be written into the clone's remote and
    from there into every error message, so the token goes in its own field.
    """
    from commonindex.adapters.model import check_base_url

    text = raw.strip()
    if "://" not in text:
        text = "https://" + text
    u = urlsplit(text)
    if u.scheme != "https":
        raise ValueError("only https repository URLs can be indexed")
    if u.username or u.password:
        raise ValueError("put the access token in its own field, not in the URL")
    if u.query or u.fragment:
        raise ValueError("a repository URL has no query or fragment")
    parts = [p for p in u.path.split("/") if p]
    if parts and parts[-1].endswith(".git"):
        parts[-1] = parts[-1][:-4]
    if len(parts) < 2 or any(p in (".", "..") for p in parts):
        raise ValueError("a repository URL names an owner and a repository, "
                         "like https://github.com/org/repo")
    host = (u.hostname or "").lower()
    # The gateway dials this, from inside the network: an internal address
    # would make indexing a way to read it.
    check_base_url(f"https://{host}")
    canonical = f"https://{host}{f':{u.port}' if u.port else ''}/{'/'.join(parts)}.git"
    return canonical, clones_dir() / host / Path(*parts)


def _git_env(token: str | None) -> dict[str, str]:
    """An environment for git that reaches only the URL it was given.

    The operator's own git config is shut out — a credential helper there would
    clone a private repository with the OPERATOR's access rather than the
    caller's. The token rides in a header set through the environment, so it is
    in neither argv (visible to every process) nor the remote URL.
    """
    config = [("http.followRedirects", "false"), ("credential.helper", "")]
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        config.append(("http.extraHeader", f"Authorization: Basic {basic}"))
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(clones_dir()),
           "GIT_TERMINAL_PROMPT": "0", "GIT_ALLOW_PROTOCOL": "https",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_CONFIG_COUNT": str(len(config))}
    for i, (key, value) in enumerate(config):
        env[f"GIT_CONFIG_KEY_{i}"], env[f"GIT_CONFIG_VALUE_{i}"] = key, value
    return env


async def _git(args: list[str], token: str | None) -> None:
    proc = await asyncio.create_subprocess_exec(
        "git", *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        env=_git_env(token))
    try:
        _, err = await asyncio.wait_for(proc.communicate(), CLONE_TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        raise CloneError(f"git {args[0]} took longer than {CLONE_TIMEOUT_SECONDS}s") from None
    if proc.returncode != 0:
        said = err.decode(errors="replace").strip()
        if token:
            said = said.replace(token, "***")
        if "could not read Username" in said or "Authentication failed" in said:
            said = ("the repository needs credentials — it is private or does not exist. "
                    "Add an access token that can read it.")
        raise CloneError(said.splitlines()[-1][:300] if said else f"git {args[0]} failed")


async def fetch_clone(url: str, dest: Path, branch: str | None, token: str | None) -> None:
    """A shallow clone of `branch` (the default branch when None) at `dest`,
    created or brought up to date.

    Shallow is enough: the connector reads one tree, and on a re-index it diffs
    the previous head against the new one — both trees are present, because a
    shallow fetch keeps the objects it already had.
    """
    if (dest / ".git").exists():
        await _git(["-C", str(dest), "fetch", "-q", "--depth", "1", "origin",
                    branch or "HEAD"], token)
        if branch:
            await _git(["-C", str(dest), "checkout", "-q", "-B", branch, "FETCH_HEAD"], token)
        else:
            await _git(["-C", str(dest), "reset", "-q", "--hard", "FETCH_HEAD"], token)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".partial")
    shutil.rmtree(partial, ignore_errors=True)
    try:
        await _git(["clone", "-q", "--depth", "1", "--single-branch",
                    *(["--branch", branch] if branch else []), "--", url, str(partial)], token)
        partial.rename(dest)
    finally:
        shutil.rmtree(partial, ignore_errors=True)


async def run_index(pool, job_id: str, path: Path, space: str, actor: str, *,
                    url: str | None = None, branch: str | None = None,
                    token: str | None = None, refresh: bool = False,
                    keep_token: bool = True) -> None:
    """The job: clone if it came from a URL, index into Postgres, then build
    the Zoekt shard — reporting each step on the job's row. A first index also
    records the source, so coderefresh.py indexes it again on a schedule."""
    from commonindex.workers.codequery import index_local
    from commonindex.workers.coderefresh import remember
    from commonindex.workers.jobs import report
    from commonindex.workers.zoektindex import ShardUnavailable, build_shard

    try:
        if url:
            await report(pool, job_id, step="cloning")
            await fetch_clone(url, path, branch, token)
        await report(pool, job_id, step="indexing")
        result = await index_local(pool, path, space_id=space, actor_id=actor, grant=not refresh)
        await report(pool, job_id, repo=result["repo"], result=result)
        if not refresh:
            await remember(pool, space=space, key=url or str(path), path=str(path), url=url,
                           branch=branch, actor=actor, token=token, keep_token=keep_token)
        if os.environ.get("COMMONINDEX_ZOEKT_URL", "").strip():
            await report(pool, job_id, step="building the search index")
            try:
                await build_shard(path, result["branch"])
                await report(pool, job_id, zoekt="built")
            except ShardUnavailable as why:
                # The sidecar in docker-compose.prod.yml builds shards from the
                # clones; without one, say what is missing.
                if not os.environ.get("COMMONINDEX_ZOEKT_SIDECAR"):
                    raise RuntimeError(f"indexed, but not into Zoekt: {why}") from None
                await report(pool, job_id, zoekt="queued for the indexer")
        await report(pool, job_id, step=None)
    except Exception as error:  # noqa: BLE001 — said on the job, not swallowed
        detail = str(error) if isinstance(error, CloneError | RuntimeError) else \
            f"{type(error).__name__}: {error}"
        raise RuntimeError(detail.replace(token, "***") if token else detail) from None


@router.post("/api/v1/code.index")
async def code_index(req: Request):
    """Start indexing a repository URL or a local clone; progress shows in
    `code.list_repos`."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    if not str(body.get("idempotencyKey") or "").strip():
        return _error(422, "missing_idempotency_key",
                      "a mutation needs an idempotency key so a retry after a timeout does not "
                      "write twice", "idempotencyKey")
    raw_url = str(body.get("url") or "").strip()
    raw = str(body.get("path") or "").strip()
    if raw_url and raw:
        return _error(422, "url_or_path", "give a repository URL or a folder, not both", "url")
    branch = str(body.get("branch") or "").strip() or None
    if branch and (branch.startswith("-") or ".." in branch or " " in branch):
        return _error(422, "bad_branch", f"{branch!r} is not a branch name", "branch")
    token = str(body.get("token") or "").strip() or None
    keep_token = body.get("keep_token", True) is not False

    if raw_url:
        from commonindex.adapters.model import Blocked

        try:
            url, path = parse_url(raw_url)
        except (ValueError, Blocked) as why:
            return _error(422, "bad_url", str(why), "url")
        key, label = url, url.removeprefix("https://").removesuffix(".git")
    else:
        if token:
            return _error(422, "token_without_url", "a token is for cloning a URL", "token")
        allowed = roots()
        if not raw:
            return _error(422, "no_source", "give a repository URL to index — "
                                            "https://github.com/org/repo", "url")
        if not allowed:
            return _error(422, "indexing_off",
                          "indexing folders from the app is off on this gateway: give a "
                          "repository URL, or set COMMONINDEX_CODE_ROOTS to the folders clones "
                          "may be indexed from", "path")
        path = Path(raw).expanduser().resolve()
        if not any(path == root or path.is_relative_to(root) for root in allowed):
            return _error(403, "outside_roots",
                          f"{path} is not under a folder this gateway indexes from "
                          f"({', '.join(str(r) for r in allowed)})", "path")
        if not (path / ".git").exists():
            return _error(422, "not_a_clone", f"{path} is not a git clone — there is no .git in it",
                          "path")
        key, label, url = str(path), path.name, None

    from commonindex.workers.jobs import NoWayToKeepSecret, enqueue

    pool = req.app.state.commonindex["pool"]
    space = space_of(req, body)
    progress = {"path": label, "repo": label, "source": "url" if url else "path",
                "step": "queued", "zoekt": None, "result": None}
    async with pool.acquire() as conn, conn.transaction():
        # One at a time per repository, across every gateway.
        await conn.execute("select pg_advisory_xact_lock(hashtext($1))", "code_index:" + key)
        running = await conn.fetchrow(
            "select id from jobs where kind = 'code_index' and key = $1 and state in ('queued', 'running')", key)
        if running:
            return {"job": {**progress, "state": "indexing"}, "already": True}
        try:
            await enqueue(conn, "code_index", {"path": str(path), "space": space, "actor": actor_of(req),
                                               "url": url, "branch": branch, "keep_token": keep_token},
                          key=key, space=space, secret=token, progress=progress)
        except NoWayToKeepSecret as e:
            return _error(409, "no_secret_key", str(e), "token")
    return {"job": {**progress, "state": "indexing", "started_at": datetime.now(tz=UTC).isoformat(),
                    "finished_at": None, "error": None}, "already": False}
