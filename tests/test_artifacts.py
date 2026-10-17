"""Artifacts, against a real database and a stand-in browser.

An artifact is HTML that runs, kept as its own item; a doc embeds it by id.
Defended: the HTML must be self-contained before it is saved; a new artifact
is its creator's; saving needs edit, keeps every version and refuses a stale
one; a snapshot follows each save and a newer save owns it; a doc stays a
block tree — an embed holds an id, never HTML; a shared page or an export
shows an embed's snapshot only to whoever may see the artifact, escapes what
it shows, and runs no script.
"""

from __future__ import annotations

import json
import stat

import pytest
from test_sharing import _doc_type, _PoolOf, _Req, call, db  # noqa: F401 - the fixture, reused

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

GOOD = """<div class="chart"><svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">
  <rect width="30" height="40" /></svg><button id="b">Count</button></div>
<style>.chart { padding: 12px }</style>
<script>let n = 0; document.getElementById('b').onclick = () => { n += 1 }</script>"""


def _artifact_type():
    from commonindex.gateway.app import TYPES

    return next(t for t in TYPES if t.id == "artifact")


async def new_artifact(db, actor="maya", **props):  # noqa: F811
    from commonindex.gateway.artifacts import artifacts_propose

    return await call(db, artifacts_propose, actor, **{"title": "Refund chart", **props})


