"""A deployment's own workspace is the one requests are authorized against.

The middleware and `space_of` fell back to the literal "pay" — the demo's
workspace. A deployment with COMMONINDEX_SPACE=main made its admin in `main`, signed
them in, and then refused every request they made with 403.
"""

from __future__ import annotations

from types import SimpleNamespace

from commonindex.gateway.auth import space_of
from commonindex.workers.connectors.git import RepoRef


def test_a_request_with_no_space_is_in_the_deployments_workspace(monkeypatch):
    monkeypatch.setenv("COMMONINDEX_SPACE", "main")
    assert space_of(SimpleNamespace(state=SimpleNamespace())) == "main"


def test_the_demo_workspace_is_still_the_default_when_none_is_configured(monkeypatch):
    monkeypatch.delenv("COMMONINDEX_SPACE", raising=False)
    assert space_of(SimpleNamespace(state=SimpleNamespace())) == "pay"


def test_a_repo_is_indexed_into_the_deployments_workspace(monkeypatch):
    monkeypatch.setenv("COMMONINDEX_SPACE", "main")
    assert RepoRef(org="example", repo="shop", branch="main").space_id == "main"


def test_the_middleware_reads_the_configured_workspace():
    import inspect

    from commonindex.gateway import auth
    src = inspect.getsource(auth)
    assert '"x-commonindex-space", "pay"' not in src and "signin.space()" in src
