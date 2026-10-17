"""Build a clone's Zoekt shard, the half of indexing `make code-index` did by hand.

Postgres and Zoekt answer the same question from two stores, and a repository
indexed from the page used to land in only one of them: `code.search` then
reported it as "not yet in Zoekt's index" until somebody ran a terminal
command. This builds the shard the same way the Makefile does —
`zoekt-git-index` over the clone, which names the repository from its remote —
so whatever the page indexes is searchable in both.

Two ways to run the indexer, tried in order:

* a `zoekt-git-index` binary on PATH, writing to COMMONINDEX_ZOEKT_INDEX_DIR — how
  a deployment that ships the binary beside the gateway runs it;
* the indexer image under Docker, writing into the volume the webserver
  serves (COMMONINDEX_ZOEKT_VOLUME) — how `docker compose up zoekt` runs locally.

With neither, nothing is built and the caller is told why: the repository is
still searchable through Postgres, and search says so in `degraded`.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

#: The volume `docker-compose.yml` mounts at the webserver's /data/index. The
#: compose file pins the project name, so this is the same on every machine.
DEFAULT_VOLUME = "commonindex_zoekt-index"
DEFAULT_IMAGE = "sourcegraph/zoekt-indexserver:latest"
TIMEOUT_SECONDS = 600


class ShardUnavailable(RuntimeError):
    """No way to build a shard on this machine — not a failed index."""


def _command(clone: Path, branch: str) -> list[str]:
    binary = shutil.which("zoekt-git-index")
    index_dir = os.environ.get("COMMONINDEX_ZOEKT_INDEX_DIR", "").strip()
    if binary and index_dir:
        return [binary, "-index", index_dir, "-branches", branch, str(clone)]
    if shutil.which("docker"):
        volume = os.environ.get("COMMONINDEX_ZOEKT_VOLUME", "").strip() or DEFAULT_VOLUME
        image = os.environ.get("COMMONINDEX_ZOEKT_INDEX_IMAGE", "").strip() or DEFAULT_IMAGE
        return ["docker", "run", "--rm", "--platform", "linux/amd64",
                "-v", f"{clone}:/repo:ro", "-v", f"{volume}:/data",
                "--entrypoint", "zoekt-git-index", image,
                "-index", "/data", "-branches", branch, "/repo"]
    raise ShardUnavailable(
        "no Zoekt indexer here: install zoekt-git-index and set "
        "COMMONINDEX_ZOEKT_INDEX_DIR, or run Docker")


async def build_shard(clone: Path, branch: str) -> None:
    """Index `branch` of `clone` into Zoekt. The webserver watches its index
    directory, so the shard is served once written — no restart."""
    proc = await asyncio.create_subprocess_exec(
        *_command(clone, branch), stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE)
    try:
        _, err = await asyncio.wait_for(proc.communicate(), TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        raise RuntimeError(f"zoekt-git-index took longer than {TIMEOUT_SECONDS}s") from None
    if proc.returncode != 0:
        tail = err.decode(errors="replace").strip().splitlines()[-1:] or ["no output"]
        raise RuntimeError(f"zoekt-git-index failed: {tail[0][:300]}")