@pytest.fixture
def browser(tmp_path, monkeypatch):
    """A stand-in for headless Chrome: writes a PNG where it is told to, or
    fails when the page says so."""
    from commonindex.gateway import artifacts

    script = tmp_path / "fake-chrome"
    script.write_text("#!/bin/sh\n"
                      'for a in "$@"; do case "$a" in --screenshot=*) out="${a#--screenshot=}";; '
                      "file://*) page=\"${a#file://}\";; esac; done\n"
                      'if grep -q break-me "$page"; then exit 4; fi\n'
                      'printf "\\211PNG-fake" > "$out"\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("COMMONINDEX_CHROME", str(script))
    monkeypatch.setenv("COMMONINDEX_MEDIA_DIR", str(tmp_path / "media"))
    (tmp_path / "media" / "artifacts").mkdir(parents=True)
    return artifacts


async def settled(db):  # noqa: F811
    """Snapshots are queued for a worker; run what is queued."""
    from commonindex.workers.jobs import drain

    await drain(_PoolOf(db))


async def props_of(db, object_id):  # noqa: F811
    return json.loads(await db.fetchval("select props from objects where id = $1", object_id))


# ── what an artifact may be ─────────────────────────────────────────────


@pytest.mark.parametrize("bad, why", [
    ('<img src="https://evil.test/x.png">', "URL"),
    ('<script src="app.js"></script>', "external script"),
    ("<script>fetch('/api/v1/docs.list')</script>", "network request"),
    ("<form><input></form>", "form"),
    ("<iframe srcdoc='x'></iframe>", "iframe"),
    ("<script>parent.location = 'x'</script>", "navigation"),
])
def test_an_artifact_stays_inside_its_frame(bad, why):
    from commonindex.gateway.artifacts import check

    assert check(GOOD) is None                       # inline script, style and SVG are what it is for
    assert why in (check(GOOD + bad) or "")
    assert "empty" in check("  ")


# ── the collection ──────────────────────────────────────────────────────


async def test_a_new_artifact_is_its_creators_and_checked(db, browser):  # noqa: F811
    from commonindex.gateway.collections import make_list

    status, out = await new_artifact(db, html=GOOD)
    assert status == 200
    _, mine = await call(db, make_list(_artifact_type()), "maya")
    _, theirs = await call(db, make_list(_artifact_type()), "rhea")
    assert [a["id"] for a in mine["artifacts"]] == [out["id"]] and theirs["artifacts"] == []
    status, bad = await new_artifact(db, html="<script>fetch('x')</script>")
    assert (status, bad["error"]["code"]) == (422, "bad_html")
    status, claimed = await new_artifact(db, html=GOOD, snapshot={"status": "ready"})
    assert (status, claimed["error"]["code"]) == (422, "governed_field")
    await settled(db)
    assert (await props_of(db, out["id"]))["snapshot"]["status"] == "ready"


async def test_saving_needs_edit_keeps_versions_and_refuses_a_stale_one(db, browser):  # noqa: F811
    from commonindex.gateway.artifacts import artifacts_save
    from commonindex.gateway.sharing import items_share

    _, out = await new_artifact(db, html=GOOD)
    aid = out["id"]
    await settled(db)
    status, refused = await call(db, artifacts_save, "rhea", artifact_id=aid, html=GOOD)
    assert (status, refused["error"]["code"]) == (404, "unknown_item")          # not hers to see
    await call(db, items_share, "maya", id=aid, email="rhea@example.test", role="view")
    status, refused = await call(db, artifacts_save, "rhea", artifact_id=aid, html=GOOD)
    assert status == 403                                                          # seen, not edited
    status, saved = await call(db, artifacts_save, "maya", artifact_id=aid, html=GOOD + "<p>v2</p>", if_rev=1)
    assert (status, saved["rev"]) == (200, 2)
    await settled(db)
    status, stale = await call(db, artifacts_save, "maya", artifact_id=aid, html=GOOD, if_rev=1)
    assert (status, stale["error"]["code"]) == (409, "stale_revision")
    status, tall = await call(db, artifacts_save, "maya", artifact_id=aid, height=5000)
    assert (status, tall["error"]["code"]) == (422, "bad_height")
    delta = json.loads(await db.fetchval("select delta from revisions where object_id = $1 and rev = 2", aid))
    assert delta["props"]["html"].endswith("<p>v2</p>")                         # the version is kept, in full
    await settled(db)


async def test_a_snapshot_follows_the_save_and_a_newer_save_owns_it(db, browser):  # noqa: F811
    from commonindex.gateway.artifacts import artifacts_save, artifacts_snapshot, run_snapshot

    _, out = await new_artifact(db, html=GOOD)
    aid = out["id"]
    await settled(db)
    png = await artifacts_snapshot(_Req({"artifact_id": aid}, db, "maya"))
    assert png.status_code == 200 and str(png.path).endswith(f"{aid}.png")
    status, _ = await call(db, artifacts_snapshot, "rhea", artifact_id=aid)
    assert status == 404                                                          # only to who may see it

    await call(db, artifacts_save, "maya", artifact_id=aid, html=GOOD + "<p>break-me</p>")
    await settled(db)
    snap = (await props_of(db, aid))["snapshot"]
    assert snap["status"] == "failed" and "could not draw" in snap["error"]

    # A snapshot that finishes after a newer save asked for another is dropped.
    await run_snapshot(_PoolOf(db), aid, GOOD, 420, "an-old-job")
    assert (await props_of(db, aid))["snapshot"]["status"] == "failed"


async def test_a_snapshot_is_as_tall_as_the_content_up_to_the_max(tmp_path, monkeypatch):
    """A page shorter than its max height is not shot with blank page under it:
    a measuring pass reads the height first, and the shot takes that."""
    from commonindex.gateway import artifacts

    seen = tmp_path / "sizes"
    script = tmp_path / "fake-chrome"
    script.write_text("#!/bin/sh\n"
                      'for a in "$@"; do case "$a" in --screenshot=*) out="${a#--screenshot=}";; '
                      '--window-size=*) echo "${a#--window-size=}" >> ' + str(seen) + ';; esac; done\n'
                      'if [ -n "$out" ]; then printf "\\211PNG" > "$out"; '
                      "else echo '<html data-snapshot-height=\"310\">'; fi\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("COMMONINDEX_CHROME", str(script))
    monkeypatch.setenv("COMMONINDEX_MEDIA_DIR", str(tmp_path / "media"))
    (tmp_path / "media" / "artifacts").mkdir(parents=True)
    assert (await artifacts.take_snapshot("artifact-x", GOOD, 1600))["status"] == "ready"
    assert seen.read_text().split() == ["760,1600", "760,310"]          # measured at the max, shot at the content
    seen.unlink()
    await artifacts.take_snapshot("artifact-x", GOOD, 200)
    assert seen.read_text().split() == ["760,200", "760,200"]           # never past the max
    seen.unlink()
    await artifacts.take_snapshot("artifact-x", "<!doctype html><html><body>page</body></html>", 1600)
    assert seen.read_text().split() == ["1280,800"]                     # a page: its first screen, at desktop size


def test_a_whole_document_is_a_page():
    from commonindex.gateway.artifacts import is_page

    assert is_page("<!DOCTYPE html><html><body>x</body></html>")
    assert is_page("  <!-- made by AI -->\n<html lang='en'>")
    assert not is_page(GOOD) and not is_page("<div><html-ish></div>")


async def test_without_a_browser_it_says_so(db, browser, monkeypatch):  # noqa: F811
    from commonindex.gateway import artifacts

    monkeypatch.delenv("COMMONINDEX_CHROME")
    monkeypatch.setattr(artifacts, "chrome_path", lambda: None)
    _, out = await new_artifact(db, html=GOOD)
    await settled(db)
    assert (await props_of(db, out["id"]))["snapshot"]["status"] == "unavailable"


async def test_deleting_is_for_owners_and_takes_the_snapshot(db, browser):  # noqa: F811
    from commonindex.gateway.artifacts import artifacts_delete, snapshot_key
    from commonindex.gateway.media import store
    from commonindex.gateway.sharing import items_share

    _, out = await new_artifact(db, html=GOOD)
    aid = out["id"]
    await settled(db)
    await call(db, items_share, "maya", id=aid, email="rhea@example.test", role="edit")
    status, _ = await call(db, artifacts_delete, "rhea", artifact_id=aid)
    assert status == 403
    status, _ = await call(db, artifacts_delete, "maya", artifact_id=aid)
    assert status == 200 and not await store().exists(snapshot_key(aid))


# ── in a doc ────────────────────────────────────────────────────────────


def _body(*refs):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Refunds by week:"}]},
        *[{"type": "embed", "attrs": {"ref": r}} for r in refs]]}


