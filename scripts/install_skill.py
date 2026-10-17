"""Write the generated skill somewhere Claude will actually read it.

The content has been spec-shaped for a while — `name`, `description`, a SKILL.md
under 5k tokens, bundled files linked for progressive disclosure. It was also
unreachable: a JSON blob from an HTTP endpoint, while every surface that runs a
Skill reads one from somewhere else.

    Claude Code   ~/.claude/skills/<name>/  or  .claude/skills/<name>/
    claude.ai     a .zip uploaded in settings
    Claude API    POST /v1/skills

    python scripts/install_skill.py                 # into ./.claude/skills
    python scripts/install_skill.py --user          # into ~/.claude/skills
    python scripts/install_skill.py --zip out.zip   # for claude.ai
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.request
import zipfile

GATEWAY = os.environ.get("COMMONINDEX_GATEWAY", "http://localhost:8000")


def fetch(space: str) -> dict:
    req = urllib.request.Request(
        f"{GATEWAY}/api/v1/context.skill",
        json.dumps({"space_id": space, "gateway": GATEWAY}).encode(),
        {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def write_dir(bundle: dict, root: pathlib.Path) -> pathlib.Path:
    """One directory per skill, named for it — the layout every surface expects."""
    target = root / bundle["name"]
    target.mkdir(parents=True, exist_ok=True)
    for rel, body in bundle["files"].items():
        f = target / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(body)
        # The docs are explicit that scripts are run, so they need to be runnable.
        if rel.startswith("scripts/"):
            f.chmod(0o755)
    return target


def write_zip(bundle: dict, path: pathlib.Path) -> pathlib.Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, body in bundle["files"].items():
            z.writestr(f"{bundle['name']}/{rel}", body)
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--space", default="pay")
    ap.add_argument("--user", action="store_true",
                    help="install for this user rather than this project")
    ap.add_argument("--zip", metavar="PATH", help="write a zip for claude.ai instead")
    a = ap.parse_args()

    try:
        bundle = fetch(a.space)
    except OSError as e:
        print(f"cannot reach the gateway at {GATEWAY}: {e}", file=sys.stderr)
        print("start it with `make dev-gateway`", file=sys.stderr)
        return 1

    if a.zip:
        out = write_zip(bundle, pathlib.Path(a.zip))
        print(f"wrote {out} — upload it in claude.ai under Settings → Capabilities")
        return 0

    root = (pathlib.Path.home() / ".claude" / "skills") if a.user \
        else (pathlib.Path.cwd() / ".claude" / "skills")
    out = write_dir(bundle, root)
    print(f"installed {bundle['name']} → {out}")
    print(f"  {len(bundle['files'])} files")
    # Regeneration is the point: the registry moves, and a copy on disk does not.
    print("\nRe-run this after ratifying a definition or building a dashboard —")
    print("the files are a snapshot, and the registry is not.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
