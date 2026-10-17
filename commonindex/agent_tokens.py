"""Tokens for agents run on this machine, kept so nobody has to copy one.

Running an agent was: mint a token, copy it before it scrolls away (it is
printed once), paste it into `make agent-run TOKEN=…`, and do it all again
after every restart. Here a token is minted for an agent the first time it is
run on this machine and kept in a private folder — `~/.config/commonindex/agents`,
mode 700, one `<agent>.token` file each at 600 — so `make agent-run AGENT=scribe`
just runs, and `make local` runs every agent kept there.

Minting writes to the database directly, the way `scripts/mint_token.py`
always has: it is a convenience for the machine the platform runs on, not
an operation a remote caller can reach.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from commonindex.core.authz.store import hash_token

DEV_DSN = "postgresql://localhost/commonindex_dev"


def token_dir() -> Path:
    return Path(os.environ.get("COMMONINDEX_AGENT_TOKENS") or
                Path.home() / ".config" / "commonindex" / "agents")


def _path(agent: str) -> Path:
    if not agent or "/" in agent or agent.startswith("."):
        raise ValueError(f"{agent!r} is not an agent id")
    return token_dir() / f"{agent}.token"


def stored(agent: str) -> str | None:
    """The token kept for this agent, or None."""
    try:
        token = _path(agent).read_text().strip()
    except FileNotFoundError:
        return None
    return token or None


def save(agent: str, token: str) -> Path:
    """Keep a token, readable by this user only."""
    folder = token_dir()
    folder.mkdir(parents=True, exist_ok=True)
    folder.chmod(0o700)
    path = _path(agent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    path.chmod(0o600)
    return path


def kept() -> dict[str, str]:
    """Every agent with a token kept on this machine."""
    folder = token_dir()
    if not folder.is_dir():
        return {}
    return {p.stem: t for p in sorted(folder.glob("*.token")) if (t := p.read_text().strip())}


async def mint(actor: str, *, label: str = "", days: int | None = None, dsn: str | None = None,
               agents_only: bool = False) -> tuple[str, dict]:
    """A new token for `actor`, written as its hash. Returns the token and what
    it can do: the actor's kind and trust tier, and its grants."""
    import asyncpg

    dsn = (dsn or os.environ.get("COMMONINDEX_DEV_DSN") or os.environ.get("COMMONINDEX_DSN") or DEV_DSN)
    conn = await asyncpg.connect(dsn.replace("postgresql+asyncpg://", "postgresql://"))
    try:
        row = await conn.fetchrow("select id, kind, trust_tier from actors where id = $1", actor)
        if row is None:
            known = [r["id"] for r in await conn.fetch(
                "select id from actors where kind = 'agent' order by id" if agents_only
                else "select id from actors order by id")]
            raise LookupError(f"no {'agent' if agents_only else 'actor'} {actor!r}; there are {known}")
        if agents_only and row["kind"] != "agent":
            raise LookupError(f"{actor!r} is a {row['kind']}, not an agent")
        token = "ci_" + secrets.token_urlsafe(32)
        await conn.execute(
            "insert into actor_tokens (id, actor_id, token_hash, label, created_by, expires_at)"
            " values ($1,$2,$3,$4,$5,"
            "   case when $6::int is null then null else now() + ($6 || ' days')::interval end)",
            "tok-" + secrets.token_hex(6), actor, hash_token(token), label, actor, days)
        grants = await conn.fetch(
            "select relation, resource from grants where subject = $1 order by resource", actor)
        return token, {"kind": row["kind"], "trust_tier": row["trust_tier"],
                       "grants": [f"{g['relation']} on {g['resource']}" for g in grants]}
    finally:
        await conn.close()
