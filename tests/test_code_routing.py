"""Automatic repository routing, and the ACL boundary it runs inside.

The product claim is that a caller asks "where does order placement happen"
without naming a repository and the server finds the right one. These prove the
claim on a corpus where the repositories say genuinely different things —
routing over a corpus where every repo says the same thing demonstrates nothing.

A FakeZoekt stands in for the service so routing, ranking and the Postgres
re-check are tested without a container. The adapter's own parsing is covered
against a real captured response in test_zoekt.py; what is exercised here is
everything that happens either side of it.

    docker compose up -d db
    COMMONINDEX_TEST_DSN=postgresql://commonindex:commonindex@127.0.0.1:5433/commonindex_test \
        make test-integration
"""

from __future__ import annotations

import pytest
from db import DSN, reset, seed

from commonindex.adapters.zoekt import Chunk, Hit, Results, ZoektUnavailable
from commonindex.core.authz.store import PgChecker
from commonindex.gateway import codesearch
from commonindex.workers.codequery import _upsert_code_file, _upsert_repo
from commonindex.workers.connectors import Record
from commonindex.workers.connectors.git import RepoRef

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

STOREFRONT = RepoRef(org="example", repo="storefront", branch="main",
                     space_id="pay", provider="local")
LEDGER = RepoRef(org="example", repo="ledger", branch="main",
                 space_id="pay", provider="local")

CHECKOUT = (
    "def place_order(cart, user):\n"
    "    total = price_cart(cart)\n"
    "    return submit_payment(user, total)\n"
)
POSTING = (
    "def post_journal_entry(txn):\n"
    "    return ledger.add(txn)\n"
)
CORPUS = {
    STOREFRONT.repo_id: [("src/checkout.py", CHECKOUT)],
    LEDGER.repo_id: [("posting.py", POSTING)],
}
ZOEKT_NAME = {STOREFRONT.repo_id: "github.com/example/storefront",
              LEDGER.repo_id: "github.com/example/ledger"}


class FakeZoekt:
    """Answers from CORPUS, honouring the repo filter it is given.

    It records the filter so a test can assert that the caller's ACL actually
    reached the query, rather than only that the results looked right — those
    are different guarantees, and only the first survives a refactor.
    """

    def __init__(self, listed: list[str] | None = None, fail: bool = False) -> None:
        self._listed = listed if listed is not None else list(ZOEKT_NAME.values())
        self._fail = fail
        self.asked_for: list[str] = []
        #: The commit the shard was built at — the repository's, as indexed.
        self.version = "0" * 40

    async def repos(self):
        from commonindex.adapters.zoekt import Repo
        if self._fail:
            raise ZoektUnavailable("down")
        return [Repo(name=n, branches=("main",)) for n in self._listed]

    async def search(self, query: str, *, repo_names: list[str], max_files=None):
        if self._fail:
            raise ZoektUnavailable("down")
        self.asked_for = list(repo_names)
        term = query.replace("sym:", "").split()[-1].lower()
        hits = []
        for repo_id, files in CORPUS.items():
            name = ZOEKT_NAME[repo_id]
            if name not in repo_names:
                continue
            for path, body in files:
                if term in body.lower():
                    hits.append(Hit(
                        repo_name=name, path=path, version=self.version,
                        language="Python", branches=("main",), score=100.0,
                        chunks=(Chunk(body=body, start_line=1, match_lines=(1,)),)))
        return Results(hits=tuple(hits), file_count=len(hits),
                       match_count=len(hits), duration_ms=1.0)


async def _index(conn, ref: RepoRef) -> None:
    for path, body in CORPUS[ref.repo_id]:
        await _upsert_code_file(conn, ref, Record(
            id=path, stream=ref.stream_name,
            props={"path": path, "sha": f"sha-{path}", "size": len(body),
                   "language": "python", "body": body}), "maya")
    await _upsert_repo(conn, ref, "0" * 40, "maya")


async def _grant(conn, subject: str, ref: RepoRef) -> None:
    await conn.execute(
        "insert into grants (id, subject, relation, resource, granted_by)"
        " values ($1,$2,'read',$3,'maya') on conflict (id) do nothing",
        f"g-{subject}-read-{ref.acl_key.replace(':', '-')}", subject, ref.acl_key)