async def _doc_with(db, *refs):  # noqa: F811
    from commonindex.gateway.collections import make_propose
    from commonindex.gateway.docs import docs_revise

    _, doc = await call(db, make_propose(_doc_type()), "maya", title="Refunds", freshness="fresh",
                        body={"type": "doc", "content": [{"type": "paragraph"}]})
    status, out = await call(db, docs_revise, "maya", doc_id=doc["id"], body=_body(*refs))
    assert status == 200, out
    return doc["id"]


async def test_a_doc_embeds_an_id_and_never_html(db, browser):  # noqa: F811
    from commonindex.gateway.docs import docs_revise

    _, art = await new_artifact(db, html=GOOD)
    doc = await _doc_with(db, art["id"])
    tree = (await props_of(db, doc))["body"]
    assert tree["content"][1] == {"type": "embed", "attrs": {"ref": art["id"]}}
    status, bad = await call(db, docs_revise, "maya", doc_id=doc,
                             body={"type": "doc", "content": [{"type": "html", "text": GOOD}]})
    assert (status, bad["error"]["code"]) == (422, "invalid_props")             # no node takes markup
    await settled(db)


async def test_an_export_shows_the_snapshot_only_to_who_may_see_it(db, browser):  # noqa: F811
    from commonindex.gateway.docs import docs_export
    from commonindex.gateway.sharing import items_share

    _, art = await new_artifact(db, html=GOOD, title='<b onmouseover="x">Weekly refunds</b>')
    await settled(db)
    doc = await _doc_with(db, art["id"], "artifact-gone")
    await call(db, items_share, "maya", id=doc, email="rhea@example.test", role="view")

    _, mine = await call(db, docs_export, "maya", doc_id=doc)
    assert "data:image/png;base64," in mine["html"] and f"/artifacts/{art['id']}" in mine["html"]
    assert "&lt;b onmouseover=&quot;x&quot;&gt;Weekly refunds" in mine["html"]          # escaped, not markup
    assert "<script" not in mine["html"] and "Count" not in mine["html"]         # the still, not the HTML
    assert mine["html"].count("not shared with you") == 1                        # the deleted one

    _, hers = await call(db, docs_export, "rhea", doc_id=doc)                    # the doc is shared, not the artifact
    assert "data:image" not in hers["html"] and "Weekly refunds" not in hers["html"]
    assert hers["html"].count("not shared with you") == 2


