"""Agents run on this machine without anyone copying a token.

Defended: a kept token is readable by its owner only; an agent is minted a
token the first time it is run and the same token is used after that; a
revoked one is replaced once rather than failing forever; only an agent can be
minted for this way, not a person; `--all` runs exactly the agents kept.
"""

from __future__ import annotations

import stat

import pytest
from db import DSN
from test_sharing import db  # noqa: F401 - the fixture, reused

asyncpg = pytest.importorskip("asyncpg")


@pytest.fixture
def kept_in(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMONINDEX_AGENT_TOKENS", str(tmp_path / "agents"))
    return tmp_path / "agents"


def test_a_kept_token_is_private_and_comes_back(kept_in):
    from commonindex import agent_tokens

    assert agent_tokens.stored("scribe") is None and agent_tokens.kept() == {}
    path = agent_tokens.save("scribe", "ci_abc")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(kept_in.stat().st_mode) == 0o700
    assert agent_tokens.stored("scribe") == "ci_abc"
    agent_tokens.save("triage", "ci_def")
    assert agent_tokens.kept() == {"scribe": "ci_abc", "triage": "ci_def"}
    with pytest.raises(ValueError):
        agent_tokens.save("../escape", "ci_x")


@pytest.mark.integration
async def test_only_an_agent_is_minted_for_and_the_token_works(db, kept_in):  # noqa: F811
    from commonindex import agent_tokens
    from commonindex.core.authz.store import hash_token

    token, held = await agent_tokens.mint("scribe", label="local runner", dsn=DSN, agents_only=True)
    assert held["kind"] == "agent" and token.startswith("ci_")
    assert await db.fetchval("select actor_id from actor_tokens where token_hash = $1", hash_token(token)) == "scribe"
    with pytest.raises(LookupError, match="human, not an agent"):
        await agent_tokens.mint("maya", dsn=DSN, agents_only=True)
    with pytest.raises(LookupError, match="no agent 'nobody'"):
        await agent_tokens.mint("nobody", dsn=DSN, agents_only=True)


class _Model:
    model = "stand-in"

    async def complete(self, messages, **_):
        return "ok"


async def test_the_first_run_mints_and_keeps_and_a_revoked_token_is_replaced_once(kept_in, monkeypatch):
    from commonindex import agent_tokens, reference_agent
    from commonindex.reference_agent import Refused

    minted: list[str] = []

    async def fake_mint(agent, **_):
        minted.append(agent)
        return f"ci_new{len(minted)}", {"kind": "agent", "trust_tier": "propose-only", "grants": ["propose on space:pay"]}

    good: set[str] = set()

    async def fake_introduce(self):
        if self.gateway.token not in good:
            raise Refused(401, "bad_credentials", "token does not resolve to an actor")
        self.me = {"id": "scribe", "kind": "agent"}

    monkeypatch.setattr(agent_tokens, "mint", fake_mint)
    monkeypatch.setattr(reference_agent.Runner, "introduce", fake_introduce)

    good.add("ci_new1")
    runner = await reference_agent._ready("http://gw", _Model(), "scribe", None, mint=True)
    assert runner is not None and minted == ["scribe"] and agent_tokens.stored("scribe") == "ci_new1"

    # Kept, it is reused: nothing new is minted.
    runner = await reference_agent._ready("http://gw", _Model(), "scribe", agent_tokens.stored("scribe"), mint=True)
    assert runner is not None and minted == ["scribe"]

    # Revoked: replaced once, and kept.
    good.discard("ci_new1")
    good.add("ci_new2")
    runner = await reference_agent._ready("http://gw", _Model(), "scribe", "ci_new1", mint=True)
    assert runner is not None and agent_tokens.stored("scribe") == "ci_new2"

    # Without minting (`--all`), a dead token is reported, not replaced.
    good.clear()
    assert await reference_agent._ready("http://gw", _Model(), "scribe", "ci_new2", mint=False) is None
    assert minted == ["scribe", "scribe"]
