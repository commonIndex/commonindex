"""Identity that is not self-asserted, and the check every operation declares.

`authz/__init__` promised "one check per operation at the gateway" from the
first commit and nothing implemented it: `Checker` was a Protocol with no
subclass, `grants` never held a row, and `Op.relation` was read only by the
/_ops listing. Meanwhile every write took `actor_id` from the request body —
three of them defaulting to a real named human when it was absent — so
`metrics.ratify` checked the trust tier of whoever the caller said it was.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from commonindex.core.authz import Denied
from commonindex.core.authz.store import RANK, NoSuchToken, PgChecker, hash_token


class FakeDb:
    def __init__(self, tokens=(), grants=()):
        self._tokens = list(tokens)
        self._grants = list(grants)
        self.executed: list[tuple] = []

    async def fetchrow(self, sql, *args):
        return next((r for r in self._tokens if r["token_hash"] == args[0]), None)

    async def fetch(self, sql, *args):
        if "grants" in sql:
            return [g for g in self._grants
                    if g["subject"] == args[0] and g.get("resource", args[1]) == args[1]]
        return []

    async def execute(self, sql, *args):
        self.executed.append((sql, args))


def token_row(actor="alex", token="t", kind="human", tier="propose-only", expires=None):
    return {"id": "tok-1", "actor_id": actor, "expires_at": expires,
            "kind": kind, "trust_tier": tier, "token_hash": hash_token(token)}


def grant(subject="alex", relation="read", resource="space:pay", expires=None):
    return {"id": f"g-{subject}-{relation}", "subject": subject, "relation": relation,
            "resource": resource, "expires_at": expires}


# ── the token ───────────────────────────────────────────────────────────


def test_the_token_itself_is_never_what_is_stored():
    """A dump of actor_tokens must not let the reader authenticate as anyone."""
    h = hash_token("ci_secret")
    assert "ci_secret" not in h
    assert len(h) == 64 and hash_token("ci_secret") == h
    assert hash_token("ci_secre") != h


async def test_a_valid_token_resolves_to_its_actor():
    c = PgChecker(FakeDb(tokens=[token_row(actor="maya", token="good")]))
    p = await c.principal("good")
    assert p.actor_id == "maya" and p.kind == "human" and p.token_id == "tok-1"


async def test_an_unknown_token_does_not_authenticate():
    with pytest.raises(NoSuchToken):
        await PgChecker(FakeDb(tokens=[token_row(token="good")])).principal("wrong")


async def test_an_expired_token_stops_working_at_the_next_call():
    """Checked on use rather than swept, so a lapsed token dies immediately
    instead of whenever a job next runs."""
    past = datetime.now(tz=UTC) - timedelta(seconds=1)
    c = PgChecker(FakeDb(tokens=[token_row(token="t", expires=past)]))
    with pytest.raises(NoSuchToken, match="expired"):
        await c.principal("t")


async def test_using_a_token_records_that_it_was_used():
    """What makes "granted and never used in its whole window" the easiest
    revocation in the queue."""
    db = FakeDb(tokens=[token_row(token="t")])
    await PgChecker(db).principal("t")
    assert any("last_used" in sql for sql, _ in db.executed)


# ── the relation check ──────────────────────────────────────────────────


def test_relations_are_ordered_not_independent_flags():
    assert RANK["read"] < RANK["propose"] < RANK["merge"] < RANK["admin"]


@pytest.mark.parametrize("held,needed", [
    ("read", "read"), ("propose", "read"), ("admin", "read"),
    ("propose", "propose"), ("merge", "propose"), ("admin", "merge"),
])
async def test_a_stronger_grant_satisfies_a_weaker_requirement(held, needed):
    """Otherwise every actor needs one grant per relation, and the missing one
    is discovered as a denial in production."""
    c = PgChecker(FakeDb(grants=[grant(relation=held)]))
    await c.require("alex", needed, "space:pay")


@pytest.mark.parametrize("held,needed", [
    ("read", "propose"), ("read", "admin"), ("propose", "merge"), ("merge", "admin"),
])
async def test_a_weaker_grant_does_not_satisfy_a_stronger_requirement(held, needed):
    c = PgChecker(FakeDb(grants=[grant(relation=held)]))
    with pytest.raises(Denied, match=needed):
        await c.require("alex", needed, "space:pay")


async def test_no_grant_at_all_is_denied_and_says_so():
    c = PgChecker(FakeDb(grants=[]))
    with pytest.raises(Denied, match="no grant"):
        await c.require("nobody", "read", "space:pay")


async def test_a_grant_on_another_space_does_not_carry_over():
    c = PgChecker(FakeDb(grants=[grant(resource="space:growth", relation="admin")]))
    with pytest.raises(Denied):
        await c.require("alex", "read", "space:pay")


async def test_an_expired_grant_does_not_count():
    past = datetime.now(tz=UTC) - timedelta(days=1)
    c = PgChecker(FakeDb(grants=[grant(relation="admin", expires=past)]))
    with pytest.raises(Denied):
        await c.require("alex", "read", "space:pay")


async def test_an_unknown_relation_fails_closed():
    """An operation asking for a relation the model does not define is a bug in
    the operation, and the only safe reading is denial. Seven operations shipped
    declaring `write`, which no grant can hold."""
    c = PgChecker(FakeDb(grants=[grant(relation="admin")]))
    with pytest.raises(Denied, match="unknown relation"):
        await c.require("alex", "write", "space:pay")


# ── the middleware ──────────────────────────────────────────────────────


def test_there_is_no_way_to_turn_the_check_off():
    """A COMMONINDEX_AUTH=off switch is how a convenience becomes a CVE — the same
    argument this codebase already makes about the secret key, which is
    generated per run rather than defaulted."""
    from pathlib import Path

    src = Path("commonindex/gateway/auth.py").read_text()
    assert "getenv" not in src and "environ" not in src


def test_the_middleware_never_reads_the_request_body():
    """Accepting `actor_id` "when no token is present" would leave the hole open
    and hide it, so the middleware does not parse a body at all — identity comes
    from the header or the request does not run.

    Asserted against the body-reading calls rather than the string "actor_id",
    which also appears in `principal.actor_id` — reading the AUTHENTICATED
    identity, which is the whole point.
    """
    from pathlib import Path

    src = Path("commonindex/gateway/auth.py").read_text()
    for reader in ("await request.json()", "request.body()", "._body"):
        assert reader not in src, f"the middleware reads the body via {reader}"


def test_only_the_discovery_endpoint_is_open():
    """Every read requires a grant. The one exception answers "how do I
    authenticate", which a caller needs before it can."""
    from commonindex.gateway.auth import OPEN

    assert OPEN == ("/api/v1/_ops",)