async def test_a_shared_page_shows_what_its_maker_may_see_now(db, browser):  # noqa: F811
    from commonindex.gateway.artifacts import embeds
    from commonindex.gateway.sharing import items_set_visibility

    _, art = await new_artifact(db, html=GOOD)
    await settled(db)
    tree = _body(art["id"])
    assert (await embeds(db, tree, "pay", "maya"))[art["id"]]["image"].startswith("data:image/png")
    assert (await embeds(db, tree, "pay", "rhea"))[art["id"]] is None
    assert (await embeds(db, tree, "pay", None))[art["id"]] is None              # a link whose maker is gone
    status, _ = await call(db, items_set_visibility, "maya", id=art["id"], visibility="workspace")
    assert status == 200
    assert (await embeds(db, tree, "pay", "rhea"))[art["id"]] is not None        # opened to the workspace


# ── written by the model ────────────────────────────────────────────────


class _Llm:
    model = "stand-in"

    def __init__(self, answer):
        self.answer, self.asked = answer, []

    async def complete(self, messages, **_):
        self.asked.append(messages[-1]["content"])
        return self.answer


async def _draft(db, llm, **body):  # noqa: F811
    from commonindex.gateway.artifacts import artifacts_draft

    req = _Req(body, db, "maya")
    req.app.state.commonindex["llm"] = llm
    out = await artifacts_draft(req)
    return (out.status_code, json.loads(out.body)) if hasattr(out, "status_code") else (200, out)


async def test_the_model_writes_html_that_passes_the_check_or_none(db):  # noqa: F811
    status, out = await _draft(db, _Llm("```html\n" + GOOD + "\n```"), instruction="a counter")
    assert (status, out["html"]) == (200, GOOD.strip())                         # the fence is taken off
    llm = _Llm(GOOD)
    await _draft(db, llm, instruction="make it blue", html="<p>old</p>")
    assert "<current>\n<p>old</p>" in llm.asked[0]                              # an edit sees what it edits
    status, out = await _draft(db, _Llm('<script src="https://cdn.test/chart.js"></script>'), instruction="a chart")
    assert (status, out["error"]["code"]) == (422, "bad_html")
    status, out = await _draft(db, None, instruction="a chart")
    assert (status, out["error"]["code"]) == (503, "llm_unconfigured")


async def test_the_model_writes_a_whole_page_when_asked_for_one(db):  # noqa: F811
    from commonindex.gateway.artifacts import PAGE_SYSTEM, is_page

    page = "<!doctype html><html lang='en'><head><title>R</title></head><body><nav>R</nav></body></html>"
    llm = _Llm(page)
    status, out = await _draft(db, llm, instruction="a landing page", kind="page")
    assert (status, out["kind"], out["html"]) == (200, "page", page)
    assert "ONE complete HTML document" in PAGE_SYSTEM
    llm = _Llm("<section><h1>Refund Desk</h1></section>")                     # only a body: made a page
    status, out = await _draft(db, llm, instruction="Refund Desk landing", kind="page")
    assert status == 200 and is_page(out["html"]) and "<title>Refund Desk landing</title>" in out["html"]
    status, out = await _draft(db, _Llm(page), instruction="make it blue", html=page)
    assert out["kind"] == "page"                                              # editing a page stays a page
    status, out = await _draft(db, _Llm(page), instruction="x", kind="poster")
    assert (status, out["error"]["code"]) == (422, "bad_kind")
