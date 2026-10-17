"""End-to-end: migrations, seeded rows, and the SQL the dashboard tier compiles.

Skipped when no database is reachable, so the unit suite still runs anywhere.
Run against the compose service with:

    docker compose up -d db
    COMMONINDEX_TEST_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_test make test-integration

or against a local Postgres with ``make db-up``.
"""

from __future__ import annotations

import itertools
import json
import pathlib
from datetime import UTC, datetime, timedelta

import pytest
from db import DSN, reset, seed

from commonindex.core.warehouse import Filter, Query, TimeGrain, Window
from commonindex.core.warehouse.dialects import POSTGRES
from commonindex.core.warehouse.series import shape, verdict
from commonindex.core.warehouse.sources.eventlog import (
    AGENT_WORK,
    RUNS,
    SEED_METRICS,
    compile_query,
    to_result,
)

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

NOW = datetime.now(tz=UTC)
W30 = Window(NOW - timedelta(days=30), NOW)
BY_ID = {m.id: m for m in SEED_METRICS}


#: Migrations and seed run once per session. The connection itself is
#: per-test, because pytest-asyncio gives each test its own event loop and an
#: asyncpg connection cannot outlive the loop it was opened on.
_PREPARED = False


@pytest.fixture
async def db():
    global _PREPARED
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    if not _PREPARED:
        await reset(conn)
        await seed(conn)
        # Handlers are called here without the middleware that admits a member;
        # since items check who may see them, the test's people are members,
        # as anyone calling through the gateway is.
        await conn.execute(
            "insert into grants (id, subject, relation, resource, granted_by) values"
            " ('g-test-maya', 'maya', 'admin', 'space:pay', 'maya') on conflict (id) do nothing")
        _PREPARED = True
    try:
        yield conn
    finally:
        await conn.close()


async def run(conn, metric_id: str, dataset=AGENT_WORK, **kw):
    q = Query(metric_id=metric_id, dataset_id=dataset.id, space_id="pay",
              grain=TimeGrain.NONE, window=W30, **kw)
    sql, params = compile_query(POSTGRES, dataset, BY_ID[metric_id], q, [])
    return to_result(await conn.fetch(sql, *params), q, dataset)


# ── the migrations apply from zero ─────────────────────────────────────


async def test_every_migration_applies_to_an_empty_schema(db):
    """A migration that only works on top of yesterday's database will fail in
    production, and applying from zero every run is the only way to know."""
    tables = await db.fetchval(
        "select count(*) from information_schema.tables where table_schema = 'public'")
    assert tables >= 21  # 16 core + 5 dashboard


async def test_the_undone_column_the_metric_needs_exists(db):
    """The bug that shipped in #5: undo_after_merge referenced a column that did
    not exist, so the metric would have failed the first time anyone opened the
    panel."""
    assert await db.fetchval(
        "select count(*) from information_schema.columns"
        " where table_name = 'proposals' and column_name = 'undone_at'") == 1


# ── the seeded metrics actually execute ────────────────────────────────


async def test_agent_acceptance_computes_the_expected_fraction(db):
    """Four of six proposals inside the window are merged. The seventh is 400
    days old, so if the window bound were missing this would be 5/7."""
    r = await run(db, "agent_acceptance")
    assert r.rows[0][-1] == pytest.approx(4 / 6)


async def test_undo_after_merge_computes_over_merged_only(db):
    """One of four merged proposals was undone. Denominator is merges, not all
    proposals — 1/4, not 1/6."""
    r = await run(db, "undo_after_merge")
    assert r.rows[0][-1] == pytest.approx(1 / 4)


async def test_review_latency_returns_seconds(db):
    r = await run(db, "review_latency_p50")
    assert 600 <= r.rows[0][-1] <= 7200


async def test_run_cost_sums_only_the_requested_space(db):
    """The growth row is 9.99. If the space predicate were missing this would be
    11.22 rather than 1.23."""
    r = await run(db, "run_cost", dataset=RUNS)
    assert r.rows[0][-1] == pytest.approx(0.38 + 0.21 + 0.64)


# ── the compiled SQL behaves as designed ───────────────────────────────


async def test_the_window_bound_actually_excludes(db):
    """Seven proposals exist; six are inside thirty days."""
    q = Query(metric_id="agent_acceptance", dataset_id=AGENT_WORK.id, space_id="pay",
              grain=TimeGrain.NONE, window=W30)
    sql, params = compile_query(POSTGRES, AGENT_WORK, BY_ID["agent_acceptance"], q, [])
    counted = await db.fetchval(
        sql.replace(BY_ID["agent_acceptance"].expr + " AS value", "COUNT(*)"), *params)
    assert counted == 6


async def test_grouping_by_a_dimension_splits_the_rows(db):
    r = await run(db, "agent_acceptance", dimensions=["author"])
    by_author = {row[0]: row[-1] for row in r.rows}
    assert set(by_author) == {"scribe", "triage"}
    # scribe: p1,p2,p3 merged of p1,p2,p3,p5 = 3/4 ; triage: p4 of p4,p6 = 1/2
    assert by_author["scribe"] == pytest.approx(3 / 4)
    assert by_author["triage"] == pytest.approx(1 / 2)


async def test_a_time_grain_buckets_by_day(db):
    q = Query(metric_id="agent_acceptance", dataset_id=AGENT_WORK.id, space_id="pay",
              grain=TimeGrain.DAY, window=W30)
    sql, params = compile_query(POSTGRES, AGENT_WORK, BY_ID["agent_acceptance"], q, [])
    rows = await db.fetch(sql, *params)
    assert len(rows) == 3  # three distinct days in the fixture
    assert [r["bucket"] for r in rows] == sorted(r["bucket"] for r in rows)


async def test_a_bound_filter_is_not_interpolated(db):
    """Proof the parameter path works against a real driver, not only that the
    string contains a placeholder."""
    r = await run(db, "agent_acceptance", filters=[Filter("author", "eq", ["triage"])])
    assert r.rows[0][-1] == pytest.approx(1 / 2)


async def test_filters_accept_multiple_values(db):
    r = await run(db, "agent_acceptance",
                  filters=[Filter("outcome", "in", ["merged", "rejected"])])
    # merged 4 + rejected 1 = 5 in scope, 4 merged
    assert r.rows[0][-1] == pytest.approx(4 / 5)


async def test_a_space_with_no_rows_returns_a_null_not_an_error(db):
    """NULLIF guards the divide. An empty space should render as "no data", not
    as a five-hundred."""
    q = Query(metric_id="agent_acceptance", dataset_id=AGENT_WORK.id,
              space_id="growth", grain=TimeGrain.NONE, window=W30)
    sql, params = compile_query(POSTGRES, AGENT_WORK, BY_ID["agent_acceptance"], q, [])
    assert (await db.fetch(sql, *params))[0]["value"] is None


# ── the whole path, query through to a rendered series ─────────────────


async def test_result_shapes_into_series_a_chart_can_draw(db):
    q = Query(metric_id="agent_acceptance", dataset_id=AGENT_WORK.id, space_id="pay",
              grain=TimeGrain.DAY, window=W30, dimensions=["author"])
    sql, params = compile_query(POSTGRES, AGENT_WORK, BY_ID["agent_acceptance"], q, [])
    result = to_result(await db.fetch(sql, *params), q, AGENT_WORK)
    s = shape(result, unit=BY_ID["agent_acceptance"].unit,
              better=BY_ID["agent_acceptance"].better)
    assert {x.name for x in s.series} == {"scribe", "triage"}
    assert s.unit == "pct" and s.better == "up"
    assert not s.is_empty


async def test_verdict_uses_the_ratified_direction_end_to_end(db):
    """undo_after_merge is better=down, so a rise is bad however it is drawn."""
    assert verdict(0.5, 0.25, BY_ID["undo_after_merge"].better) == "bad"
    assert verdict(0.1, 0.25, BY_ID["undo_after_merge"].better) == "good"


# ── a panel that carries its own query ──────────────────────────────────────
#
# These run against the real migrations because every bug this feature had was
# a schema-and-handler bug that no in-process test could see. The panel worked
# end to end against a live warehouse while `panels.add` was quietly defining a
# metric for it, and `dashboards.list` was calling the dashboard certified
# while the dashboard's own page reported it uncertified. The migration is what
# makes the honest state representable; these are the assertions that it does.


async def _dash(conn, dash_id="d-sql"):
    await conn.execute(
        "insert into objects (id, space_id, type, key, title, props, created_by)"
        " values ($1,'pay','dashboard',$2,'SQL','{}'::jsonb,'maya')"
        " on conflict (id) do nothing", dash_id, f"D-{dash_id.upper()}")
    return dash_id


async def _panel_obj(conn, *panel_ids):
    """panel_bindings.panel_id is an FK to objects — a binding with no object
    is a panel nothing can name."""
    for pid in panel_ids:
        await conn.execute(
            "insert into objects (id, space_id, type, title, props, created_by)"
            " values ($1,'pay','panel','P','{}'::jsonb,'maya')"
            " on conflict (id) do nothing", pid)


async def test_a_panel_may_carry_a_query_and_cite_no_definition(db):
    """The row the whole feature is: no metric, no dataset, one statement."""
    d = await _dash(db)
    await _panel_obj(db, "p-sql")
    await db.execute(
        "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
        " metric_version, grain, position, mark, title, sql)"
        " values ('p-sql',$1,null,null,null,'none',0,'sql','Raw','select 1')", d)
    row = await db.fetchrow("select * from panel_bindings where panel_id = 'p-sql'")
    assert row["metric_id"] is None and row["dataset_id"] is None
    assert row["sql"] == "select 1"


async def test_a_panel_cannot_both_carry_a_query_and_cite_a_definition(db):
    """Two answers to "where does this number come from" and no rule for which
    wins. Refused by the schema, not only by the handler that happens to check."""
    d = await _dash(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
            " metric_version, grain, position, mark, title, sql)"
            " values ('p-both',$1,'ds.runs','m.acceptance',1,'day',1,'sql','B','select 1')",
            d)


async def test_a_panel_must_be_one_or_the_other(db):
    """Neither a query nor a binding is a panel that renders nothing at all."""
    d = await _dash(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
            " metric_version, grain, position, mark, title, sql)"
            " values ('p-none',$1,null,null,null,'day',2,'line','N',null)", d)


async def test_a_metric_version_cannot_pin_nothing(db):
    """A version without an id, or an id without a version, reads as a binding
    while being unresolvable — the state that looks fine until render."""
    d = await _dash(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
            " metric_version, grain, position, mark, title, sql)"
            " values ('p-half',$1,null,null,3,'none',3,'sql','H','select 1')", d)


async def test_the_dashboard_list_counts_a_query_panel_as_unratified(db):
    """The bug this replaces: the left join to `metrics` yields no row for a
    panel citing nothing, so `m.status <> 'ratified'` is NULL rather than true,
    and the dashboard listed as CERTIFIED while its own page said otherwise."""
    d = await _dash(db, "d-sql-2")
    await _panel_obj(db, "p-sql-2")
    await db.execute(
        "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
        " metric_version, grain, position, mark, title, sql)"
        " values ('p-sql-2',$1,null,null,null,'none',0,'sql','Raw','select 1')", d)
    unratified = await db.fetchval(
        """
        select count(*) filter (where b.sql is not null
                                   or m.status is distinct from 'ratified')
          from objects o
          join panel_bindings b on b.dashboard_id = o.id
          left join metrics m on m.id = b.metric_id and m.version = b.metric_version
         where o.id = $1 group by o.id
        """, d)
    assert unratified == 1


async def test_the_mark_a_query_panel_stores_is_one_the_schema_allows(db):
    """`mark` is constrained to the shapes the renderer knows. Adding a shape
    the renderer draws but the CHECK rejects is a panel that cannot be saved."""
    d = await _dash(db, "d-sql-3")
    await _panel_obj(db, *[f"p-m{i}" for i in range(8)], "p-bad")
    for i, mark in enumerate(("stat", "line", "area", "bar", "stacked",
                              "heatmap", "heat", "table")):
        await db.execute(
            "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
            " metric_version, grain, position, mark, title, sql)"
            f" values ('p-m{i}',$1,null,null,null,'none',{i},'{mark}','M','select 1')", d)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            "insert into panel_bindings (panel_id, dashboard_id, dataset_id, metric_id,"
            " metric_version, grain, position, mark, title, sql)"
            " values ('p-bad',$1,null,null,null,'none',99,'sunburst','M','select 1')", d)


# ── the cache that deleted nothing ──────────────────────────────────────────


