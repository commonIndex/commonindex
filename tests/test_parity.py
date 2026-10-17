"""UI/API parity, as a test rather than a promise.

This is the defect the review found in the Go skeleton: the MCP emitter
synthesised per-type tools itself while the HTTP router only ever saw operations,
so agents were offered three tools per collection that no route served. Parity
was broken on day one, by the code whose comment promised it.

The fix was structural — per-type operations are registered into the one registry
and both emitters read ``reg.all()``. These tests are what stop it regressing,
because the next person to add a surface will reach for exactly the shortcut that
caused it.

F2 as frozen requires "CI fails the build if a UI action has no registered
operation". This is that check.
"""

from __future__ import annotations

from pathlib import Path

from commonindex.core.authz import ops as sharing_ops
from commonindex.core.conversation import ops as conversation_ops
from commonindex.core.generation import ops as generation_ops
from commonindex.core.grouping import ops as project_ops
from commonindex.core.ops import Registry, register_type_ops
from commonindex.core.registry.types import ObjectType, load_dir
from commonindex.core.render import ops as video_ops
from commonindex.core.render import page_ops as artifact_ops
from commonindex.core.retrieval import ops as retrieval_ops
from commonindex.core.warehouse import ops as warehouse_ops
from commonindex.core.workflow import ops as task_ops
from commonindex.gateway import link_previews
from commonindex.gateway.http import routes
from commonindex.gateway.mcp import build as build_manifest

TYPES = Path(__file__).resolve().parent.parent / "types"


def load_types() -> list[ObjectType]:
    """The shared loader. This function used to parse the directory itself,
    which meant the parity test knew about five types the application had never
    loaded — so the two surfaces it was comparing were built from different
    inputs. One loader, both callers."""
    return load_dir(TYPES)


def full_registry() -> Registry:
    """Exactly what the app builds. It used to be a lookalike assembled here,
    which is how the app could pass [] types while this asserted over five."""
    reg = Registry()
    register_type_ops(reg, load_types())
    warehouse_ops.register(reg)
    retrieval_ops.register(reg)
    generation_ops.register(reg)
    task_ops.register(reg)
    project_ops.register(reg)
    conversation_ops.register(reg)
    sharing_ops.register(reg, link_previews.KINDS)
    video_ops.register(reg)
    artifact_ops.register(reg)
    return reg


def test_the_app_registry_is_built_from_the_same_types_as_this_test():
    """The gap the other tests could not see: both were internally consistent
    while being about different registries."""
    from commonindex.gateway.app import REGISTRY
    from commonindex.gateway.app import TYPES as APP_TYPES

    assert {t.id for t in APP_TYPES} == {t.id for t in load_types()}
    assert {op.name for op in REGISTRY.all()} == {op.name for op in full_registry().all()}


def test_every_operation_has_exactly_one_route_and_one_tool():
    """The core parity contract.

    Not "the counts match" — a name-by-name comparison, because two emitters can
    produce the same number of things and still disagree about which.
    """
    reg = full_registry()
    op_names = {op.name for op in reg.all()}

    route_names = {path.rsplit("/", 1)[-1] for path in routes(reg)}
    tool_names = {t.name for t in build_manifest(reg)}

    assert route_names == op_names, (
        "HTTP routes and operations disagree:\n"
        f"  only routes: {sorted(route_names - op_names)}\n"
        f"  only ops:    {sorted(op_names - route_names)}"
    )
    assert tool_names == op_names, (
        "MCP tools and operations disagree — this is the defect that shipped in "
        "the Go skeleton:\n"
        f"  only tools: {sorted(tool_names - op_names)}\n"
        f"  only ops:   {sorted(op_names - tool_names)}"
    )


def test_agents_and_people_reach_the_same_surface():
    """Stated the other way round, because this is what the tenet actually says:
    an agent can do exactly what a person can."""
    reg = full_registry()
    assert {p.rsplit("/", 1)[-1] for p in routes(reg)} == {t.name for t in build_manifest(reg)}


def test_every_graph_backed_type_contributes_list_get_and_propose():
    reg = full_registry()
    names = {op.name for op in reg.all()}
    for t in load_types():
        if t.status != "ratified" or t.store != "graph":
            continue
        stem = t.plural.lower()
        for verb in ("list", "get", "propose"):
            assert f"{stem}.{verb}" in names, f"{t.id} is missing {stem}.{verb}"


def test_a_registry_backed_type_gets_no_generated_graph_operations():
    """Metrics live in their own versioned table, not in `objects`.

    Generating the graph operations for them produced handlers that answered
    confidently about the wrong store: metrics.get returned "no metric
    agent_acceptance" for a definition that was sitting ratified in the metrics
    table. Its operations are hand-written instead, and know what a version is.
    """
    names = {op.name for op in full_registry().all()}
    metric = next(t for t in load_types() if t.id == "metric")
    assert metric.store == "registry"
    assert "metrics.propose" not in names
    assert "metrics.get" not in names
    # But the hand-written ones must still be there, or the type is unreachable.
    assert {"metrics.list", "metrics.ratify"} <= names


def test_mutating_operations_require_an_idempotency_key():
    """Required by DESIGN §6 and api-protocol.md. The Go MCP emitter passed the
    props schema straight through, so generated propose tools had no key at all
    and an agent retrying a timeout would double-write."""
    for op in full_registry().all():
        if not op.mutating:
            continue
        props = op.input_schema.get("properties", {})
        assert "idempotencyKey" in props, f"{op.name} is mutating without an idempotency key"
        assert "idempotencyKey" in op.input_schema.get("required", []), \
            f"{op.name} has an idempotency key that is not required"


