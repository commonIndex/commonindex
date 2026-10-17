"""Refresh untouched bundled templates in the LOCAL development database.

Dry-run by default: .venv/bin/python scripts/refresh_design_templates.py
Apply: .venv/bin/python scripts/refresh_design_templates.py --apply --actor alex

This is deliberately not a production migration. Only exact, revision-one
bundled originals are upgraded; edited/renamed/deleted/ambiguous matches are
left alone. Existing IDs (and citations to them) survive. Before/after props
are stored as revisions. Rerunning is safe and does not duplicate templates.
"""

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

import asyncpg
import jsonschema

ROOT = Path(__file__).resolve().parents[1]
DSN = "postgresql://localhost/commonindex_dev"
CORE_FIELDS = ("spec", "cites", "state", "title", "surface")
NEW_STARTERS = {"starter-dashboard.json", "starter-review.json"}
# Canonical hashes of the bundled originals before the starter-library refresh.
ORIGINALS = {
    "starter-email.json": "76965e81a78a683e8a9f8eed66b67dc6f7b0f09b6821698b3500300c0ba6ba2b",
    "starter-mobile.json": "57d25b6ccaf44e77eef2e645c435b561d438460f44dfa1960826a0a53559157f",
    "starter-web.json": "f4adf1d8f7967b379b2f9c474583da5f1a3c5b33aca87c1f4f895ee7ce0a5867",
    "system-ember.json": "97133d1387285c7e5001a6f8f86badf7aa2cc90c99bb6674e0488eb74f9cb6ac",
    "system-ink.json": "433753c630f9cf8e5932fba07a31f8744a56166c8da00131f308380e5273af47",
    "system-moss.json": "a4ca54d1e8c8607e70b78286bfc7d55aab8cfdc91c697cb4688012be073da9d4",
    "system-paper.json": "f6cc17a75dab500771ccc0dcd97bd4b4fffc72ec7cc46790deee605a4383dd96",
    "system-slate.json": "2608ee687503666da53731d77bc0f6adc59885ff9d519e21a62bbf9d4746c47f",
}


def fingerprint(props):
    core = {key: props.get(key) for key in CORE_FIELDS}
    raw = json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def decision(filename, target, matches):
    if not matches:
        return "create" if filename in NEW_STARTERS else "skip: missing original"
    if len(matches) != 1:
        return "skip: ambiguous matches"
    row = matches[0]
    if row["deleted_at"] is not None:
        return "skip: deleted"
    props = row["props"]
    if row["title"] != target["title"] or props.get("title") != target["title"]:
        return "skip: renamed"
    if all(props.get(key) == value for key, value in target.items()):
        return "unchanged"
    if row["current_rev"] != 1:
        return "skip: revised by user"
    if fingerprint(props) != ORIGINALS.get(filename):
        return "skip: customized or unknown original"
    # Do not replace explicitly customized catalogue metadata either.
    if any(key in props and props[key] != target[key]
           for key in ("template_kind", "description")):
        return "skip: customized metadata"
    return "update"


async def refresh(*, apply=False, actor=None, space="pay"):
    schema = json.loads((ROOT / "types/design.json").read_text())["schema"]
    bundles = {path.name: json.loads(path.read_text())
               for path in sorted((ROOT / "designs").glob("*.json"))}
    for props in bundles.values():
        jsonschema.validate(props, schema)
    conn = await asyncpg.connect(DSN)
    try:
        async with conn.transaction(readonly=not apply):
            if apply:
                # seed_dev creates human actors and authored objects, but does
                # not populate memberships. Accept that existing dev-space
                # association as well; never create an actor or grant access.
                if not await conn.fetchval(
                    "select 1 from actors a where a.id = $1 and a.kind = 'human' and ("
                    " exists (select 1 from memberships m where m.actor_id = a.id"
                    " and m.space_id = $2) or exists (select 1 from objects o"
                    " where o.created_by = a.id and o.space_id = $2))", actor, space,
                ):
                    raise ValueError("--actor must name an existing human member or author in the space")
                await conn.execute("select pg_advisory_xact_lock(hashtext($1))",
                                   f"refresh-design-templates:{space}")
            records = await conn.fetch(
                "select id, title, props, current_rev, created_by, deleted_at from objects"
                " where space_id = $1 and type = 'design'"
                " and (title = any($2::text[]) or id = any($3::text[])) order by id"
                + (" for update" if apply else ""),
                space, [props["title"] for props in bundles.values()],
                [f"design-{Path(name).stem}" for name in bundles],
            )
            rows = [dict(row, props=json.loads(row["props"])) for row in records]
            print(f'{"Applying to" if apply else "DRY RUN — no writes to"} {DSN}, space={space}')
            for filename, target in bundles.items():
                oid = f"design-{Path(filename).stem}"
                matches = [row for row in rows
                           if row["title"] == target["title"] or row["id"] == oid]
                action = decision(filename, target, matches)
                print(f'{filename}: {action}' + (f' ({matches[0]["id"]})' if matches else ""))
                if not apply or action not in ("create", "update"):
                    continue
                if action == "create":
                    # A fixed ID is idempotent; a cross-space collision aborts safely.
                    await conn.execute(
                        "insert into space_seq (space_id) values ($1)"
                        " on conflict (space_id) do nothing", space,
                    )
                    seq = await conn.fetchval(
                        "update space_seq set next_seq = next_seq + 1 where space_id = $1"
                        " returning next_seq - 1", space,
                    )
                    await conn.execute(
                        "insert into objects (id, space_id, type, key, title, props, created_by)"
                        " values ($1,$2,'design',$3,$4,$5::jsonb,$6)",
                        oid, space, f"DES-{seq}", target["title"], json.dumps(target), actor,
                    )
                    await conn.execute(
                        "insert into revisions (object_id, rev, author_id, delta)"
                        " values ($1,1,$2,$3::jsonb)", oid, actor,
                        json.dumps({"props": target, "note": f"Added bundled template: {target['title']}"}),
                    )
                else:
                    row = matches[0]
                    props = {**row["props"], **target}
                    await conn.execute(
                        "insert into revisions (object_id, rev, author_id, delta)"
                        " values ($1,1,$2,$3::jsonb) on conflict (object_id, rev) do nothing",
                        row["id"], row["created_by"], json.dumps({
                            "props": row["props"], "note": "Original bundled template before refresh",
                        }),
                    )
                    await conn.execute(
                        "insert into revisions (object_id, rev, author_id, delta)"
                        " values ($1,2,$2,$3::jsonb)", row["id"], actor,
                        json.dumps({"props": props, "note": "Refreshed bundled starter catalogue"}),
                    )
                    await conn.execute(
                        "update objects set props = $2::jsonb, current_rev = 2, updated_at = now()"
                        " where id = $1", row["id"], json.dumps(props),
                    )
        if apply:
            print("Committed. Previous template props are retained in revision history.")
    finally:
        await conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--actor", help="Existing human member or author recording the refresh")
    parser.add_argument("--space", default="pay")
    args = parser.parse_args()
    if args.apply and not args.actor:
        parser.error("--apply requires --actor")
    asyncio.run(refresh(apply=args.apply, actor=args.actor, space=args.space))