async def test_invalidating_a_metric_drops_what_was_computed_from_it(db):
    """`invalidate_metric` matched `result::text like '%metric_id%'` against a
    payload written as `{"columns": …, "rows": …}`. The id is not in it, so the
    delete matched nothing and always returned zero.

    Its own docstring says what that costs: "without it, changing what a number
    means leaves the old number on screen until a TTL expires — which is
    precisely the drift the registry exists to prevent, reappearing one layer
    down."
    """
    from datetime import UTC, datetime, timedelta

    from commonindex.core.warehouse import ColKind, Result
    from commonindex.core.warehouse.cache import Entry
    from commonindex.core.warehouse.store import PgQueryCache

    cache = PgQueryCache(db)
    now = datetime.now(tz=UTC)

    def entry(key: str, metric: str) -> Entry:
        return Entry(key=key, space_id="pay", acl_keys=["space:pay"],
                     result=Result(columns=[("bucket", ColKind.TIME),
                                            ("value", ColKind.NUMBER)],
                                   rows=[["d1", 1.0]]),
                     fetched_at=now, expires_at=now + timedelta(hours=1),
                     metric_id=metric)

    await cache.put(entry("k-acceptance", "agent_acceptance"))
    await cache.put(entry("k-cost", "run_cost"))
    assert await cache.get("k-acceptance") is not None

    await cache.invalidate_metric("pay", "agent_acceptance")
    assert await cache.get("k-acceptance") is None, "the stale number survived"
    # And only that one: ratifying one definition must not empty the cache.
    assert await cache.get("k-cost") is not None


async def test_invalidation_is_scoped_to_the_space(db):
    """A metric id is unique within a space, not across them."""
    from datetime import UTC, datetime, timedelta

    from commonindex.core.warehouse import ColKind, Result
    from commonindex.core.warehouse.cache import Entry
    from commonindex.core.warehouse.store import PgQueryCache

    cache = PgQueryCache(db)
    now = datetime.now(tz=UTC)
    for space, key in (("pay", "k-pay"), ("growth", "k-growth")):
        await cache.put(Entry(key=key, space_id=space, acl_keys=[f"space:{space}"],
                              result=Result(columns=[("value", ColKind.NUMBER)],
                                            rows=[[1.0]]),
                              fetched_at=now, expires_at=now + timedelta(hours=1),
                              metric_id="shared_name"))

    await cache.invalidate_metric("pay", "shared_name")
    assert await cache.get("k-pay") is None
    assert await cache.get("k-growth") is not None


# ── agents, as objects rather than as a page of numbers ─────────────────────
#
# The platform has had real agent identity for a while: an actor row with a kind
# and a trust tier, hashed revocable tokens, ReBAC grants per space, and
# `_may_ratify` reading the tier so an agent's definitions arrive PROPOSED where
# a person's arrive ratified. What it had no way to do was SHOW any of it —
# there were no agent operations at all, and the page was generated in the
# browser.


async def _agent_fixture(db):
    from commonindex.gateway.agents import _agents

    await db.execute("""
        insert into actors (id, kind, display, owner_id, trust_tier) values
            ('owned', 'agent', 'Owned', 'maya', 'propose-only'),
            ('freed', 'agent', 'Freed', 'maya', 'autonomous')
        on conflict (id) do nothing;
        insert into grants (id, subject, relation, resource, granted_by) values
            ('g-owned-pay', 'owned', 'propose', 'space:pay', 'maya'),
            ('g-owned-growth', 'owned', 'read', 'space:growth', 'maya')
        on conflict (id) do nothing;
    """)
    return _agents


async def test_an_agent_reports_who_answers_for_it(db):
    _agents = await _agent_fixture(db)
    by = {a["id"]: a for a in await _agents(db, "pay")}
    assert by["owned"]["owner"]["id"] == "maya"
    assert by["owned"]["owner"]["kind"] == "human"


async def test_an_agent_nobody_answers_for_says_so_rather_than_guessing(db):
    """`owner_id` has existed since 0001 and was read nowhere. An agent with no
    owner is the finding, not a blank to be filled in with the first plausible
    name — a migration that invented one would put a person's name against
    conduct they never agreed to answer for.

    The constraint has to be lifted to produce the case, which is the point of
    the case: it can only arise from a row that predates 0017, and this suite
    builds from zero so it cannot make one any other way. Dropping and
    restoring it here is explicit about simulating history rather than
    quietly weakening the rule.
    """
    _agents = await _agent_fixture(db)
    await db.execute("alter table actors drop constraint actors_agent_has_owner")
    try:
        await db.execute("update actors set owner_id = null where id = 'scribe'")
        by = {a["id"]: a for a in await _agents(db, "pay")}
        assert by["scribe"]["owner"] is None
    finally:
        await db.execute(
            "update actors set owner_id = 'maya' where id = 'scribe';"
            " alter table actors add constraint actors_agent_has_owner"
            " check (kind <> 'agent' or owner_id is not null) not valid")


async def test_grants_are_scoped_to_the_space_the_caller_holds(db):
    """An agent may hold grants in several spaces. The caller is authorized for
    one, and showing the others reports a scope they cannot check."""
    _agents = await _agent_fixture(db)
    pay = {a["id"]: a for a in await _agents(db, "pay")}["owned"]
    growth = {a["id"]: a for a in await _agents(db, "growth")}["owned"]
    assert [g["resource"] for g in pay["grants"]] == ["space:pay"]
    assert [g["resource"] for g in growth["grants"]] == ["space:growth"]
    assert pay["may"] == ["propose"]
    assert growth["may"] == ["read"]


async def test_an_agent_with_no_grant_here_can_do_nothing_here(db):
    _agents = await _agent_fixture(db)
    by = {a["id"]: a for a in await _agents(db, "pay")}
    assert by["freed"]["grants"] == []
    assert by["freed"]["may"] == []


async def test_the_trust_tier_is_reported_as_the_rule_it_decides(db):
    """`_may_ratify` reads the tier, and `autonomous` versus everything else is
    the whole difference it makes. Printing the tier alone leaves a reader to
    know that; printing the consequence does not."""
    _agents = await _agent_fixture(db)
    by = {a["id"]: a for a in await _agents(db, "pay")}
    assert by["owned"]["may_ratify_own_work"] is False
    assert by["freed"]["may_ratify_own_work"] is True


async def test_a_token_is_counted_and_never_returned(db):
    """It is stored as a hash precisely so a read like this cannot leak it."""
    from commonindex.core.authz.store import hash_token

    _agents = await _agent_fixture(db)
    await db.execute(
        "insert into actor_tokens (id, actor_id, token_hash, label, created_by)"
        " values ('tok-t','owned',$1,'test','maya') on conflict do nothing",
        hash_token("ci_secret"))
    got = {a["id"]: a for a in await _agents(db, "pay")}["owned"]
    assert got["tokens"]["count"] == 1
    assert "ci_secret" not in str(got)
    assert hash_token("ci_secret") not in str(got)


async def test_authorship_is_read_from_the_record_not_computed(db):
    """`objects.created_by` is the record the whole platform writes. The page it
    replaces showed an acceptance rate, a merged-of-filed count and a run cost,
    none of which the schema holds."""
    _agents = await _agent_fixture(db)
    await db.execute(
        "insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
        " values ('doc-agent','pay','doc','D-9','Made by an agent','owned','{space:pay}')"
        " on conflict (id) do nothing")
    by = {a["id"]: a for a in await _agents(db, "pay")}
    assert by["owned"]["authored"]["doc"] == 1
    # And scoped: the same agent has authored nothing in the other space.
    other = {a["id"]: a for a in await _agents(db, "growth")}
    assert other["owned"]["authored"] == {}


async def test_a_new_agent_must_name_an_owner(db):
    """0017 made it a constraint. It is NOT VALID, so the agents that predate it
    stay as they are and every one created from here on carries a name."""
    import asyncpg
    import pytest as _p

    with _p.raises(asyncpg.CheckViolationError):
        await db.execute(
            "insert into actors (id, kind, display) values ('orphan','agent','Orphan')")


async def test_a_person_still_needs_no_owner(db):
    """The constraint is about agents. A human answering to nobody is an
    ordinary employment arrangement, not a governance gap."""
    await db.execute(
        "insert into actors (id, kind, display) values ('solo','human','Solo')"
        " on conflict (id) do nothing")
    assert await db.fetchval("select 1 from actors where id = 'solo'")


# ── bringing an agent into existence ────────────────────────────────────────


class _PoolOf:
    """One connection, wearing a pool's interface.

    The handlers take a connection out of the pool to hold a transaction open
    across three writes. The fixture hands out a single connection — which is
    what makes each test's writes visible to its own reads and rolled back
    afterwards — so this is the adapter between the two, not a mock of either.
    """

    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        conn = self._conn

        class _Held:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *_):
                return False

        return _Held()

    def __getattr__(self, name):
        return getattr(self._conn, name)


class _Req:
    """The two fields the handlers touch: the body, and the authenticated
    actor the middleware put on the request."""

    def __init__(self, body, pool, actor="maya"):
        self._body = body
        self.state = type("S", (), {"principal": type("P", (), {"actor_id": actor})(),
                                    "space": "pay"})()
        self.app = type("A", (), {"state": type("S2", (), {"commonindex": {"pool": _PoolOf(pool)}})()})()

    async def json(self):
        return self._body

    async def body(self):
        return json.dumps(self._body).encode()


async def _create(db, **over):
    from commonindex.gateway.agents import agents_create

    body = {"agent_id": "made", "owner_id": "maya", "idempotencyKey": "k",
            "grant": {"relation": "propose", "resource": "space:pay"}, **over}
    return await agents_create(_Req(body, db))


async def test_creating_an_agent_makes_all_three_things_at_once(db):
    """Identity, permission, credential. An agent with a token and no grant can
    authenticate and do nothing; one with a grant and no token is a permission
    nobody holds. Neither is a state worth being able to reach."""
    from commonindex.core.authz.store import hash_token

    got = await _create(db, agent_id="whole")
    assert got["token"].startswith("ci_")
    assert await db.fetchval("select owner_id from actors where id='whole'") == "maya"
    assert await db.fetchval(
        "select relation from grants where subject='whole'") == "propose"
    # Only the hash is stored. A dump of `actor_tokens` must not let the reader
    # authenticate as anyone.
    assert await db.fetchval(
        "select token_hash from actor_tokens where actor_id='whole'"
    ) == hash_token(got["token"])
    assert await db.fetchval(
        "select 1 from actor_tokens where token_hash = $1", got["token"]) is None


async def test_an_agent_cannot_answer_for_an_agent(db):
    """A CHECK cannot read another row, so the rule lives in the handler.
    Without it the accountability chain can be a ring: two agents naming each
    other, and nobody answering for either."""
    import json

    r = await _create(db, agent_id="ring", owner_id="scribe")
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["code"] == "owner_not_human"


async def test_whoever_creates_an_agent_owns_it_unless_they_name_someone(db):
    """Creating an agent is an admin's operation and admins manage every agent,
    so the form asks nobody to pick an owner: the creator is it."""
    r = await _create(db, agent_id="mine", owner_id=None)
    assert not hasattr(r, "status_code"), r
    assert await db.fetchval("select owner_id from actors where id = 'mine'") == "maya"


async def test_an_owner_who_does_not_exist_is_refused(db):
    import json

    r = await _create(db, agent_id="orphaned", owner_id="nobody")
    assert r.status_code == 404
    assert json.loads(r.body)["error"]["field"] == "owner_id"


async def test_a_tier_outside_the_model_is_refused_with_the_model(db):
    import json

    r = await _create(db, agent_id="tiered", trust_tier="fully-trusted")
    assert r.status_code == 422
    assert "propose-only" in json.loads(r.body)["error"]["message"]


async def test_an_id_that_would_need_quoting_is_refused(db):
    """It appears in `created_by` on everything the agent makes, in grant
    subjects, and in the MCP config a client is handed."""
    import json

    for bad in ("Has Spaces", "UPPER", "x", "-leading", "trailing-"):
        r = await _create(db, agent_id=bad)
        assert r.status_code == 422, bad
        assert json.loads(r.body)["error"]["field"] == "agent_id"


async def test_creating_the_same_agent_twice_is_refused_not_duplicated(db):
    import json

    await _create(db, agent_id="twice")
    r = await _create(db, agent_id="twice")
    assert r.status_code == 409
    assert json.loads(r.body)["error"]["code"] == "actor_exists"


async def test_an_agent_may_be_made_with_no_grant_at_all(db):
    """It can authenticate and do nothing, which is a legitimate starting
    point — and `agents.list` says so rather than leaving it to be inferred."""
    from commonindex.gateway.agents import _agents

    await _create(db, agent_id="ungranted", grant=None)
    got = {a["id"]: a for a in await _agents(db, "pay")}["ungranted"]
    assert got["may"] == []


async def test_revoking_destroys_the_credentials_and_keeps_the_record(db):
    """An agent that cannot authenticate and holds no permission is off. An
    agent whose history has been deleted is a governance hole wearing the word
    'revoked'."""
    from commonindex.gateway.agents import agents_revoke

    await _create(db, agent_id="offswitch")
    await db.execute(
        "insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
        " values ('doc-off','pay','doc','D-OFF','Made before revocation','offswitch',"
        " '{space:pay}') on conflict (id) do nothing")

    got = await agents_revoke(_Req({"agent_id": "offswitch"}, db))
    assert got["tokens_destroyed"] == 1
    assert got["grants_removed"] == 1
    assert await db.fetchval("select count(*) from actor_tokens where actor_id='offswitch'") == 0
    assert await db.fetchval("select count(*) from grants where subject='offswitch'") == 0
    # The actor, and what it made, survive.
    assert await db.fetchval("select 1 from actors where id='offswitch'") == 1
    assert await db.fetchval("select created_by from objects where id='doc-off'") == "offswitch"


