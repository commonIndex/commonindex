"""One-time setup for the full Docker stack (docker-compose.full.yml).

Runs before the gateway starts, and is safe to run again:

* the migrations (scripts/migrate.py), then the sample workspace
  (scripts/seed_dev.py) — spaces, people, docs, designs, the indexer's actor;
* `alex` made admin of the workspace, so the app opens as someone who can do
  everything in it;
* a secret key for encrypting warehouse credentials, and a token for the web
  app to sign in with, written to the shared volume — once. The gateway and the
  web app read them from there; neither is printed.

Sign-in is a dev token here, not local mode: local mode trusts only requests
from the gateway's own machine, and through Docker's network a request comes
from the bridge, not loopback — which is the guard working, so it stays.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SHARED = Path(os.environ.get("COMMONINDEX_SHARED", "/shared"))
ADMIN = os.environ.get("COMMONINDEX_DOCKER_ADMIN", "alex")
SPACE = os.environ.get("COMMONINDEX_SPACE", "pay")


def _run(*args: str) -> None:
    print("→", " ".join(args[1:]), flush=True)
    subprocess.run(args, check=True, env={**os.environ, "COMMONINDEX_DEV_DSN": os.environ["COMMONINDEX_DSN"]})


def _write_once(name: str, make) -> None:
    path = SHARED / name
    if path.exists() and path.read_text().strip():
        print(f"✓ {name} already there", flush=True)
        return
    SHARED.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(make())
    # Readable by the other containers' users, which differ from this one's.
    path.chmod(0o644)
    print(f"✓ {name} written", flush=True)


async def _admin_and_token() -> None:
    import asyncpg

    from commonindex.agent_tokens import mint

    conn = await asyncpg.connect(os.environ["COMMONINDEX_DSN"])
    try:
        await conn.execute(
            "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,'admin',$3,$2)"
            " on conflict (id) do nothing", f"g-{ADMIN}-{SPACE}", ADMIN, f"space:{SPACE}")
        print(f"✓ {ADMIN} is admin of space:{SPACE}", flush=True)
    finally:
        await conn.close()

    token_file = SHARED / "dev-token"
    if token_file.exists() and token_file.read_text().strip():
        print("✓ dev-token already there", flush=True)
        return
    token, _ = await mint(ADMIN, label="docker web app", dsn=os.environ["COMMONINDEX_DSN"])
    _write_once("dev-token", lambda: token)


def main() -> None:
    _run(sys.executable, str(ROOT / "scripts" / "migrate.py"))
    _run(sys.executable, str(ROOT / "scripts" / "seed_dev.py"))

    def key() -> str:
        from cryptography.fernet import Fernet

        return Fernet.generate_key().decode()

    _write_once("secret-key", key)
    asyncio.run(_admin_and_token())
    print("setup done", flush=True)


if __name__ == "__main__":
    main()