def test_cors_is_outside_the_check_so_a_denial_is_readable():
    """add_middleware inserts at 0, so the LAST registered is the OUTERMOST. Get
    this backwards and a 403 returns with no CORS headers, the browser refuses
    to let the page read it, and "you need a propose grant" surfaces in the
    console as an opaque network failure."""
    from commonindex.gateway.app import app

    names = [m.cls.__name__ for m in app.user_middleware]
    assert names.index("CORSMiddleware") < names.index("BaseHTTPMiddleware")


async def test_the_grant_that_satisfied_the_check_is_stamped():
    """"Granted in March and never once exercised" is the easiest and safest
    revocation there is, and it cannot be asked unless use is recorded on the
    GRANT — stamping only the token says the actor was busy, not which of its
    permissions it actually needed."""
    db = FakeDb(grants=[grant(relation="admin")])
    await PgChecker(db).require("alex", "read", "space:pay")

    stamped = [args for sql, args in db.executed if "update grants" in sql]
    assert stamped == [("g-alex-admin",)]


async def test_a_denied_check_stamps_nothing():
    """A denial is not use. Recording it would make a revoked-but-probed grant
    look live in the recertification query."""
    db = FakeDb(grants=[grant(relation="read")])
    with pytest.raises(Denied):
        await PgChecker(db).require("alex", "admin", "space:pay")
    assert not [s for s, _ in db.executed if "update grants" in s]


async def test_the_strongest_applicable_grant_is_the_one_recorded():
    """An actor holding both read and admin exercises admin; recording the read
    would understate what it depends on and make the admin grant look droppable."""
    db = FakeDb(grants=[grant(relation="read"), grant(relation="admin")])
    await PgChecker(db).require("alex", "propose", "space:pay")
    assert [a for s, a in db.executed if "update grants" in s] == [("g-alex-admin",)]


# ── administering access ────────────────────────────────────────────────


def test_a_resource_must_be_a_kind_and_an_id():
    """A grant on a malformed resource matches nothing and still reads as
    granted, which is the worst of both — it looks like access and is not."""
    from commonindex.gateway.access import RESOURCE

    for good in ("space:pay", "object:doc-42", "space:growth.eu"):
        assert RESOURCE.match(good), good
    for bad in ("pay", "space:", ":pay", "space pay", "space:a b",
                "space:" + "x" * 200, "", "*"):
        assert not RESOURCE.match(bad), bad


def test_every_access_operation_requires_admin():
    """There is no separate administrative door — the same middleware that
    guards a readout guards the thing that decides who may read one."""
    from commonindex.gateway.app import REGISTRY

    ops = [o for o in REGISTRY.all() if o.name.startswith("access.")]
    assert len(ops) == 5
    assert {o.relation for o in ops} == {"admin"}


def test_the_mutating_access_operations_say_so():
    """A retry after a timeout must not double-apply a grant."""
    from commonindex.gateway.app import REGISTRY

    for name in ("access.grant", "access.revoke", "access.revoke_token"):
        op = REGISTRY.get(name)
        assert op.mutating, f"{name} changes access and must say so"
        assert "idempotencyKey" in op.input_schema["properties"]