async def test_revoking_something_that_is_not_an_agent_is_refused(db):
    import json

    from commonindex.gateway.agents import agents_revoke

    r = await agents_revoke(_Req({"agent_id": "maya"}, db))
    assert r.status_code == 404
    assert json.loads(r.body)["error"]["code"] == "unknown_agent"


def test_both_operations_need_admin():
    """Minting a credential is an administrative act, like every other
    operation in `access`."""
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register

    reg = Registry()
    register(reg)
    for name in ("agents.create", "agents.revoke"):
        op = reg.get(name)
        assert op.relation == "admin" and op.mutating, name


# ── asking an agent for something, and it answering ────────────────────


_KEYS = itertools.count()


async def _ask(db, **over):
    """A fresh idempotency key each call unless one is named. The seeded
    database is shared across this module, and a key is unique per space
    forever — which is the point of it, and would otherwise make the second
    test to call this get the first test's event back."""
    from commonindex.gateway.agents import agents_ask

    body = {"agent_id": "worker", "note": "have a look at this",
            "idempotencyKey": f"ask-{next(_KEYS)}", **over}
    return await agents_ask(_Req(body, db))


async def _worker(db, agent_id="worker"):
    """An agent that exists, holds a grant in `pay`, and can therefore be asked.
    Tolerates already existing, since the module seeds once."""
    await _create(db, agent_id=agent_id)
    return agent_id


async def test_an_ask_is_written_to_the_log_and_not_to_a_queue(db):
    """The append-only log already records who acted, on what, and in what
    order. A queue table beside it would be a second history — one that agrees
    with the first until the day it does not."""
    await _worker(db)
    before = await db.fetchval("select count(*) from events where verb='asked'")
    got = await _ask(db, note="check the panels cite ratified definitions")

    row = await db.fetchrow("select * from events where seq = $1 and space_id='pay'",
                            got["seq"])
    assert row["verb"] == "asked"
    assert row["actor_id"] == "maya"        # who asked, not who was asked
    payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
    assert payload["agent"] == "worker"
    assert payload["note"] == "check the panels cite ratified definitions"
    assert await db.fetchval("select count(*) from events where verb='asked'") == before + 1


async def test_the_ask_takes_the_next_sequence_number_for_the_space(db):
    """Ordering comes from the same counter every other event uses, so an ask
    interleaves with the rest of the history rather than sitting outside it."""
    await _worker(db)
    first = (await _ask(db, idempotencyKey="s1"))["seq"]
    second = (await _ask(db, idempotencyKey="s2"))["seq"]
    assert second == first + 1
    assert await db.fetchval(
        "select next_seq from space_seq where space_id='pay'") == second + 1


async def test_asking_twice_under_one_key_does_not_ask_twice(db):
    """A retried request must not append a second time — the log cannot take
    an entry back."""
    await _worker(db)
    first = await _ask(db, idempotencyKey="same")
    again = await _ask(db, idempotencyKey="same", note="different words entirely")

    assert again["seq"] == first["seq"] and again["repeat"] is True
    assert await db.fetchval(
        "select count(*) from events where payload->>'key' = 'same'") == 1
    # The first wording stands. A key means "this request", not "this text".
    assert await db.fetchval(
        "select payload->>'note' from events where seq = $1", first["seq"]
    ) == "have a look at this"


async def test_an_ask_with_no_words_is_refused(db):
    """Tagging is not asking. An agent that reads `asked` with an empty note
    knows a person pointed at it and nothing about what they wanted."""
    await _worker(db)
    r = await _ask(db, note="   ")
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["code"] == "no_note"


async def test_an_agent_that_could_not_act_here_cannot_be_asked(db):
    """Otherwise the ask sits in an inbox forever: the agent authenticates,
    reads it, and holds no permission to do any of it."""
    await _create(db, agent_id="powerless", grant=None)
    r = await _ask(db, agent_id="powerless")
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["code"] == "no_grant_here"


async def test_asking_a_person_is_refused(db):
    r = await _ask(db, agent_id="maya")
    assert r.status_code == 404
    assert json.loads(r.body)["error"]["code"] == "unknown_agent"


async def test_the_inbox_defaults_to_the_caller(db):
    """The case that matters: an agent connects with its own token over MCP and
    asks what it should be doing."""
    from commonindex.gateway.agents import agents_inbox

    await _worker(db, "listener")
    await _ask(db, agent_id="listener", note="the thing")
    got = await agents_inbox(_Req({}, db, actor="listener"))
    assert got["agent_id"] == "listener"
    assert [a["note"] for a in got["asks"]] == ["the thing"]
    assert got["asks"][0]["asked_by"] == "maya"


async def test_an_ask_about_an_object_carries_it_into_the_inbox(db):
    """So the agent is told what it is about without a second round trip."""
    from commonindex.gateway.agents import agents_inbox

    await _worker(db, "reader")
    await db.execute(
        "insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
        " values ('doc-ask','pay','doc','D-ASK','Payout readout','maya','{space:pay}')"
        " on conflict (id) do nothing")
    await _ask(db, agent_id="reader", object_id="doc-ask")

    got = await agents_inbox(_Req({}, db, actor="reader"))
    assert got["asks"][0]["object"] == {"id": "doc-ask", "type": "doc",
                                        "title": "Payout readout"}


async def test_an_ask_about_an_object_in_another_space_is_refused(db):
    """The authenticated space bounds the ask, so a caller cannot point an
    agent at a tenant they cannot see."""
    await _worker(db)
    await db.execute(
        "insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
        " values ('doc-far','growth','doc','D-FAR','Elsewhere','maya','{space:growth}')"
        " on conflict (id) do nothing")
    r = await _ask(db, object_id="doc-far")
    assert r.status_code == 404
    assert json.loads(r.body)["error"]["field"] == "object_id"


async def test_starting_a_run_is_what_empties_the_inbox(db):
    """Not a flag on the ask. `runs.trigger_seq` already says which event a run
    answers, and a status column beside it would be a second place the truth
    lives."""
    from commonindex.gateway.agents import agents_inbox, runs_start

    await _worker(db, "claimer")
    seq = (await _ask(db, agent_id="claimer"))["seq"]
    me = _Req({"trigger_seq": seq, "idempotencyKey": "r"}, db, actor="claimer")
    run = await runs_start(me)

    assert (await agents_inbox(_Req({}, db, actor="claimer")))["asks"] == []
    assert await db.fetchval(
        "select trigger_seq from runs where id = $1", run["run_id"]) == seq
    # Nothing was written to the event itself.
    payload = await db.fetchval("select payload from events where seq = $1", seq)
    payload = json.loads(payload) if isinstance(payload, str) else payload
    assert set(payload) == {"agent", "note", "key"}


async def test_two_workers_cannot_both_claim_one_ask(db):
    from commonindex.gateway.agents import runs_start

    await _worker(db)
    seq = (await _ask(db))["seq"]
    await runs_start(_Req({"trigger_seq": seq, "idempotencyKey": "r1"}, db, actor="worker"))
    r = await runs_start(_Req({"trigger_seq": seq, "idempotencyKey": "r2"}, db, actor="worker"))

    assert r.status_code == 409
    assert json.loads(r.body)["error"]["code"] == "already_started"
    assert await db.fetchval(
        "select count(*) from runs where trigger_seq = $1 and space_id='pay'", seq) == 1


async def test_an_agent_cannot_claim_an_ask_addressed_to_another(db):
    """Both hold `propose` in this space, so the grant cannot separate them.
    Whose queue it was in is a different question from what they may do."""
    from commonindex.gateway.agents import runs_start

    await _worker(db)
    await _worker(db, "nosy")
    seq = (await _ask(db))["seq"]

    r = await runs_start(_Req({"trigger_seq": seq, "idempotencyKey": "r"}, db, actor="nosy"))
    assert r.status_code == 403
    assert "'worker'" in json.loads(r.body)["error"]["message"]


async def test_a_run_ends_asking_when_the_agent_stops_for_a_person(db):
    """`asking` is a right answer, not a failure — an agent that reached a
    judgement call a person should make and stopped has behaved well."""
    from commonindex.gateway.agents import runs_finish, runs_start

    await _worker(db)
    seq = (await _ask(db))["seq"]
    run = await runs_start(_Req({"trigger_seq": seq, "idempotencyKey": "r"}, db, actor="worker"))
    got = await runs_finish(_Req(
        {"run_id": run["run_id"], "status": "asking", "cost_tokens": 4120,
         "cost_usd": 0.06, "idempotencyKey": "f"}, db, actor="worker"))

    assert got["status"] == "asking"
    row = await db.fetchrow("select status, cost_tokens, cost_usd, ended_at"
                            " from runs where id = $1", run["run_id"])
    assert row["status"] == "asking" and row["cost_tokens"] == 4120
    assert row["ended_at"] is not None


async def test_a_run_cannot_be_finished_twice(db):
    from commonindex.gateway.agents import runs_finish, runs_start

    await _worker(db)
    seq = (await _ask(db))["seq"]
    run = await runs_start(_Req({"trigger_seq": seq, "idempotencyKey": "r"}, db, actor="worker"))
    end = {"run_id": run["run_id"], "status": "done", "idempotencyKey": "f"}
    await runs_finish(_Req(end, db, actor="worker"))
    r = await runs_finish(_Req(end, db, actor="worker"))

    assert r.status_code == 409
    assert json.loads(r.body)["error"]["code"] == "already_finished"


async def test_an_agent_cannot_finish_a_run_that_is_not_its_own(db):
    """Cost lands on the agent that ran, and this is what keeps that true."""
    from commonindex.gateway.agents import runs_finish, runs_start

    await _worker(db)
    await _worker(db, "nosy")
    seq = (await _ask(db))["seq"]
    run = await runs_start(_Req({"trigger_seq": seq, "idempotencyKey": "r"}, db, actor="worker"))
    r = await runs_finish(_Req(
        {"run_id": run["run_id"], "status": "done", "idempotencyKey": "f"}, db, actor="nosy"))

    assert r.status_code == 403
    assert await db.fetchval("select status from runs where id=$1", run["run_id"]) == "running"


async def test_a_status_outside_the_model_is_refused_with_the_model(db):
    from commonindex.gateway.agents import runs_finish, runs_start

    await _worker(db)
    seq = (await _ask(db))["seq"]
    run = await runs_start(_Req({"trigger_seq": seq, "idempotencyKey": "r"}, db, actor="worker"))
    r = await runs_finish(_Req(
        {"run_id": run["run_id"], "status": "failed", "idempotencyKey": "f"},
        db, actor="worker"))

    assert r.status_code == 422
    assert "asking" in json.loads(r.body)["error"]["message"]


def test_asking_needs_propose_and_not_admin():
    """Pointing an agent at work is ordinary collaboration. Minting one is
    administrative — the two must not need the same permission, or every team
    that wants to use an agent gets handed the keys to make them."""
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register

    reg = Registry()
    register(reg)
    assert reg.get("agents.create").relation == "admin"
    for name in ("agents.ask", "runs.start", "runs.finish"):
        assert reg.get(name).relation == "propose", name
    assert reg.get("agents.inbox").relation == "read"

async def test_the_database_refuses_a_second_run_for_one_ask(db):
    """`runs.start` SELECTs for an existing run and then inserts, with nothing
    between the two: two workers that both read before either writes both pass
    the check and both insert. The sequential handler test above proves the
    check exists; it cannot prove the check is a mutex, and it wasn't.

    `runs_one_per_ask` (0018) is what actually makes "one run per ask" true —
    the property claimed in the handler, its tests, and the commit that shipped
    it. Asserted here against the constraint directly, because a test that
    races two coroutines passes whether or not the index exists: the interleave
    that breaks it is not one asyncio is obliged to produce.
    """
    import asyncpg

    await _worker(db, "racer")
    seq = (await _ask(db, agent_id="racer"))["seq"]
    ins = ("insert into runs (id, space_id, agent_id, trigger_seq, status)"
           " values ($1,'pay','racer',$2,'running')")

    await db.execute(ins, "run-first", seq)
    with pytest.raises(asyncpg.exceptions.UniqueViolationError):
        await db.execute(ins, "run-second", seq)

    assert await db.fetchval(
        "select count(*) from runs where space_id='pay' and trigger_seq = $1", seq) == 1
    # Runs nobody asked for do not collide with each other — every seeded run
    # in this fixture has a null trigger_seq, which is why the index is partial.
    assert await db.fetchval("select count(*) from runs where trigger_seq is null") > 1


async def test_the_loser_of_that_race_gets_a_409_not_a_crash(db):
    """The constraint makes the second insert fail; this makes it fail politely.
    Reaching the handler's except branch needs the state the race produces — a
    row the SELECT missed and the INSERT collides with — so the check is stubbed
    to return the stale answer it would have read a millisecond too early.
    """
    from commonindex.gateway.agents import runs_start

    await _worker(db, "loser")
    seq = (await _ask(db, agent_id="loser"))["seq"]
    await db.execute(
        "insert into runs (id, space_id, agent_id, trigger_seq, status)"
        " values ('run-won','pay','loser',$1,'running')", seq)

    class _StaleRead:
        """asyncpg connections are read-only, so the stale answer is served by a
        proxy in front of one rather than by patching it."""

        def __init__(self, conn): self._c = conn

        async def fetchval(self, query, *args):
            # Only the existence check lies; the payload lookup must still work.
            if "from runs where space_id" in query:
                return None
            return await self._c.fetchval(query, *args)

        def __getattr__(self, name): return getattr(self._c, name)

    r = await runs_start(
        _Req({"trigger_seq": seq, "idempotencyKey": "x"}, _StaleRead(db), actor="loser"))

    assert r.status_code == 409
    assert json.loads(r.body)["error"]["code"] == "already_started"