@pytest.fixture
async def db():
    try:
        conn = await asyncpg.connect(DSN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no database at {DSN}: {e}")
    await reset(conn)
    await seed(conn)
    await conn.execute(
        "insert into actors (id, kind, display) values ('contractor','human','C')")
    async with conn.transaction():
        await _index(conn, STOREFRONT)
        await _index(conn, LEDGER)
        await _grant(conn, "maya", STOREFRONT)
        await _grant(conn, "maya", LEDGER)
    try:
        yield conn
    finally:
        await conn.close()


async def keys(conn, actor: str) -> list[str]:
    return await PgChecker(conn).acl_keys_for(actor)


# ── routing ──────────────────────────────────────────────────────────────

async def test_a_question_with_no_repository_finds_the_right_one(db):
    """The product claim, at its narrowest: no repo named, correct repo found,
    and the one that was searched-but-irrelevant reported rather than hidden."""
    result = await codesearch.search(
        db, FakeZoekt(), q="place_order", space="pay",
        acl_keys=await keys(db, "maya"))

    assert [h["repo"] for h in result["hits"]] == ["example/storefront"]
    assert [s["repo"] for s in result["selected_repos"]] == ["example/storefront"]
    assert result["searched_repos"] == ["example/ledger", "example/storefront"]
    assert "no repository was named by the caller" in result["routing"]


async def test_routing_picks_the_other_repo_for_the_other_question(db):
    """Guards against a router that always returns the first repo — which the
    previous test alone would not catch."""
    result = await codesearch.search(
        db, FakeZoekt(), q="journal", space="pay", acl_keys=await keys(db, "maya"))

    assert [h["repo"] for h in result["hits"]] == ["example/ledger"]


async def test_repos_are_ranked_by_match_strength_not_hit_count(db):
    result = await codesearch.search(
        db, FakeZoekt(), q="def", space="pay", acl_keys=await keys(db, "maya"))
    scores = [s["score"] for s in result["selected_repos"]]

    assert len(result["selected_repos"]) == 2
    assert scores == sorted(scores, reverse=True)


# ── the ACL boundary ─────────────────────────────────────────────────────

async def test_zoekt_is_only_ever_asked_about_repos_the_caller_may_read(db):
    """Asserts the filter, not just the results. A router that fetched
    everything and filtered afterwards would pass a results-only assertion
    while having already read the restricted repo into memory."""
    fake = FakeZoekt()
    await _grant_only_storefront(db)

    await codesearch.search(db, fake, q="def", space="pay",
                            acl_keys=await keys(db, "restricted"))

    assert fake.asked_for == ["github.com/example/storefront"]


async def _grant_only_storefront(conn) -> None:
    await conn.execute(
        "insert into actors (id, kind, display) values ('restricted','human','R')"
        " on conflict (id) do nothing")
    await _grant(conn, "restricted", STOREFRONT)


async def test_a_caller_with_no_grants_searches_nothing(db):
    fake = FakeZoekt()

    result = await codesearch.search(db, fake, q="place_order", space="pay",
                                     acl_keys=await keys(db, "contractor"))

    assert result["hits"] == [] and fake.asked_for == []
    assert "no readable repositories" in result["routing"]


async def test_a_shard_hit_on_a_revoked_repo_is_refused_by_postgres(db):
    """Zoekt's index is a snapshot. If a grant is revoked after indexing, the
    shard still answers — so the Postgres re-check, not the filter, is what
    finally decides. Simulated by handing the filter a repo the caller has lost
    access to, which is exactly what a stale shard would do."""
    await db.execute("delete from grants where subject = 'maya'")
    await _grant(db, "maya", LEDGER)

    class Leaky(FakeZoekt):
        async def search(self, query, *, repo_names, max_files=None):
            return await super().search(query, repo_names=list(ZOEKT_NAME.values()))

    result = await codesearch.search(db, Leaky(), q="place_order", space="pay",
                                     acl_keys=await keys(db, "maya"))

    assert result["hits"] == []


async def test_repos_the_caller_cannot_read_are_not_enumerable(db):
    await _grant_only_storefront(db)

    listed = await codesearch.list_repos(db, "pay", await keys(db, "restricted"))

    assert [r["repo"] for r in listed["repos"]] == ["example/storefront"]


# ── narrowing, degradation, honesty ──────────────────────────────────────

async def test_an_unknown_repo_name_is_reported_not_silently_ignored(db):
    """Ignoring a typo turns it into "that code does not exist", which is the
    most expensive wrong answer this system can give."""
    result = await codesearch.search(
        db, FakeZoekt(), q="place_order", space="pay",
        acl_keys=await keys(db, "maya"), repos=["example/storefrnot"])

    assert result["unknown_repos"] == ["example/storefrnot"]
    assert result["hits"] == []


async def test_narrowing_to_one_repo_excludes_the_other(db):
    result = await codesearch.search(
        db, FakeZoekt(), q="def", space="pay", acl_keys=await keys(db, "maya"),
        repos=["example/ledger"])

    assert result["searched_repos"] == ["example/ledger"]
    assert {h["repo"] for h in result["hits"]} == {"example/ledger"}


async def test_naming_a_repo_is_not_reported_as_naming_none(db):
    """The rationale is the one sentence explaining how the search was run, and
    it was handed "were there unknown repository names" where it wanted "did the
    caller narrow" — so a caller who narrowed to a repository that exists was
    told, in that sentence, that they had named nothing."""
    named = await codesearch.search(
        db, FakeZoekt(), q="def", space="pay", acl_keys=await keys(db, "maya"),
        repos=["example/ledger"])
    unnamed = await codesearch.search(
        db, FakeZoekt(), q="def", space="pay", acl_keys=await keys(db, "maya"))

    assert "no repository was named" not in named["routing"]
    assert "no repository was named" in unnamed["routing"]
    # The repositories left out are the caller's own filter, not a grant they
    # lack — `all_readable` is already filtered by grant.
    assert named["withheld_repos"] == 1
    assert unnamed["withheld_repos"] == 0


async def test_an_unavailable_index_degrades_and_says_so(db):
    """A worse answer that announces itself beats no answer — but a worse
    answer presented as a normal one is how recall silently regresses."""
    result = await codesearch.search(db, FakeZoekt(fail=True), q="place_order",
                                     space="pay", acl_keys=await keys(db, "maya"))

    assert result["engine"] == "postgres-fts"
    assert result["degraded"] and "zoekt unavailable" in result["degraded"]
    assert [h["repo"] for h in result["hits"]] == ["example/storefront"]


async def test_with_no_zoekt_configured_search_still_answers(db):
    result = await codesearch.search(db, None, q="place_order", space="pay",
                                     acl_keys=await keys(db, "maya"))

    assert result["engine"] == "postgres-fts"
    assert "not configured" in result["degraded"]


async def test_a_repo_zoekt_has_never_indexed_is_named(db):
    """Silence from an unindexed repository is not evidence of absence, and a
    caller that cannot tell the two apart will read it as evidence."""
    result = await codesearch.search(
        db, FakeZoekt(listed=["github.com/example/storefront"]), q="def",
        space="pay", acl_keys=await keys(db, "maya"))

    assert result["unindexed_repos"] == ["example/ledger"]


async def test_a_hit_whose_revision_moved_is_flagged_stale(db):
    """The shard and the stored file disagreeing means the cited lines may have
    moved. Better to say so than to cite confidently."""
    class Moved(FakeZoekt):
        async def search(self, query, *, repo_names, max_files=None):
            found = await super().search(query, repo_names=repo_names)
            return Results(hits=tuple(
                Hit(repo_name=h.repo_name, path=h.path, version="a-different-sha",
                    language=h.language, branches=h.branches, score=h.score,
                    chunks=h.chunks) for h in found.hits),
                file_count=found.file_count, match_count=found.match_count,
                duration_ms=0.0)

    result = await codesearch.search(db, Moved(), q="place_order", space="pay",
                                     acl_keys=await keys(db, "maya"))

    assert result["hits"][0]["stale"] is True


# ── the symbol primitives ────────────────────────────────────────────────

async def test_find_symbol_reports_whether_it_had_a_symbol_index(db):
    """definitions and mentions are different claims. A model told it received
    definitions will cite the wrong file with confidence."""
    with_index = await codesearch.find_symbol(
        db, FakeZoekt(), name="place_order", space="pay",
        acl_keys=await keys(db, "maya"))
    without = await codesearch.find_symbol(
        db, None, name="place_order", space="pay", acl_keys=await keys(db, "maya"))

    assert with_index["kind"] == "definitions"
    assert without["kind"] == "mentions"


async def test_find_references_admits_it_is_lexical(db):
    result = await codesearch.find_references(
        db, FakeZoekt(), name="price_cart", space="pay",
        acl_keys=await keys(db, "maya"))

    assert result["confidence"] == "lexical"
    assert "not resolved references" in result["caveat"]


async def test_every_hit_carries_an_openable_citation(db):
    result = await codesearch.search(db, FakeZoekt(), q="place_order", space="pay",
                                     acl_keys=await keys(db, "maya"))

    assert result["hits"][0]["citation"] == "example/storefront/src/checkout.py:L1-L3"


class _Req:
    """Enough Request for a handler called directly — the space and the principal
    are what `space_of` and `actor_of` read, and the actor is the whole point
    here: `code.get_file` authorises against the credential, never the body."""

    def __init__(self, body: dict, actor: str = "maya") -> None:
        self._body = body
        self.state = type("S", (), {
            "space": "pay", "principal": type("P", (), {"actor_id": actor})()})()

    async def json(self):
        return self._body

    async def body(self):
        return b"{}"


async def test_reading_a_file_cites_it_the_way_search_cited_it(db, monkeypatch):
    """A citation has to be one string. `code.get_file` spelled the repository as
    its object id — `code_repo-example-storefront-main/src/checkout.py` — where
    search spells it `example/storefront/...`, so following a hit to its file
    silently renamed the thing being cited, and the MCP guide's instruction to
    cite what you retrieved had two answers."""
    from commonindex.gateway import app as gateway

    found = await codesearch.search(db, FakeZoekt(), q="place_order", space="pay",
                                    acl_keys=await keys(db, "maya"))
    monkeypatch.setitem(gateway.state, "pool", db)
    monkeypatch.setitem(gateway.state, "checker", PgChecker(db))

    read = await gateway.code_get_file(
        _Req({"object_id": found["hits"][0]["object_id"], "start_line": 1, "end_line": 3}))

    assert read["citation"] == "example/storefront/src/checkout.py:L1-L3"
    assert read["repo"] == "example/storefront"
    assert read["body"].startswith("def place_order")


async def test_an_unreadable_file_is_not_found_rather_than_partly_answered(db, monkeypatch):
    """The ACL predicate is on the file row, and the repo row is joined only for
    its name — so a left join must not become a way to confirm that a file
    exists."""
    from fastapi.responses import JSONResponse

    from commonindex.gateway import app as gateway

    found = await codesearch.search(db, FakeZoekt(), q="place_order", space="pay",
                                    acl_keys=await keys(db, "maya"))
    monkeypatch.setitem(gateway.state, "pool", db)
    monkeypatch.setitem(gateway.state, "checker", PgChecker(db))

    denied = await gateway.code_get_file(
        _Req({"object_id": found["hits"][0]["object_id"]}, actor="contractor"))

    assert isinstance(denied, JSONResponse) and denied.status_code == 404


# ── query relaxation and dropped candidates ──────────────────────────────

def test_prose_is_distinguished_from_a_deliberate_query():
    """Relaxing `sym:Session` or a regex would answer a different question than
    the caller asked. Only an unadorned multi-word phrase is treated as prose."""
    assert codesearch.is_prose("http connection pooling and retries")
    assert not codesearch.is_prose("sym:place_order")
    assert not codesearch.is_prose("place_.*der")
    assert not codesearch.is_prose("(a or b)")
    assert not codesearch.is_prose("-test place_order")
    assert not codesearch.is_prose("place_order")


def test_relaxation_drops_filler_and_keeps_content_words():
    assert codesearch.relax("how are the options parsed") == "(option or parsed)"
    assert codesearch.relax("what is it") is None


def test_a_plural_in_a_question_finds_the_singular_in_the_code():
    """Zoekt matches substrings: the singular finds both, the plural only itself."""
    assert codesearch.relax("how are refunds for invoices handled") == "(refund or invoice or handled)"
    assert codesearch.relax("which policies apply to classes") == "(policies or policy or apply or class)"
    assert codesearch.relax("where is the status checked") == "(status or checked)"
    got = codesearch.identifiers("how are refunds for invoices handled")
    assert any("refund_invoice" in g for g in got)


class OnlyOr(FakeZoekt):
    """Answers nothing for an ANDed phrase and something for an OR — which is
    how Zoekt actually behaves on a real corpus."""

    async def search(self, query, *, repo_names, max_files=None):
        # Neither the phrase nor its words joined into an identifier
        # (`order_placement_work`) is in a corpus that says `place_order`.
        if " or " not in query or "order_placement" in query:
            return Results(hits=(), file_count=0, match_count=0, duration_ms=0.0)
        return await super().search("place_order", repo_names=repo_names)


async def test_a_prose_question_that_matches_nothing_is_broadened(db):
    """Measured on psf/requests: the strict phrase matched one file, an OR over
    its content words matched eighteen. Without this a reasonable question about
    code that plainly exists returns nothing."""
    result = await codesearch.search(
        db, OnlyOr(), q="how does order placement work", space="pay",
        acl_keys=await keys(db, "maya"))

    assert [h["repo"] for h in result["hits"]] == ["example/storefront"]
    assert result["relaxed_to"] == "(order or placement or work)"
    assert "broadened" in result["routing"]


async def test_a_precise_query_is_never_broadened(db):
    """A query that found something must not be second-guessed, and one written
    with operators must not be rewritten at all."""
    result = await codesearch.search(
        db, FakeZoekt(), q="place_order", space="pay",
        acl_keys=await keys(db, "maya"))

    assert result["relaxed_to"] is None


class Unindexed(FakeZoekt):
    """A shard hit on a path this pipeline never ingested — a file type Zoekt
    accepts and the ingest allowlist does not."""

    async def search(self, query, *, repo_names, max_files=None):
        return Results(hits=(Hit(repo_name=ZOEKT_NAME[STOREFRONT.repo_id],
                                 path="docs/guide.rst", version="v", language="rst",
                                 branches=("main",), score=1.0,
                                 chunks=(Chunk(body="x", start_line=1),)),),
                       file_count=1, match_count=1, duration_ms=0.0)


async def test_a_match_we_cannot_serve_is_counted_not_silently_dropped(db):
    """It presents as "nothing matched" when something did, and the fix — widen
    the ingest allowlist — is nowhere near the symptom."""
    result = await codesearch.search(db, Unindexed(), q="guide", space="pay",
                                     acl_keys=await keys(db, "maya"))

    assert result["hits"] == [] and result["dropped_unindexed"] == 1
    assert "has not indexed" in result["routing"]


def test_a_question_mark_does_not_disable_relaxation():
    """`?` is both how people end questions and a regex quantifier. Treating a
    trailing one as regex classified "how does X work?" as a crafted query, so
    relaxation never fired for a question typed the way people type questions —
    which is every question entered in the UI."""
    assert codesearch.is_prose("What does the ACL crawler do and why?")
    assert codesearch.is_prose("How does a code pull become searchable?")
    # A regex the caller meant is still respected.
    assert not codesearch.is_prose("place_?order handler")


def test_sentence_punctuation_is_stripped_from_a_prose_query():
    assert codesearch.normalize("how does this work?") == "how does this work"
    assert codesearch.normalize("place_.*der") == "place_.*der"


# ── code pasted as a query ──────────────────────────────────────────────


class RegexZoekt(FakeZoekt):
    """Reads a query the way Zoekt does: every term a regular expression, ANDed,
    an unparseable one refused with Zoekt's own error — and a quoted phrase
    unescaped once by the quote parser before the regex sees it."""

    def __init__(self) -> None:
        super().__init__()
        self.queries: list[str] = []

    async def search(self, query: str, *, repo_names: list[str], max_files=None):
        import re
        import shlex

        from commonindex.adapters.zoekt import ZoektBadQuery

        self.queries.append(query)
        terms = shlex.split(query, posix=True) if '"' in query else query.split()
        try:
            patterns = [re.compile(t) for t in terms if not re.match(r"^(lang|file):", t)]
        except re.error as e:
            raise ZoektBadQuery(f"zoekt could not parse the query: error parsing regexp: {e}") from e
        hits = []
        for repo_id, files in CORPUS.items():
            name = ZOEKT_NAME[repo_id]
            if name in repo_names:
                for path, body in files:
                    if all(p.search(body) for p in patterns):
                        hits.append(Hit(repo_name=name, path=path, version=f"sha-{path}", language="Python",
                                        branches=("main",), score=100.0,
                                        chunks=(Chunk(body=body, start_line=1, match_lines=(1,)),)))
        return Results(hits=tuple(hits), file_count=len(hits), match_count=len(hits), duration_ms=1.0)


def test_pasted_code_becomes_one_exact_phrase_and_fields_keep_their_meaning():
    from commonindex.gateway.codesearch import literal

    # Measured on temporalio/temporal: this was a 400 from Zoekt.
    assert literal("func (e *matchingEngineImpl) AddWorkflowTask") == \
        r'"func \\(e \\*matchingEngineImpl\\) AddWorkflowTask"'
    assert literal("lang:go file:matching foo(bar)") == r'lang:go file:matching "foo\\(bar\\)"'
    assert literal('say "hi"') == r'"say \"hi\""'
    assert literal("lang:go") is None


async def test_code_zoekt_cannot_parse_is_searched_for_as_written(db):
    zoekt = RegexZoekt()
    # "place_order(cart," is not a regex: an unclosed group.
    result = await codesearch.search(db, zoekt, q="place_order(cart, user)", space="pay",
                                     acl_keys=await keys(db, "maya"))
    assert result["engine"] == "zoekt" and result["degraded"] is None     # not the Postgres fallback
    assert [h["path"] for h in result["hits"]] == ["src/checkout.py"]
    assert result["as_literal"] == r'"place_order\\(cart, user\\)"'


async def test_code_that_is_a_valid_pattern_but_finds_nothing_is_tried_as_written(db):
    zoekt = RegexZoekt()
    # A valid regex that means something else: (cart) is a group, so it looks
    # for "price_cartcart". The literal text is in the file.
    result = await codesearch.search(db, zoekt, q="price_cart(cart)", space="pay",
                                     acl_keys=await keys(db, "maya"))
    assert [h["path"] for h in result["hits"]] == ["src/checkout.py"]
    assert result["as_literal"] == r'"price_cart\\(cart\\)"'


async def test_a_deliberate_pattern_that_matches_is_left_alone(db):
    zoekt = RegexZoekt()
    result = await codesearch.search(db, zoekt, q="place_.*order", space="pay",
                                     acl_keys=await keys(db, "maya"))
    assert [h["path"] for h in result["hits"]] == ["src/checkout.py"]
    assert result["as_literal"] is None and zoekt.queries == ["place_.*order"]


class Named(FakeZoekt):
    """A corpus where the question's words, joined, are an identifier."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.asked: list[str] = []

    async def search(self, query, *, repo_names, max_files=None):
        self.asked.append(query)
        if "placeorder" in query or "place_order" in query:
            return await super().search("place_order", repo_names=repo_names)
        return Results(hits=(), file_count=0, match_count=0, duration_ms=0.0)


async def test_a_question_names_code_in_words_and_is_searched_as_the_identifier(db):
    """"How does the matching engine add a workflow task" is AddWorkflowTask:
    neighbouring words joined are tried before any one word alone, which on a
    large real repository ranked a block of imports first."""
    fake = Named()
    result = await codesearch.search(db, fake, q="where do we place order for a cart", space="pay",
                                     acl_keys=await keys(db, "maya"))
    assert [h["path"] for h in result["hits"]] == ["src/checkout.py"]
    assert "placeorder" in result["as_identifiers"] and "place_order" in result["as_identifiers"]
    assert "identifiers its words name" in result["routing"]
    assert not any(q.startswith("(where") for q in fake.asked)       # never fell back to single words


def test_identifiers_join_neighbouring_words_longest_first():
    got = codesearch.identifiers("how does the matching engine add a workflow task")
    assert "addworkflowtask" in got[0] and "add_workflow_task" in got[0]
    assert "matchingengine" in got[1]


def test_an_identifier_written_in_the_question_is_searched_as_written_first():
    got = codesearch.identifiers("Where is AddWorkflowTask implemented in the matching service?")
    assert got[0] == "(AddWorkflowTask)"
    assert codesearch.code_words("call place_order then submitPayment") == ["place_order", "submitPayment"]



# ── what a search says about itself ──────────────────────────────────────


async def test_a_shard_at_the_indexed_commit_is_not_stale_and_one_behind_is(db):
    """A file's own sha is the commit its content last changed at, so comparing
    the shard to it flagged nearly every hit on a large real repository as stale. The shard is
    compared to the repository's indexed commit."""
    acl = await keys(db, "maya")
    fresh = await codesearch.search(db, FakeZoekt(), q="place_order", space="pay", acl_keys=acl)
    assert fresh["hits"] and not any(h["stale"] for h in fresh["hits"])
    behind = FakeZoekt()
    behind.version = "f" * 40
    old = await codesearch.search(db, behind, q="place_order", space="pay", acl_keys=acl)
    assert all(h["stale"] for h in old["hits"])


async def test_a_copy_of_a_repository_under_an_older_id_is_retired_when_it_is_indexed_again(db):
    """An older build named a repository `...-main-b6f6edb…`; re-indexed under the
    current id, both copies answered every search and the routing said the
    repository was "not indexed" beside its own results."""
    old_id = STOREFRONT.repo_id + "-b6f6edb"
    await db.execute(
        "insert into objects (id, space_id, type, title, props, acl_keys, created_by)"
        " select $1, space_id, type, title, props, acl_keys, created_by from objects where id = $2",
        old_id, STOREFRONT.repo_id)
    await db.execute(
        "insert into objects (id, space_id, type, title, props, acl_keys, created_by)"
        " values ('code_file-old-copy', 'pay', 'code_file', 'src/checkout.py',"
        "         jsonb_build_object('repo_id', $1::text, 'path', 'src/checkout.py'), $2, 'maya')",
        old_id, [STOREFRONT.acl_key])
    acl = await keys(db, "maya")
    # Even before it is retired, a search sees one repository, not two.
    assert [r.repo_id for r in await codesearch.readable_repos(db, "pay", acl)].count(STOREFRONT.repo_id) == 1
    assert len([r for r in await codesearch.readable_repos(db, "pay", acl) if r.slug == "example/storefront"]) == 1
    result = await codesearch.search(db, FakeZoekt(), q="place_order", space="pay", acl_keys=acl)
    assert result["unindexed_repos"] == []

    await _upsert_repo(db, STOREFRONT, "1" * 40, "maya")
    gone = await db.fetch("select id from objects where id = any($1::text[]) and deleted_at is not null",
                          [old_id, "code_file-old-copy"])
    assert {r["id"] for r in gone} == {old_id, "code_file-old-copy"}
    assert await db.fetchval("select deleted_at from objects where id = $1", STOREFRONT.repo_id) is None


class Phrase(FakeZoekt):
    """Two files: one holds the phrase, the other each word apart and first."""

    async def search(self, query, *, repo_names, max_files=None):
        loose = Hit(repo_name=ZOEKT_NAME[STOREFRONT.repo_id], path="src/checkout.py", version=self.version,
                    language="Python", branches=("main",), score=200.0,
                    chunks=(Chunk(body="def place_order(cart, user):", start_line=1),
                            Chunk(body="    total = price_cart(cart)", start_line=2)))
        exact = Hit(repo_name=ZOEKT_NAME[LEDGER.repo_id], path="posting.py", version=self.version,
                    language="Python", branches=("main",), score=50.0,
                    chunks=(Chunk(body="def post_journal_entry(txn):", start_line=1),
                            Chunk(body="    return ledger.add(txn)", start_line=2)))
        hits = (exact,) if query.startswith('"') else (loose, exact)
        return Results(hits=hits, file_count=len(hits), match_count=len(hits), duration_ms=1.0)


async def test_a_few_plain_words_rank_the_file_holding_the_phrase_first_and_cite_its_lines(db):
    """`make bins` ranked two files holding each word apart above CONTRIBUTING.md,
    and cited lines 31-35 there — "make" alone — while the phrase was at 66."""
    result = await codesearch.search(db, Phrase(), q="ledger add", space="pay",
                                     acl_keys=await keys(db, "maya"))
    assert [h["path"] for h in result["hits"]] == ["posting.py", "src/checkout.py"]
    assert result["hits"][0]["start_line"] == 2                     # the chunk with both words


def test_code_is_shown_exactly_with_its_first_line_s_indentation():
    from commonindex.adapters.dataskill import fenced

    block = fenced("\n\tmatchingEngineImpl struct {\n", "go")
    assert block == "```go\n\n\tmatchingEngineImpl struct {\n```"


async def test_new_indexing_rules_reach_files_the_last_commit_did_not_touch(db):
    """Indexing is incremental from the last commit, so widening what counts as
    source never reached a Makefile unchanged since: the same commit re-indexed
    read nothing. A repository indexed under other rules is read whole."""
    from commonindex.workers.codequery import _cursor_for
    from commonindex.workers.connectors import localgit

    assert await _cursor_for(db, STOREFRONT) == "0" * 40
    await db.execute("update objects set props = props || '{\"index_rules\": \"older\"}' where id = $1",
                     STOREFRONT.repo_id)
    assert await _cursor_for(db, STOREFRONT) is None
    assert localgit.RULES and len(localgit.RULES) == 12
