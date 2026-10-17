"""Make someone the admin of a workspace, and print a link to sign in with.

For a fresh install, where nobody is in yet: the first admin. Setting
COMMONINDEX_ADMIN_EMAIL on the gateway does the same on start; this is the
command for doing it by hand, or again.

    uv run python scripts/create_admin.py ana@example.com --name "Ana Ruiz"

The link signs them in once and expires in a day. Where people sign in with
single sign-on, they can ignore it and use their company account instead.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

DSN = os.environ.get("COMMONINDEX_DSN") or os.environ.get("COMMONINDEX_DEV_DSN", "postgresql://localhost/commonindex_dev")


async def main(email: str, name: str, space: str | None) -> int:
    import asyncpg

    from commonindex.gateway import signin

    if not signin.EMAIL.match(email):
        print(f"{email!r} is not an email address", file=sys.stderr)
        return 1
    conn = await asyncpg.connect(DSN.replace("postgresql+asyncpg://", "postgresql://"))
    try:
        person, made = await signin.ensure_admin(conn, email, name, space)
        code, expires = await signin.issue_code(conn, person, person, days=1)
    finally:
        await conn.close()
    print(f"{'made' if made else 'found'} {person} ({email}), admin of {space or signin.space()}")
    print(f"\n  {signin.sign_in_link(code)}\n")
    print(f"Signs in once, until {expires:%Y-%m-%d %H:%M %Z}. Printed once; not stored.")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("email")
    ap.add_argument("--name", default="")
    ap.add_argument("--space", default=None, help="the workspace id (COMMONINDEX_SPACE, else pay)")
    args = ap.parse_args()
    raise SystemExit(asyncio.run(main(args.email, args.name, args.space)))
