"""Offline tests: listing gallery thumbnails never executes warehouse queries."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from commonindex.gateway.auth import SpaceMismatch
from commonindex.gateway.authoring import dashboards_list
from commonindex.workers.parts import panels as panel_context


@pytest.mark.parametrize("encoded", [False, True])
async def test_dashboard_list_returns_bounded_layout_metadata(encoded):
    panels = [{"id": f"p{i}", "title": f"Panel {i}", "mark": "line", "span": 6,
               "height": 264} for i in range(15)]
    row = {"id": "d1", "key": "DASH-1", "title": "Revenue", "panels": 15,
           "unratified": 2, "queries": 2, "metric_ids": ["revenue"],
           "metric_labels": json.dumps({"revenue": "Net revenue"}) if encoded else {"revenue": "Net revenue"},
           "approved_metrics": 1, "connection_name": "Platform warehouse",
           "created_by": "owner", "props": {"connection_id": "warehouse"},
           "updated_at": datetime(2026, 9, 24, tzinfo=UTC),
           "preview_panels": json.dumps(panels) if encoded else panels, "workspace": True}
    pool = SimpleNamespace(fetch=AsyncMock(return_value=[row]))
    checker = SimpleNamespace(acl_keys_for=AsyncMock(return_value=["space:team"]))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(commonindex={"pool": pool, "checker": checker})),
                              state=SimpleNamespace(space="team", principal=SimpleNamespace(actor_id="owner")),
                              json=AsyncMock(return_value={}))
    result = (await dashboards_list(request))["dashboards"][0]
    assert result["preview_panels"] == panels[:12]
    assert result["panel_count"] == 15
    assert result["certified"] is False
    assert result["queries"] == 2
    assert result["metric_labels"] == {"revenue": "Net revenue"}
    assert result["approved_metrics"] == 1
    assert result["connection_name"] == "Platform warehouse"
    assert result["updated_at"] == "2026-09-24T00:00:00+00:00"
    query, space, can_see = pool.fetch.call_args.args
    assert space == "team"
    # Only what the caller may see: a private dashboard is for its people.
    assert can_see == ["space:team"] and "o.acl_keys && $2" in query
    assert result["visibility"] == "workspace"
    assert "o.space_id = $1" in query
    assert "order by b.position, b.panel_id" in query
    assert "c.space_id = o.space_id" in query
    assert "count(distinct b.metric_id)" in query
    # Certification follows the same current ratified definition as rendering,
    # even when the panel was authored against an older, deprecated version.
    assert "definition.space_id in (o.space_id, '*')" in query
    assert "(definition.status = 'ratified') desc" in query
    assert "m.version = b.metric_version" not in query
    # The preview's allowlist includes no SQL, filter values, or query results.
    preview_query = query.split("jsonb_build_object(")[1].split(") order by")[0]
    assert "b.sql" not in preview_query
    assert "filters" not in preview_query
    pool.fetch.assert_awaited_once()


async def test_dashboard_preview_refuses_a_different_space():
    pool = SimpleNamespace(fetch=AsyncMock())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(commonindex={"pool": pool})),
                              state=SimpleNamespace(space="team"),
                              json=AsyncMock(return_value={"space_id": "another-team"}))
    with pytest.raises(SpaceMismatch):
        await dashboards_list(request)
    pool.fetch.assert_not_awaited()


async def test_dashboard_search_context_follows_current_ratified_definition():
    db = SimpleNamespace(fetch=AsyncMock(return_value=[{
        "title": "Tokens", "label": "Tokens", "mark": "line", "dimensions": [],
        "grain": "day", "sql": None, "expr": "SUM(cost_tokens)", "unit": "count",
        "description": None, "status": "ratified", "dataset": "sql.tokens_by_agent",
        "decided": {"why": "Correct the display unit"},
    }]))
    pieces = await panel_context(db, {"id": "dashboard"}, {})
    assert "(count)" in pieces[0][1]
    query, _ = db.fetch.call_args.args
    assert "definition.space_id in (p.space_id, '*')" in query
    assert "(definition.status = 'ratified') desc" in query
    assert "m.version = pb.metric_version" not in query