def test_facet_arguments_carry_their_value_domain():
    """Without a domain the arguments are not actually typed, which was the other
    half of the Go manifest defect: an agent could filter on any string and only
    find out at execution."""
    reg = full_registry()
    by_name = {op.name: op for op in reg.all()}
    for t in load_types():
        if t.status != "ratified":
            continue
        if t.store != "graph":
            continue
        schema = by_name[f"{t.plural.lower()}.list"].input_schema["properties"]
        for facet in t.facets:
            if facet.kind == "enum" and facet.values:
                assert schema[facet.field].get("enum") == list(facet.values), \
                    f"{t.id}.{facet.field} lost its value domain"


def test_every_operation_declares_a_relation():
    """One authorization check per operation, at the gateway. An operation with
    no relation is an operation nobody is checking."""
    for op in full_registry().all():
        assert op.relation, f"{op.name} declares no relation"


def test_registry_refuses_duplicate_operations():
    """A silent duplicate would let one emitter win and the other lose, which is
    how the surfaces drift apart in the first place."""
    reg = full_registry()
    import pytest
    with pytest.raises(ValueError):
        warehouse_ops.register(reg)


def test_every_route_the_app_serves_has_a_registered_operation():
    """The other direction, which nothing was checking.

    The existing test asks whether every operation has a handler. This asks
    whether every handler is an operation — and it is the one that catches a
    route added by hand that agents can never see. `metrics.list` sat in that
    state: a working endpoint the UI called and the MCP manifest did not list.
    """
    from commonindex.gateway.app import REGISTRY, app

    names = {op.name for op in REGISTRY.all()}
    orphans = sorted(
        path.removeprefix("/api/v1/") for path in app.openapi()["paths"]
        if path.startswith("/api/v1/")
        and path.removeprefix("/api/v1/") not in names
        and not path.endswith("_ops"))
    assert not orphans, (
        "routes served with no registered operation, so no agent can reach them: "
        f"{orphans}")


def test_every_operation_has_a_live_route_in_the_app():
    """The hole the test above cannot see.

    ``routes(reg)`` builds path strings FROM the registry, so comparing them to
    the registry proves only that a function is deterministic. It never asked
    whether anything serves them — and ``connections.check`` sat in the manifest
    an agent reads, with no handler, returning a bare 404 to any agent that
    believed it.

    So this one reads the FastAPI app's own route table. It is the same check as
    above pointed at reality instead of at a derivation of the input.
    """
    from commonindex.gateway.app import REGISTRY, app

    # The app's OpenAPI document, not ``app.routes``. FastAPI keeps an included
    # router as one opaque ``_IncludedRouter`` rather than flattening it, so
    # walking the route list means reaching into a private attribute that can be
    # renamed in a patch release — and a parity test that breaks on a dependency
    # bump gets deleted rather than fixed. The schema is the public answer to
    # "what does this app serve", and is what an OpenAPI client sees.
    served = set(app.openapi()["paths"])
    missing = [op.name for op in REGISTRY.all()
               if f"/api/v1/{op.name}" not in served]
    assert not missing, (
        "operations advertised in /_ops and the MCP manifest with no handler: "
        f"{sorted(missing)}"
    )


def test_mutating_operations_are_reachable_and_declare_their_relation():
    """The editing operations, as a set.

    Nothing created could be changed or removed until these existed: a wrong
    grain was a permanent 500, a typo in a title was permanent, and a dashboard
    built to try something out could only be abandoned in place.
    """
    reg = full_registry()
    by_name = {op.name: op for op in reg.all()}
    for name in ("dashboards.update", "dashboards.delete", "panels.add", "panels.remove"):
        assert name in by_name, f"{name} is not registered"
        assert by_name[name].mutating, f"{name} changes data and must say so"
        assert "idempotencyKey" in by_name[name].input_schema["properties"], (
            f"{name} mutates, so a retry after a timeout must not double-apply")


def test_panels_add_can_cite_an_existing_metric():
    """The argument that decides whether a registry is worth having.

    Without `metric_id`, every panel anywhere writes a NEW definition — and at
    N dashboards the registry holds N rows that all say COUNT(*), which is the
    drift it exists to prevent, produced by the authoring tool itself.
    """
    reg = full_registry()
    props = next(op for op in reg.all() if op.name == "panels.add").input_schema["properties"]
    assert "metric_id" in props, "panels.add cannot cite an existing definition"
    assert "agg" in props, "panels.add cannot author a new one either"


def test_every_operation_declares_a_relation_the_authz_model_defines():
    """The guard for a whole surface that failed closed.

    Seven operations declared `relation="write"`, which is not one of
    read | propose | merge | admin. `PgChecker.require` fails closed on an
    unknown relation — correctly — so every dashboard authoring operation
    returned 403 to every caller including an admin, and the message was
    "unknown relation 'write'" rather than anything about permissions.

    A relation the model cannot grant is a permanent denial, so it is a build
    error rather than a runtime one.
    """
    from commonindex.core.authz.store import RANK

    unknown = sorted({op.relation for op in full_registry().all()} - set(RANK))
    assert not unknown, (
        f"operations declare relations no grant can hold: {unknown}; "
        f"the model defines {sorted(RANK)}")
