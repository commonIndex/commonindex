"""Indexing a repo and being allowed to read it are two separate facts.

Until this suite existed nothing in the repository wrote a `grants` row, so
`acl_keys_for` returned `[]` for every actor and `_code_search` short-circuited
to zero hits before it ever reached Postgres. Code query was not "lexical only"
as its docstring said — it was returning nothing to anybody, and no test noticed
because no test had an actor who was supposed to see something.

These run the real predicate the gateway runs: the caller's grants expanded to
acl_keys, overlapped against the chunk rows, on one statement.

    docker compose up -d db
    COMMONINDEX_TEST_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_test \
        make test-integration
"""

from __future__ import annotations

import pytest
from db import DSN, reset, seed

from commonindex.core.authz.store import PgChecker
from commonindex.workers.codequery import (
    _tombstone_code_file,
    _upsert_code_file,
    _upsert_repo,
)
from commonindex.workers.connectors import Record
from commonindex.workers.connectors.git import RepoRef

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

STOREFRONT = RepoRef(org="example", repo="storefront", branch="main",
                     space_id="pay", provider="local")
LEDGER = RepoRef(org="example", repo="ledger", branch="main",
                 space_id="pay", provider="local")

#: Distinct vocabularies on purpose. Routing is the next step's problem, but a
#: corpus where both repos say the same thing cannot demonstrate that it works.
CORPUS = {
    STOREFRONT.repo_id: [("checkout.py", "def place_order(cart):\n    return submit(cart)\n")],
    LEDGER.repo_id: [("posting.py", "def post_journal_entry(txn):\n    return ledger.add(txn)\n")],
}


async def _index(conn, ref: RepoRef) -> None:
    for path, body in CORPUS[ref.repo_id]:
        await _upsert_code_file(conn, ref, Record(
            id=path, stream=ref.stream_name,
            props={"path": path, "sha": f"sha-{path}", "size": len(body),
                   "language": "python", "body": body},
        ), "maya")
    # A sha-shaped cursor, not a word. "head" is a valid revision to git (it
    # matches HEAD case-insensitively), so a placeholder cursor resolves and
    # the next pull diffs an empty range instead of reading anything.
    await _upsert_repo(conn, ref, "0" * 40, "maya")


async def _grant(conn, subject: str, ref: RepoRef) -> None:
    await conn.execute(
        "insert into grants (id, subject, relation, resource, granted_by)"
        " values ($1,$2,'read',$3,'maya') on conflict (id) do nothing",
        f"g-{subject}-read-{ref.acl_key.replace(':', '-')}", subject, ref.acl_key)


async def _search(conn, actor: str, term: str) -> list[str]:
    """The gateway's own predicate, verbatim — acl filter on the same statement
    as the match, per context-plane.md, not applied afterwards in Python."""
    keys = await PgChecker(conn).acl_keys_for(actor)
    if not keys:
        return []
    rows = await conn.fetch(
        "select o.title as path from chunks c join objects o on o.id = c.object_id"
        " where c.space_id = 'pay' and c.object_type = 'code_file'"
        "   and c.tsv @@ plainto_tsquery('english', $1) and c.acl_keys && $2"
        "   and o.deleted_at is null", term, keys)
    return sorted(r["path"] for r in rows)


@pytest.fixture
async def db():
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    await conn.execute(
        "insert into actors (id, kind, display) values ('contractor','human','Contractor')")
    async with conn.transaction():
        await _index(conn, STOREFRONT)
        await _index(conn, LEDGER)
    try:
        yield conn
    finally:
        await conn.close()


async def test_an_actor_without_a_grant_reads_nothing(db):
    """The contractor case the ACL docstring names. Not a redacted placeholder
    and not an empty-because-nothing-matched — nothing, because the overlap
    never matches."""
    assert await _search(db, "contractor", "order") == []


async def test_a_granted_actor_reads_only_the_repo_they_were_granted(db):
    await _grant(db, "maya", STOREFRONT)

    assert await _search(db, "maya", "order") == ["checkout.py"]
    assert await _search(db, "maya", "journal") == []


async def test_a_second_grant_widens_reach_without_a_reindex(db):
    """Permissions move faster than content (N1 rule 2). Granting must not
    require re-pulling the repo — which it would if the acl key were derived
    from the grant rather than from the repo."""
    await _grant(db, "maya", STOREFRONT)
    await _grant(db, "maya", LEDGER)

    assert await _search(db, "maya", "journal") == ["posting.py"]


async def test_a_reindex_does_not_drop_the_repo_key(db):
    """`_upsert_code_file` takes the UPDATE branch on re-pull, which is the
    branch that previously wrote `record.acl_keys` — empty for every real pull.
    A file that silently loses its key on the second index is invisible and
    looks like a search bug."""
    await _grant(db, "maya", STOREFRONT)
    async with db.transaction():
        await _index(db, STOREFRONT)

    assert await _search(db, "maya", "order") == ["checkout.py"]


async def test_unchanged_content_is_not_reindexed(db):
    """A full re-read stamps every file with the new HEAD, so comparing commit
    shas would make an untouched corpus look entirely changed — a revision row
    and an event per file, every pass."""
    before = await db.fetchval("select count(*) from revisions")

    async with db.transaction():
        await _index(db, STOREFRONT)

    assert await db.fetchval("select count(*) from revisions") == before


async def test_a_deleted_file_stops_being_searchable(db):
    await _grant(db, "maya", STOREFRONT)
    assert await _search(db, "maya", "order") == ["checkout.py"]

    async with db.transaction():
        await _tombstone_code_file(db, STOREFRONT, "checkout.py", "maya")

    assert await _search(db, "maya", "order") == []
    assert await db.fetchval(
        "select count(*) from chunks c join objects o on o.id = c.object_id"
        " where o.title = 'checkout.py'") == 0


async def test_tombstoning_a_path_that_was_never_indexed_is_not_work(db):
    async with db.transaction():
        assert await _tombstone_code_file(db, STOREFRONT, "nope.py", "maya") is False


async def test_a_path_re_added_after_deletion_is_the_same_object(db):
    """Same id, so the grant that made it readable still does. A second object
    would silently need granting again."""
    await _grant(db, "maya", STOREFRONT)
    async with db.transaction():
        await _tombstone_code_file(db, STOREFRONT, "checkout.py", "maya")
        await _index(db, STOREFRONT)

    assert await _search(db, "maya", "order") == ["checkout.py"]
    assert await db.fetchval(
        "select count(*) from objects where title = 'checkout.py'") == 1


async def test_the_repo_object_itself_is_readable_to_a_granted_actor(db):
    """objects.acl_keys defaults to '{}'. A code_repo row left at the default
    overlaps with nothing, so the routing step cannot see the repo it is
    supposed to choose between."""
    await _grant(db, "maya", STOREFRONT)
    keys = await PgChecker(db).acl_keys_for("maya")

    rows = await db.fetch(
        "select id from objects where type = 'code_repo' and acl_keys && $1", keys)

    assert [r["id"] for r in rows] == [STOREFRONT.repo_id]