def test_the_grant_relation_is_constrained_to_the_model():
    """An enum rather than a free string, so `write` — which seven operations
    once declared and no grant can hold — cannot be granted either."""
    from commonindex.gateway.app import REGISTRY

    schema = REGISTRY.get("access.grant").input_schema["properties"]
    assert set(schema["relation"]["enum"]) == set(RANK)


def test_listing_tokens_cannot_return_anything_usable():
    """The point of storing only a hash is that this endpoint is safe to exist.
    A field carrying the token would undo that silently."""
    import inspect

    from commonindex.gateway import access

    src = inspect.getsource(access.access_tokens)
    assert "token_hash" not in src, "the hash must not be selected either"
    for field in ("t.id", "t.actor_id", "t.label", "t.expires_at", "t.last_used"):
        assert field in src


# ── one space, not two ──────────────────────────────────────────────────

from pathlib import Path


def test_the_space_the_grant_was_checked_against_is_recorded_on_the_request():
    """The middleware already does this for the actor, and says why: "set on
    the request rather than merged into the body so a handler cannot be written
    to prefer a body value by accident."

    It was not done for the space, so it happened anyway. The grant was checked
    against the `x-commonindex-space` HEADER while every handler scoped its data by
    `body["space_id"]` — two caller-controlled inputs answering one question,
    with nothing making them agree.
    """
    src = (Path(__file__).resolve().parent.parent / "commonindex/gateway/auth.py").read_text()
    assert "request.state.space = space" in src


def test_no_handler_takes_its_space_from_the_request_body():
    """The hole, stated as a rule. Grepped rather than reasoned about, because
    26 handlers had it and one more would reopen it."""
    root = Path(__file__).resolve().parent.parent / "commonindex/gateway"
    offences = []
    for path in sorted(root.glob("*.py")):
        # `auth.py` is where the rule lives: `space_of` reads the body field in
        # order to REFUSE a mismatch, which is the opposite of trusting it.
        if path.name == "auth.py":
            continue
        for i, line in enumerate(path.read_text().split("\n"), 1):
            if "body.get(\"space_id\"" in line and "space_of" not in line:
                offences.append(f"{path.name}:{i}")
    assert not offences, "space taken from the body:\n  " + "\n  ".join(offences)


def test_a_body_naming_another_space_is_refused_rather_than_ignored():
    """Silently substituting the authorized space would give a caller a
    different scope than they asked for and tell them nothing — the same
    failure as trusting the body, one layer up."""
    import pytest

    from commonindex.gateway.auth import SpaceMismatch, space_of

    req = type("R", (), {"state": type("S", (), {"space": "pay"})()})()
    assert space_of(req, {"space_id": "pay"}) == "pay"
    assert space_of(req, {}) == "pay"
    with pytest.raises(SpaceMismatch) as e:
        space_of(req, {"space_id": "other"})
    assert "other" in str(e.value) and "pay" in str(e.value)


def test_a_dashboard_is_loaded_within_a_space():
    """`_load_dashboard` keyed on `dashboard_id` alone, so knowing an id was
    the whole of the authorization — and ids are in every link, every export
    and every generated skill file."""
    src = (Path(__file__).resolve().parent.parent / "commonindex/gateway/app.py").read_text()
    body = src.split("async def _load_dashboard")[1].split("\nasync def ")[0]
    assert "space_id = $2" in body
    assert "o.space_id = $2" in body


def test_a_connection_is_opened_within_a_space():
    """`_source` looked up `where id = $1`, then decrypted the stored
    credential and opened the warehouse."""
    src = (Path(__file__).resolve().parent.parent
           / "commonindex/gateway/authoring.py").read_text()
    body = src.split("async def _source(")[1].split("\nasync def ")[0]
    assert "space_id = $2" in body


# ── what a tier may actually do ─────────────────────────────────────────


def test_an_operation_that_writes_is_not_gated_at_read():
    """`datasets.profile` was `relation="read", mutating=True`: it stores the
    profile on the dataset row and starts a scan of a warehouse table. A read
    grant is the tier that may LOOK at a dashboard."""
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register

    reg = Registry()
    register(reg)
    offenders = [o.name for o in reg.all()
                 if getattr(o, "mutating", False) and o.relation == "read"]
    assert not offenders, offenders


def test_deleting_a_dashboard_needs_more_than_propose():
    """The propose tier exists to hold back changes somebody else should stand
    behind — `_may_ratify` is built around exactly that — and it could delete a
    whole dashboard and every panel on it.

    The line is reversibility at your own tier: `panels.remove` stays `propose`
    because `panels.add` is `propose` and can put it back. Nothing undeletes a
    dashboard.
    """
    from commonindex.core.authz.store import RANK
    from commonindex.core.ops import Registry
    from commonindex.core.warehouse.ops import register

    reg = Registry()
    register(reg)
    assert RANK[reg.get("dashboards.delete").relation] > RANK["propose"]
    assert reg.get("panels.add").relation == reg.get("panels.remove").relation