# ── a type's schema is a constraint, so something checks it ────────────


_TYPES = pathlib.Path(__file__).resolve().parent.parent / "types"



async def _open_to_workspace(db, object_id):
    """Review is a workspace's: these tests open the item to it first, as a
    team would before asking for review. Access itself is tested in
    tests/test_sharing.py."""
    await db.execute("update objects set acl_keys = array['space:' || space_id] where id = $1", object_id)


def _design_type():
    from commonindex.core.registry.types import load_dir
    return next(t for t in load_dir(_TYPES) if t.id == "design")


async def _propose_design(db, **over):
    from commonindex.gateway.collections import make_propose

    body = {"title": "Checkout", "surface": "mobile",
            "spec": {"screens": [{"id": "s", "name": "Cart", "w": 390, "h": 844,
                                  "elements": []}]},
            "idempotencyKey": f"d-{next(_KEYS)}", **over}
    out = await make_propose(_design_type())(_Req(body, db))
    if isinstance(out, dict) and out.get("id"):
        await _open_to_workspace(db, out["id"])
    return out


async def test_a_valid_design_proposes(db):
    got = await _propose_design(db)
    assert got["type"] == "design" and got["created"] is True


async def test_a_design_whose_spec_is_markup_is_refused(db):
    """The claim this type makes is that a design is a spec and never markup.
    That held only because the schema has no field markup fits in — which is
    only a constraint if something reads the schema. Nothing did: `propose`
    checked that required fields were non-empty and wrote whatever shape it was
    handed, so `spec` could be a string containing HTML.
    """
    r = await _propose_design(db, spec="<div onclick='steal()'>Cart</div>")
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["code"] == "invalid_props"
    assert json.loads(r.body)["error"]["field"] == "spec"


async def test_an_element_role_outside_the_catalog_is_refused(db):
    """The roles ARE the catalog — the fixed vocabulary a renderer can draw and
    a model has to compose within. A role nothing can draw is a design that
    renders as a hole."""
    r = await _propose_design(db, spec={"screens": [{
        "id": "s", "name": "Cart", "w": 390, "h": 844,
        "elements": [{"id": "e", "role": "iframe", "x": 0, "y": 0, "w": 10, "h": 10}]}]})
    assert r.status_code == 422
    assert "iframe" in json.loads(r.body)["error"]["message"]


async def test_an_element_without_geometry_is_laid_out_rather_than_refused(db):
    """This used to be refused, and the rule was right when every element carried
    absolute coordinates. Containers changed it: an element inside one is placed
    by the layout, and demanding coordinates for it would be asking the model to
    compute what flexbox already knows."""
    got = await _propose_design(db, spec={"screens": [{
        "id": "s", "name": "Cart", "w": 390, "h": 844,
        "elements": [
            {"id": "row", "role": "card", "layout": "row", "gap": 8,
             "x": 0, "y": 0, "w": 390, "h": 80,
             "children": [{"id": "a", "role": "button", "text": "One"},
                          {"id": "b", "role": "button", "text": "Two"}]}]}]})
    assert got["created"] is True


async def test_a_screen_still_has_to_have_a_size(db):
    """The screen is the frame. An element can be placed by a container; the
    frame has nothing to be placed by, and the renderer divides by its width."""
    r = await _propose_design(db, spec={"screens": [
        {"id": "s", "name": "Cart", "elements": []}]})
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["code"] == "invalid_props"


async def test_the_rule_is_every_type_not_a_design_special_case(db):
    """Same check, a different type: a task whose state is none of its four.
    `ObjectType.schema` calls itself the constraint jsonb lacks, and it is one
    for whatever declares it."""
    from commonindex.core.registry.types import load_dir
    from commonindex.gateway.collections import make_propose

    task = next(t for t in load_dir(_TYPES) if t.id == "task")
    r = await make_propose(task)(_Req(
        {"title": "Ship it", "state": "banana", "idempotencyKey": "t-bad"}, db))
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["field"] == "state"


# ── generating a design from a brief ───────────────────────────────────


def _fake_model(obj, record=None):
    """A generator that returns a canned object and remembers what it was asked.

    The point of the injection seam: everything between the brief and the
    validated spec is covered without a key, a network or a bill. What is not
    covered is the one function that actually speaks HTTP to a provider, which
    is where that boundary belongs.
    """
    async def gen(*, system, prompt, schema, max_tokens=8000):
        if record is not None:
            record.update(system=system, prompt=prompt, schema=schema)
        return obj, {"input_tokens": 11, "output_tokens": 22}
    return gen


_GOOD_SPEC = {"screens": [{"id": "s1", "name": "Settings", "w": 390, "h": 844,
                           "elements": [{"id": "h", "role": "heading", "text": "Settings",
                                         "cites": "color.text",
                                         "x": 16, "y": 64, "w": 358, "h": 34}]}]}


async def _generate(db, obj, record=None, **over):
    from commonindex.gateway.designs import designs_generate

    body = {"brief": "a settings screen with notification toggles",
            "surface": "mobile", **over}
    req = _Req(body, db)
    req.app.state.commonindex["generate"] = _fake_model(obj, record)
    return await designs_generate(req)


async def test_a_brief_comes_back_as_a_spec(db):
    got = await _generate(db, {"title": "Settings", "spec": _GOOD_SPEC,
                               "rationale": "one screen, one list"})
    assert got["title"] == "Settings"
    assert got["spec"]["screens"][0]["name"] == "Settings"
    assert got["usage"] == {"input_tokens": 11, "output_tokens": 22}


async def test_generating_files_nothing(db):
    """Generating is cheap to redo; filing is a proposal somebody reviews. A
    generator that wrote on its own would put an unreviewed object in the graph
    every time somebody reworded a sentence."""
    before = await db.fetchval("select count(*) from objects where type='design'")
    await _generate(db, {"title": "Settings", "spec": _GOOD_SPEC})
    assert await db.fetchval("select count(*) from objects where type='design'") == before


async def test_the_models_answer_is_checked_not_trusted(db):
    """Structured output makes the answer CONFORM to a schema; it does not make
    it true, and the provider is the one place the platform cannot enforce
    anything. A model that returns markup is a model that gets refused."""
    r = await _generate(db, {"title": "Settings", "spec": "<div>Settings</div>"})
    assert r.status_code == 502
    assert json.loads(r.body)["error"]["code"] == "model_output_invalid"


async def test_a_role_the_renderer_cannot_draw_is_refused(db):
    bad = {"screens": [{"id": "s", "name": "S", "w": 390, "h": 844,
                        "elements": [{"id": "e", "role": "webview",
                                      "x": 0, "y": 0, "w": 10, "h": 10}]}]}
    r = await _generate(db, {"title": "S", "spec": bad})
    assert r.status_code == 502
    assert "webview" in json.loads(r.body)["error"]["message"]


async def test_the_output_contract_is_the_types_own_schema(db):
    """Not a copy kept in step by hand. The roles a model may compose with are
    the roles the renderer draws and the roles `propose` accepts, because all
    three read one object."""
    from commonindex.gateway.app import TYPES
    from commonindex.gateway.designs import output_schema

    # NOT identity. The first version asserted `is`, which looked like the
    # strongest possible claim and was in fact the bug: structured outputs
    # rejects `{"type": ["string","null"]}` and a schema-valued
    # `additionalProperties`, both of which the design type uses, so handing
    # the same object over guaranteed a 400 on every call. What has to hold is
    # that the vocabulary is the same and the translation is faithful.
    design = next(t for t in TYPES if t.id == "design")
    seen: dict = {}
    await _generate(db, {"title": "S", "spec": _GOOD_SPEC}, record=seen)
    gen = seen["schema"]
    el = (gen["properties"]["spec"]["properties"]["screens"]["items"]
             ["properties"]["elements"]["items"]["properties"])
    src = (design.schema["properties"]["spec"]["properties"]["screens"]["items"]
                 ["properties"]["elements"]["items"]["properties"])
    assert el["role"]["enum"] == src["role"]["enum"]
    assert el["tone"]["enum"] == src["tone"]["enum"]
    # and the constructs the API refuses are gone
    blob = json.dumps(gen)
    assert '"type": [' not in blob
    assert '"additionalProperties": {' not in blob
    assert "tokens" not in gen["properties"]["spec"].get("properties", {})
    # the translation must not have mutated what `propose` validates against
    assert "tokens" in design.schema["properties"]["spec"]["properties"]
    assert output_schema(design)["required"] == ["title", "spec", "rationale"]


async def test_citing_a_template_grounds_the_brief_in_its_tokens(db):
    """This is what makes a generated screen land on-system instead of
    inventing a fourth blue: the model is told the token paths that exist and
    told not to invent others."""
    await db.execute(
        "insert into objects (id, space_id, type, key, title, props, created_by)"
        " values ('design-tpl','pay','design','DES-T','House style',$1::jsonb,'maya')"
        " on conflict (id) do nothing",
        json.dumps({"title": "House style", "surface": "mobile", "state": "approved",
                    "spec": {"tokens": {"color.accent": {"$value": "#0f766e"},
                                        "radius.md": {"$value": 12}},
                             "screens": []}}))
    seen: dict = {}
    got = await _generate(db, {"title": "S", "spec": _GOOD_SPEC}, record=seen,
                          cites="design-tpl")
    assert "color.accent" in seen["prompt"] and "radius.md" in seen["prompt"]
    assert "invent no others" in seen["prompt"]
    assert got["grounded_in"] == "House style"
    assert got["cites"] == ["design-tpl"]


async def test_citing_a_design_in_another_space_is_refused(db):
    r = await _generate(db, {"title": "S", "spec": _GOOD_SPEC}, cites="design-nope")
    assert r.status_code == 404
    assert json.loads(r.body)["error"]["field"] == "cites"


async def test_no_provider_says_which_variable_to_set(db):
    """An error naming the variable is an operator fixing this in a minute; one
    saying "AI is unavailable" is a bug report."""
    from commonindex.gateway.designs import designs_generate

    req = _Req({"brief": "anything", "surface": "mobile"}, db)
    req.app.state.commonindex.pop("generate", None)
    import os

    old = os.environ.pop("COMMONINDEX_MODEL_PROVIDER", None)
    try:
        r = await designs_generate(req)
    finally:
        if old is not None:
            os.environ["COMMONINDEX_MODEL_PROVIDER"] = old
    assert r.status_code == 503
    assert json.loads(r.body)["error"]["code"] == "model_unconfigured"
    assert "COMMONINDEX_MODEL_PROVIDER" in json.loads(r.body)["error"]["message"]


def test_a_base_url_pointing_back_inside_the_network_is_blocked():
    """A proxy that dials whatever it is handed is a confused deputy: the caller
    supplies the address and the gateway supplies the network position, so link
    -local reads cloud metadata with the platform's standing."""
    import pytest

    from commonindex.adapters.model import Blocked, check_base_url

    for bad in ("http://169.254.169.254/latest/meta-data/",
                "http://10.0.0.5:8000", "http://192.168.1.10", "http://localhost:11434",
                "file:///etc/passwd"):
        with pytest.raises(Blocked):
            check_base_url(bad)

    # A genuinely local model is the one case loopback is the right answer.
    check_base_url("http://localhost:11434", allow_loopback=True)
    check_base_url("https://api.anthropic.com")


async def test_a_follow_up_refines_instead_of_restarting(db):
    """"Make the CTA secondary" means nothing on its own. Sending the current
    spec is what turns a second brief into a change rather than a new design,
    and the conversation lives in the caller so this stays a request and not a
    run with state to resume."""
    seen: dict = {}
    await _generate(db, {"title": "Settings", "spec": _GOOD_SPEC}, record=seen,
                    brief="make the heading smaller", base=_GOOD_SPEC)
    assert "Apply this change: make the heading smaller" in seen["prompt"]
    assert "Settings" in seen["prompt"]          # the current spec went with it
    assert "COMPLETE updated spec" in seen["prompt"]
    assert "including its id" in seen["prompt"]  # so the diff is the change


async def test_a_first_turn_still_reads_as_a_brief(db):
    seen: dict = {}
    await _generate(db, {"title": "S", "spec": _GOOD_SPEC}, record=seen)
    assert "Design a mobile interface" in seen["prompt"]
    assert "Apply this change" not in seen["prompt"]


async def test_an_invalid_base_is_refused_rather_than_laundered(db):
    """The base arrives from the caller, so it is checked like anything else a
    caller sends. Feeding a bad spec to the model and filing what comes back
    would launder it: the output would be built on something `propose` refuses,
    and the refusal would arrive one step too late to explain why."""
    r = await _generate(db, {"title": "S", "spec": _GOOD_SPEC},
                        brief="tidy it up", base={"screens": "not a list"})
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["code"] == "bad_base"
    assert json.loads(r.body)["error"]["field"] == "base"


