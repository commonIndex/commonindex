"""Background work, out of the web server: a queue in Postgres and a worker.

Video renders, page snapshots and code indexing ran as tasks inside the
gateway: a restart lost them halfway, a render competed with every request
for the same process, and code indexing kept its progress in that process's
memory — so another gateway, or the same one after a restart, could not say
what was happening.

Now the gateway queues a job (a row in `jobs`) and a worker runs it:

* **Claimed once.** `FOR UPDATE SKIP LOCKED`: any number of workers, and no
  job runs twice at once.
* **Survives a restart.** A job left `running` past its kind's time limit is
  put back in the queue (or failed, past its attempts).
* **Progress is a row**, readable from any gateway.
* **Woken, not polled.** A queued job is announced (`pg_notify`); the worker
  also looks every few seconds in case it missed one.
* **Secrets are not kept.** A job that needs one (a token to clone a private
  repository) carries it encrypted with COMMONINDEX_SECRET_KEY, and it is wiped
  when the job ends — or, with no key and the worker in this process, it never
  leaves memory.

The worker runs inside the gateway unless COMMONINDEX_WORKER=external, so a
laptop needs nothing more; a deployment runs `python -m commonindex.workers.jobs`
as its own service (docker-compose.prod.yml).

    COMMONINDEX_DSN=… python -m commonindex.workers.jobs
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

CHANNEL = "commonindex_jobs"


@dataclass(frozen=True, slots=True)
class Kind:
    run: Callable[..., Awaitable[None]]
    #: Seconds a job may run before it is taken to have died with its worker.
    timeout: float
    #: How many of this kind one worker runs at once.
    at_once: int = 2
    #: Tries before a job that keeps dying is failed for good.
    attempts: int = 2


#: In this process only: secrets for jobs this process queued and will run,
#: when there is no key to store them encrypted.
_SECRETS: dict[str, str] = {}


def inline() -> bool:
    """Whether the gateway runs the worker itself."""
    return (os.environ.get("COMMONINDEX_WORKER") or "inline").strip().lower() != "external"


def _seal(value: str) -> bytes | None:
    from commonindex.gateway.secrets import MissingKey, _fernet

    try:
        return _fernet().encrypt(value.encode())
    except MissingKey:
        return None


def _open(value: bytes | None) -> str | None:
    if value is None:
        return None
    from commonindex.gateway.secrets import _fernet

    return _fernet().decrypt(bytes(value)).decode()


class NoWayToKeepSecret(RuntimeError):
    """A job needs a secret, there is no key to store it, and another process runs jobs."""


async def enqueue(conn, kind: str, payload: dict[str, Any], *, key: str | None = None,
                  space: str | None = None, secret: str | None = None,
                  progress: dict[str, Any] | None = None, actor: str | None = None) -> str:
    """Queue a job and wake a worker. Inside a transaction, it is seen on commit."""
    job_id = "job-" + secrets.token_hex(8)
    sealed = None
    if secret:
        sealed = _seal(secret)
        if sealed is None:
            if not inline():
                raise NoWayToKeepSecret(
                    "set COMMONINDEX_SECRET_KEY: a separate worker needs this token, and without the "
                    "key it cannot be passed to it encrypted")
            _SECRETS[job_id] = secret
    await conn.execute(
        "insert into jobs (id, kind, key, space_id, payload, secret, progress, max_attempts, actor_id)"
        " values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)",
        job_id, kind, key, space, json.dumps(payload), sealed, json.dumps(progress or {}),
        KINDS[kind].attempts if kind in KINDS else 1, actor)
    await conn.execute("select pg_notify($1, $2)", CHANNEL, kind)
    return job_id


async def report(pool, job_id: str, **progress: Any) -> None:
    """Record how far a job has got, for whoever is watching it."""
    await pool.execute("update jobs set progress = progress || $2::jsonb where id = $1",
                       job_id, json.dumps(progress, default=str))


# ── the kinds ─────────────────────────────────────────────────────────────


async def _render(pool, job: dict[str, Any], secret: str | None) -> None:
    from commonindex.gateway.videos import run_render

    p = job["payload"]
    await run_render(pool, p["video_id"], p["composition"], p["format"], p["actor"], p["job"])


async def _snapshot(pool, job: dict[str, Any], secret: str | None) -> None:
    from commonindex.gateway.artifacts import run_snapshot

    p = job["payload"]
    await run_snapshot(pool, p["artifact_id"], p["html"], p["height"], p["job"])


async def _code_index(pool, job: dict[str, Any], secret: str | None) -> None:
    from pathlib import Path

    from commonindex.gateway.codeindex import run_index

    p = job["payload"]
    await run_index(pool, job["id"], Path(p["path"]), p["space"], p["actor"],
                    url=p.get("url"), branch=p.get("branch"), token=secret,
                    refresh=bool(p.get("refresh")), keep_token=p.get("keep_token", True) is not False)


async def _op(pool, job: dict[str, Any], secret: str | None) -> None:
    from commonindex.gateway.async_ops import run_op

    await run_op(pool, job)


KINDS: dict[str, Kind] = {
    # An operation asked for asynchronously — a model call, mostly.
    "op": Kind(_op, timeout=1800, at_once=4, attempts=1),
    # Renders run one at a time: each drives a browser and an encoder.
    "render": Kind(_render, timeout=660, at_once=1, attempts=1),
    "snapshot": Kind(_snapshot, timeout=120, at_once=2, attempts=2),
    "code_index": Kind(_code_index, timeout=1800, at_once=1, attempts=1),
}


# ── the worker ────────────────────────────────────────────────────────────


async def _reap(pool) -> None:
    """Jobs whose worker died: back in the queue, or failed past their attempts."""
    for name, kind in KINDS.items():
        await pool.execute(
            "update jobs set state = case when attempts < max_attempts then 'queued' else 'failed' end,"
            " error = case when attempts < max_attempts then error"
            "              else 'stopped: its worker did not finish it in time' end,"
            " finished_at = case when attempts < max_attempts then null else now() end,"
            " secret = case when attempts < max_attempts then secret else null end,"
            " locked_at = null"
            " where kind = $1 and state = 'running' and locked_at < now() - make_interval(secs => $2)",
            name, kind.timeout)


async def _claim(pool, kind: str, worker: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "update jobs set state = 'running', locked_at = now(), worker = $2, attempts = attempts + 1"
        " where id = (select id from jobs where kind = $1 and state = 'queued' and run_after <= now()"
        "             order by created_at for update skip locked limit 1)"
        " returning id, kind, payload, secret, attempts", kind, worker)
    if row is None:
        return None
    payload = row["payload"]
    return {"id": row["id"], "kind": row["kind"], "attempts": row["attempts"],
            "payload": json.loads(payload) if isinstance(payload, str) else payload,
            "secret": row["secret"]}


async def _run_one(pool, job: dict[str, Any]) -> None:
    secret = _SECRETS.pop(job["id"], None)
    try:
        secret = secret or _open(job["secret"])
        await KINDS[job["kind"]].run(pool, job, secret)
    except Exception as e:  # noqa: BLE001 - said on the job, never fatal to the worker
        detail = f"{type(e).__name__}: {e}"
        if secret:
            detail = detail.replace(secret, "***")
        log.warning("job %s (%s) failed: %s", job["id"], job["kind"], detail)
        await pool.execute("update jobs set state = 'failed', error = $2, finished_at = now(), secret = null"
                           " where id = $1", job["id"], detail[:2000])
        return
    await pool.execute("update jobs set state = 'done', finished_at = now(), secret = null"
                       " where id = $1 and state = 'running'", job["id"])


async def drain(pool, kinds: tuple[str, ...] | None = None) -> int:
    """Run every queued job now, one after another, until none is left — for
    tests and one-off scripts, which have no worker running. Returns how many."""
    ran = 0
    while True:
        job = None
        for kind in kinds or tuple(KINDS):
            job = await _claim(pool, kind, "drain")
            if job:
                break
        if job is None:
            return ran
        await _run_one(pool, job)
        ran += 1


async def work(pool, dsn: str, *, name: str | None = None, every: float = 3.0) -> None:
    """Run jobs for as long as the process does."""
    import asyncpg

    worker = name or f"{socket.gethostname()}:{os.getpid()}"
    wake = asyncio.Event()
    listener = None
    try:
        listener = await asyncpg.connect(dsn)
        await listener.add_listener(CHANNEL, lambda *_: wake.set())
    except Exception as e:  # noqa: BLE001 - polling still runs every job
        log.warning("job worker could not listen (%r); polling every %ss", e, every)
    running: dict[str, set[asyncio.Task]] = {k: set() for k in KINDS}
    log.info("job worker %s started", worker)
    from commonindex.workers.coderefresh import queue_due

    next_refresh = 0.0
    try:
        while True:
            try:
                await _reap(pool)
                # Repositories indexed from the page, indexed again when due.
                # Looked for once a minute; the interval itself is per source.
                if asyncio.get_running_loop().time() >= next_refresh:
                    next_refresh = asyncio.get_running_loop().time() + 60
                    await queue_due(pool)
                for kind, spec in KINDS.items():
                    while len(running[kind]) < spec.at_once:
                        job = await _claim(pool, kind, worker)
                        if job is None:
                            break
                        task = asyncio.get_running_loop().create_task(_run_one(pool, job))
                        running[kind].add(task)
                        task.add_done_callback(running[kind].discard)
                        task.add_done_callback(lambda _t: wake.set())
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - a bad pass is retried
                log.warning("job worker pass failed: %r", e)
            wake.clear()
            try:
                await asyncio.wait_for(wake.wait(), every)
            except TimeoutError:
                pass
    finally:
        for tasks in running.values():
            for t in tasks:
                t.cancel()
        if listener is not None:
            await listener.close()


async def _main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    dsn = os.environ["COMMONINDEX_DSN"]
    # The gateway's own state — its pool, model client and permission checker —
    # because an operation run here is the gateway's handler, run as its
    # caller. This process is the worker, so the app must not start another.
    os.environ["COMMONINDEX_WORKER"] = "external"
    os.environ["COMMONINDEX_JOB_PROCESS"] = "1"
    from commonindex.gateway.app import app

    async with app.router.lifespan_context(app):
        await work(app.state.commonindex["pool"], dsn)


if __name__ == "__main__":
    asyncio.run(_main())
