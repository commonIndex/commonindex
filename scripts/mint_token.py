"""Mint a bearer token for an actor.

The token is printed once and never stored — only its SHA-256 is — so it cannot
be recovered later, only replaced. That is the point: a dump of `actor_tokens`
must not let the reader authenticate as anyone.

    uv run python scripts/mint_token.py alex --label "dev laptop"
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from commonindex.agent_tokens import mint as _mint


async def mint(actor: str, label: str, days: int | None) -> str:
    try:
        token, held = await _mint(actor, label=label, days=days)
    except LookupError as e:
        raise SystemExit(str(e)) from e
    print(f"actor    {actor} ({held['kind']}, trust {held['trust_tier']})")
    print(f"grants   {', '.join(held['grants']) or 'NONE — every operation will return 403'}")
    print(f"expires  {'never' if days is None else f'in {days} days'}")
    print()
    print(f"  {token}")
    print()
    print("Printed once. Only its hash is stored, so this cannot be recovered.")
    print("(For an agent run on this machine, `make agent-run AGENT=<id>` mints and keeps one for you.)")
    return token


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("actor")
    ap.add_argument("--label", default="")
    ap.add_argument("--days", type=int, default=None,
                    help="expiry in days; omit for a token that does not expire")
    args = ap.parse_args()
    asyncio.run(mint(args.actor, args.label, args.days))
    return 0


if __name__ == "__main__":
    sys.exit(main())