async def test_a_refined_answer_is_checked_like_any_other(db):
    r = await _generate(db, {"title": "S", "spec": {"screens": [{"id": "s", "name": "S",
                        "w": 390, "h": 844, "elements": [{"id": "e", "role": "marquee",
                        "x": 0, "y": 0, "w": 1, "h": 1}]}]},
                        }, brief="add a marquee", base=_GOOD_SPEC)
    assert r.status_code == 502
    assert json.loads(r.body)["error"]["code"] == "model_output_invalid"


def test_the_ssrf_guard_fails_closed():
    """It failed OPEN. `getaddrinfo` raising left the candidate list empty, the
    validation loop never ran, and the function returned normally — so any host
    that did not resolve at check time was allowed outright and the SDK then
    resolved it independently. Worse than the rebinding window the docstring
    admitted to, and not mentioned in it."""
    import pytest

    from commonindex.adapters.model import Blocked, check_base_url

    for bad, why in [
        ("http://nonexistent-host-abcxyz-12345.invalid/v1", "does not resolve"),
        ("http://100.64.0.1:8080/v1", "RFC 6598 CGNAT — EKS, GKE and Tailscale"),
        ("http://api.anthropic.com", "cleartext carries the key in a header"),
        ("http://169.254.169.254/", "cloud metadata"),
        ("http://[::ffff:169.254.169.254]/", "v4-mapped metadata"),
        ("http://0.0.0.0/", "unspecified"),
    ]:
        with pytest.raises(Blocked):
            check_base_url(bad)
    check_base_url("https://api.anthropic.com")


def test_a_local_provider_unblocks_loopback_and_nothing_else():
    """`allow_loopback` gated the whole never-list, so running a model on this
    box also unblocked the cloud metadata endpoint."""
    import pytest

    from commonindex.adapters.model import Blocked, check_base_url

    check_base_url("http://localhost:11434", allow_loopback=True)
    with pytest.raises(Blocked):
        check_base_url("http://metadata.google.internal", allow_loopback=True)


def test_the_api_key_is_not_in_a_providers_repr():
    """A dataclass prints its fields, so one logging.exception touching a
    Provider would put the org's credential in the log."""
    from commonindex.adapters.model import Provider

    assert "hunter2" not in repr(Provider(kind="anthropic", api_key="hunter2", model="m"))


async def test_markup_cannot_be_smuggled_into_a_spec(db):
    """"A design is a spec and never markup" was true of every field the schema
    NAMED. No object in `spec` set additionalProperties: false, so an unnamed
    one was unconstrained and persisted verbatim into props."""
    for label, spec in [
        ("a field beside screens", {"screens": [], "html": "<script>alert(1)</script>"}),
        ("a handler on an element", {"screens": [{"id": "s", "name": "S", "w": 390,
            "h": 844, "elements": [{"id": "e", "role": "button", "x": 0, "y": 0,
                                    "w": 1, "h": 1, "onclick": "steal()"}]}]}),
    ]:
        r = await _propose_design(db, spec=spec)
        assert r.status_code == 422, label
        assert json.loads(r.body)["error"]["code"] == "invalid_props", label


async def test_a_screen_with_no_size_is_refused(db):
    """The renderer divides by the screen's width to fit the drawing, so a zero
    produced viewBox="0 0 0 0" and height="NaN" — a design that stored fine and
    drew nothing."""
    r = await _propose_design(db, spec={"screens": [
        {"id": "s", "name": "S", "w": 0, "h": 0, "elements": []}]})
    assert r.status_code == 422


# ── a design you can come back to tomorrow ─────────────────────────────


async def _revise(db, design_id, **over):
    from commonindex.gateway.designs import designs_revise

    body = {"design_id": design_id, "idempotencyKey": f"rv-{next(_KEYS)}", **over}
    return await designs_revise(_Req(body, db))


async def _history(db, design_id):
    from commonindex.gateway.designs import designs_history

    return await designs_history(_Req({"design_id": design_id, "with_spec": True}, db))


async def _a_design(db, **over):
    got = await _propose_design(db, **over)
    assert not hasattr(got, "status_code"), got
    return got["id"]


async def test_revising_keeps_what_it_replaced(db):
    """The whole point. A draft used to live in a browser tab: navigating away
    lost it, and there was no way back to yesterday's version of anything."""
    did = await _a_design(db, title="Settings")
    two = {"screens": [{"id": "s2", "name": "Second", "w": 390, "h": 844, "elements": []}]}
    got = await _revise(db, did, spec=two, note="try a different first screen")

    assert got["rev"] == 2
    assert await db.fetchval("select current_rev from objects where id = $1", did) == 2
    hist = await _history(db, did)
    assert [r["rev"] for r in hist["revisions"]] == [2]
    assert hist["revisions"][0]["note"] == "try a different first screen"
    assert hist["revisions"][0]["spec"]["screens"][0]["name"] == "Second"


async def test_the_history_lists_without_specs_and_hands_one_over_by_rev(db):
    """The panel draws who, when and why; a spec is fetched only to restore it."""
    from commonindex.gateway.designs import designs_history

    did = await _a_design(db, title="Lean")
    two = {"screens": [{"id": "s2", "name": "Second", "w": 390, "h": 844, "elements": []}]}
    await _revise(db, did, spec=two, note="second")
    listed = await designs_history(_Req({"design_id": did}, db))
    row = listed["revisions"][0]
    assert "spec" not in row and row["has_spec"] is True and row["screens"] == 1
    one = await designs_history(_Req({"design_id": did, "rev": row["rev"]}, db))
    assert [r["rev"] for r in one["revisions"]] == [row["rev"]]
    assert one["revisions"][0]["spec"]["screens"][0]["name"] == "Second"


async def test_the_object_carries_the_new_spec_and_the_history_the_old(db):
    did = await _a_design(db, title="Cart")
    first = await db.fetchval("select props->'spec' from objects where id = $1", did)
    await _revise(db, did, spec={"screens": []}, note="empty it")

    now = json.loads(await db.fetchval("select props->>'spec' from objects where id = $1", did))
    assert now["screens"] == []
    # and the first version is still reachable
    hist = await _history(db, did)
    assert hist["revisions"][0]["spec"]["screens"] == []
    assert json.loads(first)["screens"], "the original had screens"


async def test_restoring_is_itself_a_revision_not_a_rewind(db):
    """Going back is recorded. A restore that quietly rewound the record would
    make the history a worse account of what happened than no history."""
    did = await _a_design(db, title="Home")
    original = json.loads(await db.fetchval(
        "select props->>'spec' from objects where id = $1", did))
    await _revise(db, did, spec={"screens": []}, note="a wrong turn")
    await _revise(db, did, spec=original, note="restore rev 1")

    assert await db.fetchval("select current_rev from objects where id = $1", did) == 3
    hist = await _history(db, did)
    assert [r["rev"] for r in hist["revisions"]] == [3, 2]
    assert hist["revisions"][0]["note"] == "restore rev 1"
    now = json.loads(await db.fetchval("select props->>'spec' from objects where id = $1", did))
    assert now == original


async def test_a_revision_is_checked_against_the_type_like_anything_else(db):
    """Same door, same guard. A spec that `propose` refuses must not get in
    through `revise` — otherwise the constraint is a front-door policy."""
    did = await _a_design(db, title="Guarded")
    r = await _revise(db, did, spec={"screens": [], "html": "<script>x</script>"})
    assert r.status_code == 422
    assert json.loads(r.body)["error"]["code"] == "invalid_props"
    assert await db.fetchval("select current_rev from objects where id = $1", did) == 1


async def test_revising_a_design_in_another_space_is_refused(db):
    r = await _revise(db, "design-does-not-exist", spec={"screens": []})
    assert r.status_code == 404
    assert json.loads(r.body)["error"]["field"] == "design_id"


async def test_history_names_who_changed_it(db):
    did = await _a_design(db, title="Attributed")
    await _revise(db, did, spec={"screens": []}, note="n")
    hist = await _history(db, did)
    assert hist["revisions"][0]["by"] in ("maya", "Maya")


# ── designing against work already in the workspace ────────────────────


async def _references(db, design_id):
    from commonindex.gateway.designs import designs_references

    return await designs_references(_Req({"design_id": design_id}, db))


async def test_a_design_records_what_it_was_drawn_from(db):
    """`sources` was declared on the type, rendered on the detail page, and
    written by nothing. It is the part of this no design tool outside the
    platform can have: the reference is an object in the same graph, so
    provenance is a join rather than a pasted link that rots."""
    did = await _a_design(db, title="Refunds screen")
    await db.execute(
        "insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
        " values ('task-ref','pay','task','T-9','Let people cancel a refund','maya',"
        " '{space:pay}') on conflict (id) do nothing")
    await _revise(db, did, sources=["task-ref"], note="cite the task that asked for it")

    got = await _references(db, did)
    assert [r["title"] for r in got["references"]] == ["Let people cancel a refund"]
    assert got["references"][0]["type"] == "task"
    assert got["stale"] is False


async def test_a_design_goes_stale_when_what_it_was_drawn_from_moves(db):
    """Not "old". A design is not wrong because time passed — it is wrong
    because the thing it was drawn from changed and nobody looked again."""
    did = await _a_design(db, title="Follows a task")
    await db.execute(
        "insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
        " values ('task-moves','pay','task','T-10','Original wording','maya',"
        " '{space:pay}') on conflict (id) do nothing")
    await _revise(db, did, sources=["task-moves"], note="cite it")
    assert (await _references(db, did))["stale"] is False

    # the task is reworded after the design was last touched
    await db.execute("update objects set title = 'Reworded', updated_at = now()"
                     " + interval '1 second' where id = 'task-moves'")
    got = await _references(db, did)
    assert got["stale"] is True
    assert got["references"][0]["changed_since"] is True


async def test_a_reference_that_cannot_be_read_is_said_so(db):
    """Named but unreadable is not the same as not named, and reporting it as
    "no references" would put a falsehood where the provenance goes."""
    did = await _a_design(db, title="Dangling")
    await _revise(db, did, sources=["task-that-is-not-there"], note="cite a ghost")
    got = await _references(db, did)
    assert got["references"][0]["unresolved"] is True
    assert got["unresolved"] == ["task-that-is-not-there"]


async def test_citing_nothing_says_nothing_can_change_under_it(db):
    did = await _a_design(db, title="Unanchored")
    got = await _references(db, did)
    assert got["references"] == [] and got["stale"] is False


async def test_a_brief_designed_against_a_task_carries_what_it_says(db):
    """The differentiator, made concrete: a tool outside this platform can be
    told "design for the refunds decision"; only one inside it can read it."""
    await db.execute(
        "insert into objects (id, space_id, type, key, title, created_by, acl_keys)"
        " values ('task-ctx','pay','task','T-11','Refunds must be cancellable','maya',"
        " '{space:pay}') on conflict (id) do nothing")
    seen: dict = {}
    got = await _generate(db, {"title": "S", "spec": _GOOD_SPEC}, record=seen,
                          sources=["task-ctx"])
    assert "Refunds must be cancellable" in seen["prompt"]
    assert "do not contradict them" in seen["prompt"]
    assert got["sources"] == ["task-ctx"]


async def test_a_scoped_edit_asks_for_the_element_and_changes_nothing_else(db):
    """An edit a reviewer can read as an edit is one where the diff contains the
    change and nothing else — so the model is handed one element and asked for
    one back, and the platform puts it in place. A model cannot damage what it
    is never handed back: asked for the whole spec, a 9B model returned 1
    screen of 10."""
    two = {"screens": [{**_GOOD_SPEC["screens"][0], "elements": [
        *_GOOD_SPEC["screens"][0]["elements"],
        {"id": "row", "role": "card", "x": 16, "y": 120, "w": 358, "h": 60, "layout": "column",
         "children": [{"id": "save", "role": "button", "text": "Save", "x": 0, "y": 0, "w": 100, "h": 40}]}]}]}
    seen: dict = {}
    changed = {"element": {"id": "whatever", "role": "button", "text": "Save", "tone": "muted",
                           "x": 0, "y": 0, "w": 100, "h": 40}, "rationale": "made it secondary"}
    got = await _generate(db, changed, record=seen, brief="make it secondary", base=two, element="save")
    assert "Return ONLY this element" in seen["prompt"] and '"id":"save"' in seen["prompt"]
    assert "Settings" not in seen["prompt"].split("Change it")[0].split("design:")[1]   # the rest is not shown
    assert set(seen["schema"]["properties"]) == {"element", "rationale"}
    els = got["spec"]["screens"][0]["elements"]
    assert els[0] == two["screens"][0]["elements"][0]                                   # untouched, exactly
    assert els[1]["children"][0] == {**changed["element"], "id": "save"}                 # in place, id kept
    terse = await _generate(db, {"element": {"id": "save", "role": "button", "tone": "danger"}, "rationale": "red"},
                            brief="make it red", base=two, element="save")
    kept = terse["spec"]["screens"][0]["elements"][1]["children"][0]
    assert kept == {"id": "save", "role": "button", "text": "Save", "x": 0, "y": 0, "w": 100, "h": 40,
                    "tone": "danger"}                                                   # what it left out stays
    missing = await _generate(db, changed, brief="x", base=two, element="nope")
    assert missing.status_code == 422
    bad = await _generate(db, {"element": {"id": "save", "role": "button", "tone": "secondary"}, "rationale": ""},
                          brief="x", base=two, element="save")
    assert bad.status_code == 502                                                       # still checked against the type


async def test_an_edit_to_a_nested_element_is_asked_for_under_the_child_contract(db):
    """A child has no `children`, so the model is not offered the key — and an
    empty list that comes back anyway is dropped rather than failing the edit,
    which is what a 1.5B model did to every button inside a list."""
    two = {"screens": [{**_GOOD_SPEC["screens"][0], "elements": [
        *_GOOD_SPEC["screens"][0]["elements"],
        {"id": "row", "role": "card", "x": 16, "y": 120, "w": 358, "h": 60, "layout": "column",
         "children": [{"id": "save", "role": "button", "text": "Save", "x": 0, "y": 0, "w": 100, "h": 40}]}]}]}
    seen: dict = {}
    got = await _generate(db, {"element": {"id": "save", "role": "button", "tone": "danger", "children": []},
                               "rationale": "red"}, record=seen, brief="make it red", base=two, element="save")
    assert "children" not in seen["schema"]["properties"]["element"]["properties"]
    assert got["spec"]["screens"][0]["elements"][1]["children"][0]["tone"] == "danger"
    assert "children" not in got["spec"]["screens"][0]["elements"][1]["children"][0]
    seen.clear()
    await _generate(db, {"element": {"id": "row", "role": "card"}, "rationale": ""},
                    record=seen, brief="x", base=two, element="row")
    assert "children" in seen["schema"]["properties"]["element"]["properties"]          # a top-level one keeps it


async def test_two_people_editing_one_design_do_not_overwrite_each_other(db):
    """Revise replaces the whole spec from a copy the caller read earlier, so
    two tabs on one design wrote over each other in silence: the second save
    carried the first one's element back to how it had been."""
    did = await _a_design(db, title="Contended")
    first = {"screens": [{"id": "s", "name": "S", "w": 390, "h": 844,
                          "elements": [{"id": "a", "role": "button", "text": "mine",
                                        "x": 0, "y": 0, "w": 10, "h": 10}]}]}
    got = await _revise(db, did, spec=first, if_rev=1, note="the first write")
    assert not hasattr(got, "status_code"), got
    assert got["rev"] == 2

    # The second caller read rev 1, like the first did, and has not seen it.
    stale = await _revise(db, did, spec={"screens": []}, if_rev=1, note="from a stale tab")
    assert stale.status_code == 409
    body = json.loads(stale.body)
    assert body["error"]["code"] == "stale_revision"
    assert "rev 2" in body["error"]["message"]

    now = json.loads(await db.fetchval("select props->>'spec' from objects where id = $1", did))
    assert now == first, "the stale write must not have landed"


async def test_a_caller_that_never_read_a_revision_is_not_asked_to_have_seen_one(db):
    """`if_rev` is optional: MCP callers and scripts that propose-and-revise
    without reading are not broken by a check they cannot satisfy."""
    did = await _a_design(db, title="Unconditional")
    got = await _revise(db, did, spec={"screens": []}, note="no if_rev")
    assert not hasattr(got, "status_code"), got
    assert got["rev"] == 2


async def test_get_says_which_revision_it_handed_you(db):
    """Without it a caller cannot write conditionally, and the handoff file
    cannot say which revision it is a copy of."""
    from commonindex.gateway.app import TYPES
    from commonindex.gateway.collections import make_get

    did = await _a_design(db, title="Versioned")
    design_type = next(t for t in TYPES if t.id == "design")
    got = await make_get(design_type)(_Req({"id": did}, db))
    assert got["design"]["current_rev"] == 1
    await _revise(db, did, spec={"screens": []}, note="move on")
    again = await make_get(design_type)(_Req({"id": did}, db))
    assert again["design"]["current_rev"] == 2


async def test_history_is_bounded_so_a_morning_of_dragging_cannot_grow_forever(db):
    """Every revision holds a FULL snapshot — which is what makes restoring one
    statement instead of a patch routine — and direct manipulation writes one
    per gesture. A morning of dragging boxes put 77 rows on one design."""
    from commonindex.gateway.designs import KEEP_REVISIONS

    did = await _a_design(db, title="Much revised")
    for i in range(KEEP_REVISIONS + 6):
        got = await _revise(db, did, spec={"screens": []}, note=f"change {i}")
        assert not hasattr(got, "status_code"), got

    kept = await db.fetch(
        "select rev, delta->>'note' as note from revisions"
        " where object_id = $1 order by rev desc", did)
    assert len(kept) == KEEP_REVISIONS

    # The newest survive and the oldest go, which is the only way round that is
    # any use: you undo the thing you just did.
    assert kept[0]["note"] == f"change {KEEP_REVISIONS + 5}"
    assert kept[-1]["rev"] == kept[0]["rev"] - (KEEP_REVISIONS - 1)

    # And the object still points at something that is there.
    at = await db.fetchval("select current_rev from objects where id = $1", did)
    assert at == kept[0]["rev"]


async def test_a_design_under_the_cap_keeps_everything_including_its_first(db):
    from commonindex.gateway.designs import KEEP_REVISIONS

    did = await _a_design(db, title="Barely revised")
    for i in range(4):
        await _revise(db, did, spec={"screens": []}, note=f"change {i}")
    rows = await db.fetch("select rev from revisions where object_id = $1 order by rev", did)
    assert [r["rev"] for r in rows] == [2, 3, 4, 5]
    assert len(rows) < KEEP_REVISIONS


async def test_the_cap_is_what_the_history_op_can_actually_show(db):
    """Keeping more than the reader returns would be a tail nobody can reach;
    keeping fewer would make the reader's page size a lie."""
    from commonindex.gateway.designs import KEEP_REVISIONS

    did = await _a_design(db, title="At the cap")
    for i in range(KEEP_REVISIONS + 3):
        await _revise(db, did, spec={"screens": []}, note=f"change {i}")
    got = await _history(db, did)
    stored = await db.fetchval(
        "select count(*) from revisions where object_id = $1", did)
    assert len(got["revisions"]) == stored == KEEP_REVISIONS


# ── review: draft → review → approved ───────────────────────────────────


async def _reviewers(db):
    """A reviewer who may merge but is not an admin, and an agent that may only
    propose — the two cases the rule is about, beside maya, who is an admin."""
    await db.execute("""
        insert into actors (id, kind, display) values ('rhea', 'human', 'Rhea')
        on conflict (id) do nothing;
        insert into actors (id, kind, display, owner_id, trust_tier)
        values ('drafter', 'agent', 'Drafter', 'maya', 'propose-only')
        on conflict (id) do nothing;
        insert into grants (id, subject, relation, resource, granted_by) values
            ('g-maya-admin-review', 'maya', 'admin', 'space:pay', 'maya'),
            ('g-rhea-merge', 'rhea', 'merge', 'space:pay', 'maya'),
            ('g-drafter-propose', 'drafter', 'propose', 'space:pay', 'maya')
        on conflict (id) do nothing;
        delete from grants where subject = 'rhea' and relation = 'admin';
    """)


async def _review_op(db, name, design_id, actor="maya", **over):
    from commonindex.gateway import designs

    handler = getattr(designs, f"designs_{name}")
    body = {"design_id": design_id, "idempotencyKey": f"rv-{next(_KEYS)}", **over}
    return await handler(_Req(body, db, actor=actor))


async def _state(db, design_id):
    return await db.fetchval("select props->>'state' from objects where id = $1", design_id)


async def test_a_design_goes_draft_to_review_to_approved(db):
    await _reviewers(db)
    did = await _a_design(db, title="Reviewed")
    asked = await _review_op(db, "request_review", did, note="ready for a look")
    assert asked["state"] == "review" and await _state(db, did) == "review"

    at = await db.fetchval("select current_rev from objects where id = $1", did)
    got = await _review_op(db, "approve", did, actor="rhea", if_rev=at)
    assert not hasattr(got, "status_code"), got
    assert got["state"] == "approved" and got["self_approved"] is False
    assert await _state(db, did) == "approved"

    # The approval is a decision object, the same record a ratified metric leaves.
    dec = await db.fetchrow("select created_by, props from objects where id = $1",
                            got["decision_id"])
    assert dec["created_by"] == "rhea"

    # And the history tells it as one story.
    notes = [r["note"] for r in (await _history(db, did))["revisions"][:2]]
    assert notes == ["Approved", "Asked for review: ready for a look"]


async def test_nobody_approves_their_own_design(db):
    await _reviewers(db)
    did = await _a_design(db, title="Mine")          # created by maya
    await _review_op(db, "request_review", did)
    at = await db.fetchval("select current_rev from objects where id = $1", did)
    got = await _review_op(db, "approve", did, actor="maya", if_rev=at)
    assert got.status_code == 403
    assert json.loads(got.body)["error"]["code"] == "own_work"
    assert await _state(db, did) == "review"


async def test_editing_it_last_does_not_launder_someone_elses_approval(db):
    """Rhea may approve maya's design — but not once she has changed it herself."""
    await _reviewers(db)
    did = await _a_design(db, title="Touched")
    edited = await designs_revise_as(db, did, "rhea")
    assert not hasattr(edited, "status_code"), edited
    await _review_op(db, "request_review", did)
    at = await db.fetchval("select current_rev from objects where id = $1", did)
    got = await _review_op(db, "approve", did, actor="rhea", if_rev=at)
    assert got.status_code == 403 and json.loads(got.body)["error"]["code"] == "own_work"


async def designs_revise_as(db, design_id, actor):
    from commonindex.gateway.designs import designs_revise

    return await designs_revise(_Req({"design_id": design_id, "spec": {"screens": []},
                                      "idempotencyKey": f"rv-{next(_KEYS)}"}, db, actor=actor))


async def test_an_admin_may_approve_their_own_only_by_saying_why(db):
    await _reviewers(db)
    did = await _a_design(db, title="Admin's own")
    await _review_op(db, "request_review", did)
    at = await db.fetchval("select current_rev from objects where id = $1", did)

    silent = await _review_op(db, "approve", did, actor="maya", if_rev=at, self_approve=True)
    assert silent.status_code == 422
    assert json.loads(silent.body)["error"]["code"] == "reason_required"

    got = await _review_op(db, "approve", did, actor="maya", if_rev=at, self_approve=True,
                           note="solo space, nobody else to ask")
    assert got["self_approved"] is True
    review = json.loads(await db.fetchval("select props->>'review' from objects where id = $1", did))
    assert review["self_approved"] is True and review["decided_by"] == "maya"


async def test_a_non_admin_cannot_self_approve(db):
    """Rhea may merge, not administer — so the escape hatch is not hers."""
    await _reviewers(db)
    from commonindex.gateway.collections import make_propose

    made = await make_propose(_design_type())(_Req({
        "title": "Rhea's", "surface": "mobile", "spec": {"screens": []},
        "idempotencyKey": f"d-{next(_KEYS)}"}, db, actor="rhea"))
    await _open_to_workspace(db, made["id"])
    await _review_op(db, "request_review", made["id"], actor="rhea")
    at = await db.fetchval("select current_rev from objects where id = $1", made["id"])
    got = await _review_op(db, "approve", made["id"], actor="rhea", if_rev=at,
                           self_approve=True, note="please")
    assert got.status_code == 403


async def test_an_approval_is_for_the_revision_the_reviewer_read(db):
    await _reviewers(db)
    did = await _a_design(db, title="Moving")
    await _review_op(db, "request_review", did)
    at = await db.fetchval("select current_rev from objects where id = $1", did)

    missing = await _review_op(db, "approve", did, actor="rhea")
    assert missing.status_code == 422
    stale = await _review_op(db, "approve", did, actor="rhea", if_rev=at - 1)
    assert stale.status_code == 409
    assert await _state(db, did) == "review"


async def test_editing_an_approved_design_returns_it_to_draft(db):
    """An approval covers the version somebody read, the way new commits
    dismiss a pull request's approval."""
    await _reviewers(db)
    did = await _a_design(db, title="Approved then edited")
    await _review_op(db, "request_review", did)
    at = await db.fetchval("select current_rev from objects where id = $1", did)
    await _review_op(db, "approve", did, actor="rhea", if_rev=at)

    got = await _revise(db, did, spec={"screens": []}, note="small tweak")
    assert got["state"] == "draft" and got["reopened_from"] == "approved"
    assert await _state(db, did) == "draft"

    # After an approval, only who changed it since counts: maya made it, rhea
    # approved it, maya edited it — so rhea may approve again, maya may not.
    await _review_op(db, "request_review", did)
    at = await db.fetchval("select current_rev from objects where id = $1", did)
    assert (await _review_op(db, "approve", did, actor="maya", if_rev=at)).status_code == 403
    again = await _review_op(db, "approve", did, actor="rhea", if_rev=at)
    assert again["state"] == "approved"


async def test_changes_requested_need_a_reason_and_go_back_to_draft(db):
    await _reviewers(db)
    did = await _a_design(db, title="Sent back")
    await _review_op(db, "request_review", did)
    bare = await _review_op(db, "request_changes", did, actor="rhea")
    assert bare.status_code == 422
    got = await _review_op(db, "request_changes", did, actor="rhea", note="CTA is too quiet")
    assert got["state"] == "draft"
    review = json.loads(await db.fetchval("select props->>'review' from objects where id = $1", did))
    assert review["decision"] == "changes_requested"
    assert review["decision_note"] == "CTA is too quiet"


async def test_state_cannot_be_set_by_revising_or_by_proposing(db):
    """Both need only `propose`. Before this, either one could mark a design
    approved — including your own — and review was a formality anyone skipped."""
    did = await _a_design(db, title="Shortcut")
    via_revise = await _revise(db, did, state="approved")
    assert via_revise.status_code == 422
    assert json.loads(via_revise.body)["error"]["code"] == "governed_field"
    assert await _state(db, did) is None or await _state(db, did) == "draft"

    via_propose = await _propose_design(db, state="approved")
    assert via_propose.status_code == 422
    assert json.loads(via_propose.body)["error"]["code"] == "governed_field"
    ok = await _propose_design(db, state="draft")
    assert ok["created"] is True


async def test_review_says_what_the_caller_may_do(db):
    await _reviewers(db)
    did = await _a_design(db, title="Who may")
    mine = await _review_op(db, "review", did, actor="maya")
    assert mine["you"]["made_this"] is True and mine["you"]["may_request"] is True
    await _review_op(db, "request_review", did)

    as_maya = await _review_op(db, "review", did, actor="maya")
    assert as_maya["you"]["may_approve"] is False
    assert as_maya["you"]["may_self_approve"] is True
    as_rhea = await _review_op(db, "review", did, actor="rhea")
    assert as_rhea["you"]["may_approve"] is True
    as_agent = await _review_op(db, "review", did, actor="drafter")
    assert as_agent["you"]["may_approve"] is False
    assert as_agent["you"]["may_request_changes"] is False


# ── experiments: start, stop, decide ────────────────────────────────────

_EXP_CONTRACT = {"connection_id": "c1", "dataset_id": "exposures", "variation": "arm",
                 "outcome": "converted", "unit": "user_id", "planned_days": 14}


async def _an_experiment(db, eid=None, *, status="draft", contract=True, **props):
    # Unique per call: this database keeps what earlier tests wrote.
    eid = eid or f"exp-life-{next(_KEYS)}"
    body = {"status": status, "days": 14, "metric": "checkout_conv", **props}
    if contract:
        body["contract"] = _EXP_CONTRACT
    await db.execute(
        "insert into objects (id, space_id, type, key, title, props, created_by)"
        " values ($1, 'pay', 'experiment', $2, 'Lifecycle', $3::jsonb, 'maya')",
        eid, f"EXP-{next(_KEYS)}", json.dumps(body))
    return eid


async def _a_readout(db, eid, *, srm_passed=True):
    rid = f"readout-{next(_KEYS)}"
    await db.execute(
        "insert into objects (id, space_id, type, key, title, props, created_by)"
        " values ($1, 'pay', 'readout', $2, 'r', $3::jsonb, 'maya')",
        rid, f"RO-{next(_KEYS)}",
        json.dumps({"experiment_id": eid, "srm": {"ran": True, "passed": srm_passed}}))
    await db.execute("update objects set props = props || jsonb_build_object('last_readout', $2::text)"
                     " where id = $1", eid, rid)
    return rid


async def _exp_op(db, name, eid, actor="maya", **over):
    from commonindex.gateway import experiments

    body = {"experiment_id": eid, "idempotencyKey": f"x-{next(_KEYS)}", **over}
    return await getattr(experiments, f"experiments_{name}")(_Req(body, db, actor=actor))


async def _exp_props(db, eid):
    return json.loads(await db.fetchval("select props from objects where id = $1", eid))


async def test_an_experiment_starts_stops_and_is_decided_on_the_record(db):
    eid = await _an_experiment(db)
    began = (datetime.now(tz=UTC) - timedelta(days=5)).isoformat()
    got = await _exp_op(db, "start", eid, started_at=began)
    assert got["status"] == "running"

    stopped = await _exp_op(db, "stop", eid, reason="reached sample")
    assert stopped["status"] == "readout"

    rid = await _a_readout(db, eid)
    decided = await _exp_op(db, "decide", eid, decision="ship", rationale="clear win, guardrails flat")
    assert decided["status"] == "shipped" and decided["readout_id"] == rid

    props = await _exp_props(db, eid)
    assert props["decision"]["outcome"] == "ship" and props["decision"]["by"] == "maya"
    # The decision is an object in the graph, linked to what it decided and cited.
    rels = {(r["rel"], r["dst"]) for r in await db.fetch(
        "select rel, dst from edges where src = $1", decided["decision_id"])}
    assert rels == {("decides", eid), ("cites", rid)}


async def test_the_day_is_worked_out_from_the_dates(db):
    from commonindex.gateway.authoring import experiments_list

    eid = await _an_experiment(db, status="running",
                               started_at=(datetime.now(tz=UTC) - timedelta(days=6, hours=1)).isoformat())
    rows = {r["id"]: r for r in (await experiments_list(_Req({}, db)))["experiments"]}
    assert rows[eid]["day"] == 6 and rows[eid]["days"] == 14
    assert rows[eid]["attention"] == []


async def test_an_experiment_past_its_planned_days_asks_for_a_decision(db):
    from commonindex.gateway.authoring import experiments_list

    eid = await _an_experiment(db, status="running",
                               started_at=(datetime.now(tz=UTC) - timedelta(days=15)).isoformat())
    rows = {r["id"]: r for r in (await experiments_list(_Req({}, db)))["experiments"]}
    assert any("decide" in why for why in rows[eid]["attention"])


async def test_shipping_needs_a_readout_and_a_split_that_held(db):
    eid = await _an_experiment(db, status="running", started_at=datetime.now(tz=UTC).isoformat())
    bare = await _exp_op(db, "decide", eid, decision="ship", rationale="looks good")
    assert bare.status_code == 409 and json.loads(bare.body)["error"]["code"] == "no_readout"

    await _a_readout(db, eid, srm_passed=False)
    broken = await _exp_op(db, "decide", eid, decision="ship", rationale="looks good")
    assert json.loads(broken.body)["error"]["code"] == "srm_failed"

    # Killing a broken experiment is exactly the right thing to do.
    killed = await _exp_op(db, "decide", eid, decision="kill", rationale="assignment is broken")
    assert killed["status"] == "killed"


async def test_a_decision_needs_a_reason(db):
    eid = await _an_experiment(db, status="running")
    got = await _exp_op(db, "decide", eid, decision="kill", rationale="  ")
    assert json.loads(got.body)["error"]["code"] == "reason_required"


async def test_an_experiment_without_a_contract_cannot_start(db):
    eid = await _an_experiment(db, contract=False)
    got = await _exp_op(db, "start", eid)
    assert json.loads(got.body)["error"]["code"] == "not_pre_registered"


async def test_an_experiment_cannot_start_in_the_future(db):
    eid = await _an_experiment(db)
    got = await _exp_op(db, "start", eid,
                        started_at=(datetime.now(tz=UTC) + timedelta(days=2)).isoformat())
    assert json.loads(got.body)["error"]["code"] == "future_start"


async def test_the_program_counts_real_experiments_only(db):
    from commonindex.gateway.experiments import experiments_program

    before = await experiments_program(_Req({}, db))
    eid = await _an_experiment(db, status="running", started_at=datetime.now(tz=UTC).isoformat())
    await _a_readout(db, eid)
    await db.execute("update objects set props = props || '{\"lift\": 4.0, \"better\": \"up\"}'::jsonb"
                     " where id = $1", eid)
    await _exp_op(db, "decide", eid, decision="ship", rationale="win")
    after = await experiments_program(_Req({}, db))
    assert after["total"] == before["total"] + 1
    assert after["shipped"] == before["shipped"] + 1
    assert sum(b["shipped"] for b in after["dist"]) == sum(b["shipped"] for b in before["dist"]) + 1


async def test_me_says_who_is_asking_and_what_they_hold(db):
    from commonindex.gateway.access import actors_me

    await db.execute("""
        insert into actors (id, kind, display) values ('mera', 'human', 'Mera')
        on conflict (id) do nothing;
        insert into grants (id, subject, relation, resource, granted_by)
        values ('g-mera-merge', 'mera', 'merge', 'space:pay', 'maya') on conflict (id) do nothing;
    """)
    me = await actors_me(_Req({}, db, actor="mera"))
    assert me["id"] == "mera" and me["display"] == "Mera"
    assert me["may"] == ["read", "propose", "merge"]


async def test_a_lift_read_off_a_broken_split_is_not_an_effect_size(db):
    """Killing a broken experiment is right; counting its lift in the program's
    effect distribution would chart the breakage as if it were the change."""
    from commonindex.gateway.experiments import experiments_program

    before = await experiments_program(_Req({}, db))
    eid = await _an_experiment(db, status="running", started_at=datetime.now(tz=UTC).isoformat())
    await _a_readout(db, eid, srm_passed=False)
    await db.execute("update objects set props = props || '{\"lift\": 90.8, \"better\": \"up\"}'::jsonb"
                     " where id = $1", eid)
    await _exp_op(db, "decide", eid, decision="kill", rationale="split is broken")
    after = await experiments_program(_Req({}, db))
    assert after["killed"] == before["killed"] + 1
    assert sum(b["killed"] for b in after["dist"]) == sum(b["killed"] for b in before["dist"])



async def test_an_experiment_knows_what_points_at_it(db):
    """Decisions and readouts are edges into it; a design drawn from it lists it
    in its sources. All three were invisible from the experiment."""
    from commonindex.gateway.experiments import experiments_references

    eid = await _an_experiment(db, status="running", started_at=datetime.now(tz=UTC).isoformat())
    rid = await _a_readout(db, eid)
    await db.execute("insert into edges (src, rel, dst, created_by) values ($1, 'for', $2, 'maya')",
                     rid, eid)
    decided = await _exp_op(db, "decide", eid, decision="ship", rationale="win")
    did = await _a_design(db, title="Built on the result", sources=[eid])

    got = await experiments_references(_Req({"experiment_id": eid}, db))
    assert [d["id"] for d in got["decisions"]] == [decided["decision_id"]]
    assert [r["id"] for r in got["readouts"]] == [rid]
    assert [c["id"] for c in got["cited_by"]] == [did]
    assert got["cited_by"][0]["rel"] == "sources"


async def test_recording_a_readout_caches_what_a_card_shows(db):
    """A card quoting +4% without its interval cannot tell a result from a coin
    flip, so the interval, the units and the verdict are cached with the lift."""
    from commonindex.gateway.authoring import _record_readout

    eid = await _an_experiment(db, status="running", started_at=datetime.now(tz=UTC).isoformat())
    payload = {"srm": {"ran": True, "passed": True}, "results": [{
        "outcome": "converted", "role": "target", "better": "up",
        "arms": [{"name": "control", "n": 500}, {"name": "variant", "n": 480}],
        "comparisons": [{"lift": 0.042, "lift_ci": [0.011, 0.073], "verdict": "better"}]}]}
    recorded, err = await _record_readout({"pool": _PoolOf(db)}, "pay", {"experiment_id": eid},
                                          {"id": eid, "title": "Lifecycle"}, payload, "maya")
    assert err is None, err
    props = await _exp_props(db, eid)
    assert props["lift"] == 4.2 and props["lift_ci"] == [1.1, 7.3]
    assert props["units"] == 980 and props["verdict"] == "better"
    assert props["srm_passed"] is True and props["last_readout"] == recorded["id"]


async def test_a_stopped_experiment_can_have_its_dates_recorded_once(db):
    """Every experiment stopped before dates existed reads the last 30 days.
    Its dates can be written once — stop included — and it stays stopped."""
    eid = await _an_experiment(db, status="readout")
    began = datetime.now(tz=UTC) - timedelta(days=40)
    ended = datetime.now(tz=UTC) - timedelta(days=20)
    got = await _exp_op(db, "start", eid, started_at=began.isoformat(), stopped_at=ended.isoformat())
    assert got["status"] == "readout"
    props = await _exp_props(db, eid)
    assert props["started_at"][:10] == began.date().isoformat()
    assert props["stopped_at"][:10] == ended.date().isoformat()
    assert props["dates_recorded"]["by"] == "maya"

    # Moving them after the numbers are visible is the thing refused.
    again = await _exp_op(db, "start", eid, started_at=(began + timedelta(days=5)).isoformat())
    assert json.loads(again.body)["error"]["code"] == "dates_on_record"


async def test_a_stop_date_must_fall_after_the_start(db):
    eid = await _an_experiment(db, status="readout")
    got = await _exp_op(db, "start", eid,
                        started_at=(datetime.now(tz=UTC) - timedelta(days=5)).isoformat(),
                        stopped_at=(datetime.now(tz=UTC) - timedelta(days=9)).isoformat())
    assert json.loads(got.body)["error"]["code"] == "bad_dates"


async def test_a_running_experiment_takes_no_stop_date_at_start(db):
    eid = await _an_experiment(db)
    got = await _exp_op(db, "start", eid, stopped_at=datetime.now(tz=UTC).isoformat())
    assert json.loads(got.body)["error"]["code"] == "not_stopped"


# ── docs: a block tree you can edit, and come back to ──────────────────


def _doc_type():
    from commonindex.gateway.app import TYPES

    return next(t for t in TYPES if t.id == "doc")


def _para(text):
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


async def _propose_doc(db, **over):
    from commonindex.gateway.collections import make_propose

    body = {"title": "Refund runbook", "body": {"type": "doc", "content": [_para("First.")]},
            "idempotencyKey": f"doc-{next(_KEYS)}", **over}
    out = await make_propose(_doc_type())(_Req(body, db))
    if isinstance(out, dict) and out.get("id"):
        await _open_to_workspace(db, out["id"])
    return out


async def _revise_doc(db, doc_id, **over):
    from commonindex.gateway.docs import docs_revise

    body = {"doc_id": doc_id, "idempotencyKey": f"drv-{next(_KEYS)}", **over}
    return await docs_revise(_Req(body, db))


async def _a_doc(db, **over):
    got = await _propose_doc(db, **over)
    assert not hasattr(got, "status_code"), got
    return got["id"]


async def test_a_doc_body_that_is_markup_is_refused(db):
    """A doc is a block tree. A string of HTML, or a node type the editor does
    not have, is not one — and the second is the subtler smuggle."""
    for label, body in [
        ("html as the body", "<p onclick='steal()'>hi</p>"),
        ("an html node", {"type": "doc", "content": [{"type": "html", "text": "<script>"}]}),
        ("a script mark", {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "x", "marks": [{"type": "script"}]}]}]}),
    ]:
        r = await _propose_doc(db, body=body)
        assert r.status_code == 422, label
        assert json.loads(r.body)["error"]["code"] == "invalid_props", label


async def test_revising_a_doc_keeps_the_old_body_and_rewrites_the_excerpt(db):
    from commonindex.gateway.docs import docs_history

    did = await _a_doc(db, title="Onboarding")
    got = await _revise_doc(db, did, body={"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Day one"}]},
        _para("Get a laptop.")]}, note="@ai: add a day-one section", if_rev=1)

    assert got["rev"] == 2
    assert got["excerpt"] == "Day one Get a laptop."
    props = json.loads(await db.fetchval("select props from objects where id = $1", did))
    assert props["excerpt"] == "Day one Get a laptop."

    hist = await docs_history(_Req({"doc_id": did}, db))
    assert hist["revisions"][0]["note"] == "@ai: add a day-one section"
    assert hist["revisions"][0]["body"]["content"][0]["type"] == "heading"


async def test_a_stale_save_is_refused_rather_than_overwriting(db):
    """Two tabs on one doc: without `if_rev` the second autosave carries the
    first one's paragraph back to how it was, and nobody sees it happen."""
    did = await _a_doc(db, title="Two tabs")
    assert (await _revise_doc(db, did, body={"type": "doc", "content": [_para("A")]},
                              if_rev=1))["rev"] == 2
    r = await _revise_doc(db, did, body={"type": "doc", "content": [_para("B")]}, if_rev=1)
    assert r.status_code == 409
    assert json.loads(r.body)["error"]["code"] == "stale_revision"
    assert json.loads(await db.fetchval(
        "select props->>'body' from objects where id = $1", did))["content"][0] == _para("A")


async def test_a_revision_is_checked_against_the_doc_type(db):
    did = await _a_doc(db, title="Guarded doc")
    r = await _revise_doc(db, did, body={"type": "doc", "content": [{"type": "iframe"}]})
    assert r.status_code == 422
    assert await db.fetchval("select current_rev from objects where id = $1", did) == 1


async def test_revising_an_unknown_doc_is_a_404(db):
    r = await _revise_doc(db, "doc-nope", body={"type": "doc", "content": []})
    assert r.status_code == 404
    assert json.loads(r.body)["error"]["field"] == "doc_id"


# ── docs are indexed, found, cited and shared ─────────────────────────
#
# The indexer (commonindex/workers/indexer.py) writes the chunks; these tests are
# about the vectors on them, the search over them, and the public link — and
# about all three respecting who may see a doc.


class _Embedder:
    """Deterministic 768-d vectors: one axis per known topic word, so a
    question about refunds is near a section about refunds and nothing else."""

    TOPICS = ("refund", "deploy", "invoice")

    def __init__(self):
        self.calls = 0

    async def embed(self, texts, *, query=False):
        self.calls += len(texts)
        out = []
        for t in texts:
            v = [0.0] * 768
            for i, word in enumerate(self.TOPICS):
                if word in t.lower():
                    v[i] = 1.0
            v[767] = 0.01
            out.append(v)
        return out


class _DocReq(_Req):
    """A request as `actor`, with the real permission checker — so a private
    doc is private here exactly as it is to the gateway."""

    def __init__(self, body, pool, embedder=None, actor="maya"):
        from commonindex.core.authz.store import PgChecker

        super().__init__(body, pool, actor=actor)
        self.app.state.commonindex.update(checker=PgChecker(_PoolOf(pool)), embedder=embedder)
        self.base_url = "http://gateway.test/"


def _h(level, text):
    return {"type": "heading", "attrs": {"level": level}, "content": [{"type": "text", "text": text}]}


async def _indexed_doc(db, embedder, title, *blocks):
    from commonindex.gateway.docs import docs_propose

    got = await docs_propose(_DocReq({"title": title, "body": {"type": "doc", "content": list(blocks)},
                                      "idempotencyKey": f"ix-{next(_KEYS)}"}, db, embedder))
    assert got.get("created"), got
    assert await db.fetchval("select count(*) from chunks where object_id = $1", got["id"]) >= 1
    return got["id"]


async def _member(db, who="scribe", resource="space:pay", relation="read"):
    await db.execute(
        "insert into grants (id, subject, relation, resource, granted_by) values ($1,$2,$3,$4,'maya')"
        " on conflict do nothing", f"g-test-{who}-{resource}", who, relation, resource)


async def test_a_proposed_doc_gets_vectors_on_the_indexers_chunks(db):
    emb = _Embedder()
    did = await _indexed_doc(db, emb, "Refund runbook", _h(1, "Refunds"), _para("Issue the refund in the ledger."))
    rows = await db.fetch("select heading, embedding is not null as v, acl_keys from chunks"
                          " where object_id = $1 order by ord", did)
    assert any(r["heading"] == "Refund runbook › Refunds" for r in rows)
    assert all(r["v"] for r in rows)
    # Private to its author: keyed to the doc itself, not the space.
    assert all("space:pay" not in r["acl_keys"] for r in rows)


async def test_a_save_re_embeds_only_the_section_that_changed(db):
    from commonindex.gateway.docs import docs_revise

    emb = _Embedder()
    did = await _indexed_doc(db, emb, "Ops", _h(1, "A"), _para("deploy steps"), _h(1, "B"), _para("invoice steps"))
    first = emb.calls
    await docs_revise(_DocReq({"doc_id": did, "idempotencyKey": f"x-{next(_KEYS)}", "body": {
        "type": "doc", "content": [_h(1, "A"), _para("deploy steps"), _h(1, "B"), _para("invoice steps, updated")]}},
        db, emb))
    # The indexer kept every unchanged chunk's vector across the rewrite.
    assert emb.calls - first == 1
    assert await db.fetchval("select count(*) from chunks where object_id = $1 and embedding is null", did) == 0


async def test_docs_are_found_by_meaning_as_well_as_by_word(db):
    from commonindex.gateway.docs import docs_search

    emb = _Embedder()
    await _indexed_doc(db, emb, "Money back", _para("How a refund is issued to a customer."))
    got = await docs_search(_DocReq({"q": "refund"}, db, emb))
    top = next(h for h in got["hits"] if h["title"] == "Money back")
    assert set(top["matched"]) == {"text", "vector"}
    assert top["citation"].startswith("doc:") and got["degraded"] is None

    got = await docs_search(_DocReq({"q": "refund issued"}, db, None))
    assert any(h["title"] == "Money back" for h in got["hits"])
    assert "words only" in got["degraded"]


async def test_a_private_doc_is_found_only_by_the_people_it_is_shared_with(db):
    from commonindex.gateway.docs import docs_search

    emb = _Embedder()
    await _member(db)
    await _indexed_doc(db, emb, "Secret refund plan", _para("refund secret"))
    mine = await docs_search(_DocReq({"q": "secret refund plan"}, db, emb))
    theirs = await docs_search(_DocReq({"q": "secret refund plan"}, db, emb, actor="scribe"))
    assert any(h["title"] == "Secret refund plan" for h in mine["hits"])
    assert not any(h["title"] == "Secret refund plan" for h in theirs["hits"])


async def test_publishing_serves_the_latest_version_until_the_link_is_turned_off(db):
    from commonindex.gateway.docs import (
        docs_revise,
        docs_share,
        docs_sharing,
        docs_unshare,
        share_page,
    )

    did = await _indexed_doc(db, None, "Launch notes", _para("First draft."))
    key = lambda: f"s-{next(_KEYS)}"
    link = (await docs_share(_DocReq({"doc_id": did, "idempotencyKey": key()}, db)))["link"]
    assert link["url"] == f"http://gateway.test/share/{link['token']}"
    again = (await docs_share(_DocReq({"doc_id": did, "idempotencyKey": key()}, db)))["link"]
    assert again["token"] == link["token"], "publishing twice is one link"

    req = _DocReq({}, db)
    page = await share_page(link["token"], req)
    assert page.status_code == 200 and b"First draft." in page.body
    assert "script-src" not in page.headers["content-security-policy"]

    await docs_revise(_DocReq({"doc_id": did, "idempotencyKey": key(),
                               "body": {"type": "doc", "content": [_para("Final.")]}}, db))
    assert b"Final." in (await share_page(link["token"], req)).body

    assert (await docs_unshare(_DocReq({"doc_id": did, "idempotencyKey": key()}, db)))["revoked"] == 1
    assert (await share_page(link["token"], req)).status_code == 404
    assert (await docs_sharing(_DocReq({"doc_id": did}, db)))["link"] is None
    new = (await docs_share(_DocReq({"doc_id": did, "idempotencyKey": key()}, db)))["link"]
    assert new["token"] != link["token"], "a revoked link never comes back"


async def test_only_an_owner_may_publish(db):
    """A public link goes past every access rule, so it takes the level that
    changing who has access takes. Someone who can only view may export what
    they can read, but not put it on the internet."""
    from commonindex.gateway.docs import docs_export, docs_share

    did = await _indexed_doc(db, None, "Board pack", _para("Numbers."))
    stranger = await docs_share(_DocReq({"doc_id": did, "idempotencyKey": f"p-{next(_KEYS)}"}, db, actor="scribe"))
    assert stranger.status_code == 404, "a doc you cannot see does not exist"

    await _member(db, resource=f"object:{did}")
    viewer = await docs_share(_DocReq({"doc_id": did, "idempotencyKey": f"p-{next(_KEYS)}"}, db, actor="scribe"))
    assert viewer.status_code == 403
    assert "Numbers." in (await docs_export(_DocReq({"doc_id": did}, db, actor="scribe")))["html"]


async def test_an_unknown_link_and_a_malformed_one_look_the_same(db):
    from commonindex.gateway.docs import share_page

    for token in ("x" * 43, "../../etc/passwd"):
        r = await share_page(token, _DocReq({}, db))
        assert r.status_code == 404


async def test_export_is_the_published_page_as_a_file(db):
    from commonindex.gateway.docs import docs_export

    did = await _indexed_doc(db, None, "Q3 Plan / Draft", _para("Hello."))
    got = await docs_export(_DocReq({"doc_id": did}, db))
    assert got["filename"] == "q3-plan-draft.html"
    assert got["html"].startswith("<!doctype html>") and "Hello." in got["html"]


async def test_code_ask_cites_a_doc_when_the_code_says_nothing(db, monkeypatch):
    """The point of searching docs from Code Query: a question the code cannot
    answer — why, what the process is — is answered from the doc, and cited."""
    from commonindex.core.authz.store import PgChecker
    from commonindex.gateway import app as gateway

    await _indexed_doc(db, None, "Chargeback policy", _para("Chargebacks over 500 dollars need finance approval."))

    class Llm:
        model = "stub"

        async def complete(self, messages, **kw):
            self.prompt = messages[1]["content"]
            return "Finance approves chargebacks over 500. [doc]"

    async def nothing(req, body, limit=None):
        return {"query": body["q"], "hits": [], "searched_repos": [], "selected_repos": [],
                "routing": "no code matched"}

    llm = Llm()
    monkeypatch.setitem(gateway.state, "llm", llm)
    monkeypatch.setitem(gateway.state, "pool", _PoolOf(db))
    monkeypatch.setitem(gateway.state, "checker", PgChecker(_PoolOf(db)))
    monkeypatch.setitem(gateway.state, "embedder", None)
    monkeypatch.setattr(gateway, "_code_search", nothing)

    got = await gateway.code_ask(_DocReq({"q": "who approves chargebacks"}, db))
    assert any(c.startswith("doc:") and "Chargeback policy" in c for c in got["citations"])
    assert "SOURCE doc:" in llm.prompt
    assert " doc section" in got["markdown"]
