"""Writing a doc, keeping what it was, and asking the model to help.

A doc body is a block tree the type declares node by node, so `revise` checks
it the way `propose` does — there is no field anything could put HTML in, and a
model's answer is text the browser parses into that same tree.

`assist` is the design generator's shape again: it returns text and files
nothing. Applying it is an ordinary `docs.revise`, which is what puts an AI edit
in the same history as a person's, attributed and undoable the same way.

The model is the one the workspace already answers code questions with
(`COMMONINDEX_LLM_*`), not a second credential: a workspace that has wired one model
has wired AI, and should not discover a separate switch per surface.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from commonindex.gateway import docrender
from commonindex.gateway.collections import _schema_violation, make_propose, replayed
from commonindex.gateway.docindex import embed_object, search_docs
from commonindex.gateway.llm import LlmTruncated, LlmUnavailable
from commonindex.workers.indexer import index_object

router = APIRouter()

#: The same cap designs keep, for the same reason: every save is a full
#: snapshot, and autosave writes one every few seconds of typing.
KEEP_REVISIONS = 100

#: Where the author's cursor is, in the markdown the browser sends. Brackets no
#: markdown serialiser escapes, so it arrives intact and cannot be mistaken for
#: anything the author wrote.
HERE = "⟦here⟧"

#: What the model may be handed. A doc past this is a doc to edit a section of
#: at a time, and saying so beats a provider's context-length error.
MAX_DOC_CHARS = 60_000
MAX_SELECTION_CHARS = 20_000
MAX_INSTRUCTION_CHARS = 4_000

SYSTEM = (
    "You are a writing assistant inside a document editor. You are given a "
    "document as markdown and an instruction from its author.\n"
    "Rules:\n"
    "- Answer with the markdown itself. No preamble, no explanation, no closing "
    "remark, and do not wrap the answer in a code fence.\n"
    "- Use headings, paragraphs, bold, italic, strikethrough, inline code, links, "
    "bullet lists, numbered lists, task lists (- [ ] / - [x]), blockquotes, "
    "fenced code blocks, horizontal rules and pipe tables. No HTML.\n"
    # A diagram is a mermaid flowchart because that is what the editor and the
    # shared page draw. Without this the model drew boxes in ASCII art, which a
    # 1.5B model then also wrapped in a code fence (observed, qwen2.5-coder).
    "- A diagram, flow, flowchart or sequence of steps to draw is ALWAYS a "
    "mermaid flowchart in a fenced block, never ASCII art. For example:\n"
    "```mermaid\nflowchart LR\n  A[Request] --> B[Approve]\n  B --> C[Done]\n```\n"
    # An embed is the doc's only way to hold HTML, and it holds an id, not the
    # HTML: a rewrite that drops the line deletes the embed from the doc.
    "- A line like :::embed {ref=\"artifact-…\"} ::: is an embedded artifact. Keep "
    "every such line exactly as it is, where it is, unless told to remove it; "
    "never write HTML for one.\n"
    "- Keep everything the instruction does not ask you to change exactly as it "
    "is, including its formatting.\n"
    # No placeholder example: given "such as [owner]", the same model put
    # "[owner]" in front of every line it wrote.
    "- Never invent facts, names, numbers or links the author did not give you."
)


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message,
                                           "field": field}})


def excerpt(body: Any, limit: int = 180) -> str:
    """The first words of the body as plain text, for a list row.

    Derived here on every revise rather than sent by the caller, so the row a
    person scans cannot say something the doc does not.
    """
    words: list[str] = []
    size = 0

    def walk(node: Any) -> bool:
        nonlocal size
        if not isinstance(node, dict):
            return True
        text = node.get("text")
        if isinstance(text, str) and text.strip():
            words.append(text.strip())
            size += len(text) + 1
            if size >= limit:
                return False
        for child in node.get("content") or []:
            if not walk(child):
                return False
        return True

    walk(body)
    out = re.sub(r"\s+", " ", " ".join(words)).strip()
    return out if len(out) <= limit else out[: limit - 1].rstrip() + "…"


#: A fence around the whole answer, when it is a wrapper: `markdown`, `md` or
#: bare. Any other language is content — an answer that is one ```mermaid
#: block is a diagram, and unwrapping it would leave its source as prose.
_FENCE = re.compile(r"^\s*```(?:markdown|md)?[ \t]*\n(.*?)\n```\s*$", re.DOTALL | re.IGNORECASE)


_TAGGED = re.compile(r"<(passage|document)>\n?(.*?)\n?</\1>", re.DOTALL)


_WRAPPER = re.compile(r"^```(?:markdown|md)?[ \t]*$", re.IGNORECASE)


def _unwrap_open_fence(text: str) -> str:
    """A ```markdown wrapper the model opened and did not close cleanly.

    Observed: the answer opened with ```markdown, carried on past where it
    should have closed, and the editor inserted the whole thing as one code
    block. Only a `markdown`/`md`/bare opener is a wrapper — an answer that
    STARTS with ```mermaid is a diagram, and is the author's content.
    """
    lines = text.split("\n")
    if not lines or not _WRAPPER.match(lines[0].strip()):
        return text
    body = lines[1:]
    # The wrapper's closing line, if any, is the last bare fence when what is
    # left has an odd number of fence lines — an even number means every fence
    # inside belongs to a block the author wanted.
    fences = [i for i, line in enumerate(body) if line.strip().startswith("```")]
    if len(fences) % 2 == 1 and body[fences[-1]].strip() == "```":
        del body[fences[-1]]
    return "\n".join(body)


def clean(answer: str) -> str:
    """What the model said, minus the wrapping models add despite being asked.

    Only a fence around the WHOLE answer is removed: a doc that contains a code
    block must keep it. An answer that repeats our own `<passage>` tag is the
    model answering inside the structure it was given, so the tagged part is
    the answer and whatever sits around it is commentary. The cursor marker is
    dropped wherever it survived, because it was ours and never the author's.
    """
    text = re.sub(r"^\s*Answer:\s*", "", answer.strip())
    tagged = _TAGGED.search(text)
    if tagged:
        text = tagged.group(2).strip()
    m = _FENCE.match(text)
    if m:
        text = m.group(1)
    else:
        text = _unwrap_open_fence(text)
    # A tag the model opened or closed on a line of its own — "[/passage]",
    # "</document>" — is our structure leaking, never the author's text.
    text = re.sub(r"(?m)^\s*[<\[]/?(passage|document|instruction)[>\]]\s*$", "", text)
    return text.replace(HERE, "").strip()


def _budget(chars: int, floor: int, ceiling: int) -> int:
    """Output tokens for an answer about `chars` long. A rewrite is roughly as
    long as what it rewrites (about 3 characters a token for prose), plus room
    for what it adds."""
    return max(floor, min(ceiling, chars // 3 + floor))


@router.post("/api/v1/docs.revise")
async def docs_revise(req: Request):
    """Replace a doc's body, keeping what it replaced — `designs.revise` for a
    block tree. A snapshot, not a diff, so restoring is one statement."""
    from commonindex.gateway.app import TYPES
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    doc_id = (body.get("doc_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, doc_id, space, "edit", "doc_id"):
        return refused
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key",
                      "a mutation needs an idempotency key", "idempotencyKey")

    doc_type = next((t for t in TYPES if t.id == "doc"), None)
    actor = actor_of(req)

    async with state["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "select title, props, current_rev, created_by from objects where id = $1"
            "   and space_id = $2 and type = 'doc' and deleted_at is null",
            doc_id, space)
        if row is None:
            return _error(404, "unknown_doc", f"no doc {doc_id!r}", "doc_id")

        props = json.loads(row["props"]) if isinstance(row["props"], str) else dict(row["props"])
        # A retry after a timeout carries the key of a save that already
        # landed: it is answered with that revision, not written again — and
        # not refused as stale, which is what its own first attempt made it.
        if done := await replayed(conn, doc_id, body["idempotencyKey"]):
            return {"doc_id": doc_id, "rev": done, "excerpt": props.get("excerpt", ""),
                    "replayed": True}
        if body.get("body") is not None:
            props["body"] = body["body"]
        for f in ("title", "freshness"):
            if body.get(f) is not None:
                props[f] = body[f]
        props["excerpt"] = excerpt(props.get("body"))

        violation = _schema_violation(doc_type, props)
        if violation:
            why, field = violation
            return _error(422, "invalid_props",
                          f"this does not match the doc type — {why}", field)

        # Two tabs on one doc, or two people: the second save would carry the
        # first one's paragraph back to how it was. Refused, not merged — there
        # is no CRDT here yet, and a silent last-write-wins is worse than a
        # visible conflict.
        at = int(row["current_rev"] or 1)
        want = body.get("if_rev")
        if want is not None and int(want) != at:
            return _error(409, "stale_revision",
                          f"this doc is at rev {at} and you last read rev {want}"
                          " — somebody else changed it. Reload it and make your"
                          " change to what is there now.", "if_rev")

        rev = at + 1
        async with conn.transaction():
            # A doc as it was created — by an agent over MCP, an import, a
            # propose — has no revision of its own, so the first change would
            # leave its original content nowhere History can bring it back
            # from. It is kept, once, before the first change lands.
            if not await conn.fetchval("select exists(select 1 from revisions where object_id = $1)", doc_id):
                before = json.loads(row["props"]) if isinstance(row["props"], str) else dict(row["props"])
                await conn.execute(
                    "insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
                    doc_id, at, row["created_by"], json.dumps({"props": before, "note": "as created"}))
            await conn.execute(
                "insert into revisions (object_id, rev, author_id, delta)"
                " values ($1,$2,$3,$4::jsonb)",
                doc_id, rev, actor,
                json.dumps({"props": props, "note": (body.get("note") or "").strip(),
                            "key": body["idempotencyKey"]}))
            await conn.execute(
                "update objects set props = $2::jsonb, title = $3, current_rev = $4,"
                "       updated_at = now() where id = $1",
                doc_id, json.dumps(props), str(props.get("title") or row["title"]), rev)
            await index_object(conn, doc_id)
            await conn.execute(
                "delete from revisions where object_id = $1 and rev < ("
                "  select rev from revisions where object_id = $1"
                "   order by rev desc offset $2 limit 1)",
                doc_id, KEEP_REVISIONS - 1)

    # The indexer rewrote the chunks inside the save; the vectors for any
    # section whose text changed are made now, outside it.
    return {"doc_id": doc_id, "rev": rev, "excerpt": props["excerpt"],
            "index": await embed_object(state, doc_id)}


def _doc_type():
    from commonindex.gateway.app import TYPES

    return next(t for t in TYPES if t.id == "doc")


@router.post("/api/v1/docs.propose")
async def docs_propose(req: Request):
    """The generated `propose` — which makes the doc private to its author and
    indexes it — then its vectors, so a doc an agent files over MCP is found by
    meaning at once, not after somebody first edits it."""
    got = await make_propose(_doc_type())(req)
    if isinstance(got, dict) and got.get("created"):
        # The list card shows `excerpt`, which revise derived and propose never
        # did: every doc an agent or an import wrote read "Empty" in the list.
        async with req.app.state.commonindex["pool"].acquire() as conn:
            body = await conn.fetchval("select props->'body' from objects where id = $1", got["id"])
            body = json.loads(body) if isinstance(body, str) else body
            await conn.execute("update objects set props = props || jsonb_build_object('excerpt', $2::text)"
                               " where id = $1", got["id"], excerpt(body))
        got["index"] = await embed_object(req.app.state.commonindex, got["id"])
    return got


@router.post("/api/v1/docs.history")
async def docs_history(req: Request):
    """What this doc has been, newest first."""
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    doc_id = (body.get("doc_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, doc_id, space, "view", "doc_id"):
        return refused

    owner = await state["pool"].fetchval(
        "select 1 from objects where id = $1 and space_id = $2 and type = 'doc'"
        "   and deleted_at is null", doc_id, space)
    if owner is None:
        return _error(404, "unknown_doc", f"no doc {doc_id!r}", "doc_id")

    rows = await state["pool"].fetch(
        "select r.rev, r.author_id, r.ts, r.delta, a.display"
        "  from revisions r left join actors a on a.id = r.author_id"
        " where r.object_id = $1 order by r.rev desc limit $2", doc_id, KEEP_REVISIONS)

    out = []
    for r in rows:
        d = json.loads(r["delta"]) if isinstance(r["delta"], str) else r["delta"]
        props = (d or {}).get("props") or {}
        out.append({
            "rev": r["rev"], "at": r["ts"],
            "by": r["display"] or r["author_id"],
            "note": (d or {}).get("note") or "",
            "title": props.get("title"),
            "body": props.get("body"),
        })
    return {"doc_id": doc_id, "revisions": out}


@router.post("/api/v1/docs.assist")
async def docs_assist(req: Request):
    """Write or edit with the workspace's model. Returns markdown; saves nothing."""
    state = req.app.state.commonindex
    body = await req.json()

    instruction = (body.get("instruction") or "").strip()
    markdown = body.get("markdown") or ""
    selection = body.get("selection") or ""
    title = (body.get("title") or "").strip()
    if not instruction:
        return _error(422, "no_instruction", "say what to write or change", "instruction")
    if not all(isinstance(x, str) for x in (markdown, selection)):
        return _error(422, "bad_text", "markdown and selection are strings", "markdown")
    if len(instruction) > MAX_INSTRUCTION_CHARS:
        return _error(422, "too_long", "the instruction is longer than "
                      f"{MAX_INSTRUCTION_CHARS} characters", "instruction")
    if len(markdown) > MAX_DOC_CHARS:
        return _error(422, "too_long",
                      f"the doc is over {MAX_DOC_CHARS} characters — select the "
                      "section to edit and ask about that", "markdown")
    if len(selection) > MAX_SELECTION_CHARS:
        return _error(422, "too_long", "the selection is over "
                      f"{MAX_SELECTION_CHARS} characters", "selection")

    llm = state.get("llm")
    if llm is None:
        return _error(503, "llm_unconfigured",
                      "no model is configured for this workspace. Set "
                      "COMMONINDEX_LLM_BASE_URL and COMMONINDEX_LLM_MODEL on the gateway "
                      "(any OpenAI-compatible endpoint) to enable AI editing.")

    doc = markdown.strip() or "(the document is empty)"
    head = f"Title: {title}\n\n" if title else ""
    # Tags rather than headings: a small model given "PASSAGE TO REWRITE:" as a
    # heading was observed (qwen2.5-coder 1.5B) returning that heading as the
    # first line of its answer. A tag reads as structure, not as content.
    if selection.strip():
        scope = "selection"
        # The passage alone, not the doc around it. Given both, the same model
        # rewrote the passage correctly and then returned the WHOLE document,
        # which pasted over a selection duplicates everything else in it.
        # One worked example, because what a small model gets wrong here is
        # the shape of the answer — a heading on top, a note underneath —
        # rather than the edit itself, and an example fixes shape best.
        prompt = ("Example.\n<passage>\nthe build is broke again\n</passage>\n"
                  "<instruction>fix the grammar</instruction>\n"
                  "Answer: The build is broken again.\n\n"
                  f"Now yours. Do not add a heading, a title or any note.\n"
                  f"{head}<passage>\n{selection}\n</passage>\n"
                  f"<instruction>{instruction}</instruction>\nAnswer:")
        budget = _budget(len(selection), 1024, 4096)
    else:
        scope = "document"
        where = (f" {HERE} marks the author's cursor: when the instruction asks "
                 "to write or insert something without saying where, put it "
                 "there. Do not include the marker in your answer."
                 if HERE in doc else "")
        prompt = (f"{head}<document>\n{doc}\n</document>\n\n"
                  f"<instruction>{instruction}</instruction>\n\n"
                  "Answer with the complete revised document and nothing else." + where)
        budget = _budget(len(doc), 2048, 8192)

    try:
        raw = await llm.complete([{"role": "system", "content": SYSTEM},
                                  {"role": "user", "content": prompt}],
                                 max_tokens=budget, require_finished=True)
    except LlmTruncated:
        return _error(502, "model_truncated",
                      "the model ran out of room before finishing, so nothing was "
                      "applied — a partial rewrite would cut off the end of the "
                      "doc. Select the section to change and ask about that.")
    except LlmUnavailable as e:
        return _error(502, "llm_unavailable", str(e))
    except Exception as e:  # noqa: BLE001 - provider failures are not ours to classify
        ref = secrets.token_hex(4)
        logging.getLogger(__name__).warning("docs.assist failed [%s]: %r", ref, e)
        return _error(502, "model_failed",
                      f"the model call failed (ref {ref}) — the detail is in the "
                      "gateway log.")

    text = clean(raw or "")
    if not text:
        return _error(502, "model_empty", "the model answered with nothing")
    return {"markdown": text, "scope": scope, "model": llm.model,
            "note": "nothing was saved. The editor applies it as one undoable change."}


@router.post("/api/v1/docs.search")
async def docs_search(req: Request):
    """Doc sections matching a question, by words and by meaning."""
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    q = (body.get("q") or "").strip()
    if not q:
        return _error(422, "missing_query", "pass q", "q")
    from commonindex.gateway.sharing import keys

    async with state["pool"].acquire() as conn:
        acl_keys = await keys(req, conn)
    return await search_docs(state["pool"], state.get("embedder"), q=q,
                             space=space_of(req, body), acl_keys=acl_keys,
                             limit=max(1, min(int(body.get("limit") or 6), 20)),
                             min_similarity=MIN_SIMILARITY)


#: How close a section's meaning must be for the vector leg to return it. The
#: floor is what stops every question arriving with some doc attached.
#:
#: Measured, not guessed, on nomic-embed-text with its task prefixes: relevant
#: questions phrased in different words scored 0.58–0.63 against the section
#: that answers them, unrelated ones 0.49–0.56. The scale belongs to the model,
#: so a different model needs this re-measured — hence the variable.
MIN_SIMILARITY = float(os.environ.get("COMMONINDEX_EMBED_MIN_SIMILARITY", "0.55"))


# ── sharing and export ────────────────────────────────────────────────────


def _share_url(req: Request, token: str) -> str:
    """Where the page is served. COMMONINDEX_PUBLIC_URL wins, because behind a
    proxy the address the gateway was reached on is not the one to hand out."""
    base = (os.environ.get("COMMONINDEX_PUBLIC_URL") or str(req.base_url)).rstrip("/")
    return f"{base}/share/{token}"


async def _owned_doc(state: dict, space: str, doc_id: str):
    """The doc, when it is one. Who may act on it is `sharing.guard`'s to say,
    asked before this — so an item the caller cannot see is a 404 whether or
    not it is a doc."""
    return await state["pool"].fetchrow(
        "select id, title, props, current_rev, updated_at from objects where id = $1"
        "   and space_id = $2 and type = 'doc' and deleted_at is null", doc_id, space)


def _link(req: Request, row) -> dict[str, Any]:
    return {"url": _share_url(req, row["token"]), "token": row["token"],
            "created_by": row["created_by"], "created_at": row["created_at"].isoformat()}


@router.post("/api/v1/docs.sharing")
async def docs_sharing(req: Request):
    """The doc's live share link, or null. Anyone who can see the doc can see
    whether it is public — and should, before pasting anything into it."""
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    doc_id = (body.get("doc_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, doc_id, space, "view", "doc_id"):
        return refused
    if await _owned_doc(state, space, doc_id) is None:
        return _error(404, "unknown_doc", f"no doc {doc_id!r}", "doc_id")
    row = await state["pool"].fetchrow(
        "select token, created_by, created_at from shares"
        " where object_id = $1 and revoked_at is null", doc_id)
    return {"doc_id": doc_id, "link": _link(req, row) if row else None}


@router.post("/api/v1/docs.share")
async def docs_share(req: Request):
    """Make a link anyone can open to read this doc — the current version,
    always, like an artifact link. Sharing twice returns the same link.

    Owners only: this opens a doc to the internet, past every access rule
    `items.share` keeps, so it takes the same level as changing who has
    access."""
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    doc_id = (body.get("doc_id") or "").strip()
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key",
                      "a mutation needs an idempotency key", "idempotencyKey")
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, doc_id, space, "manage", "doc_id"):
        return refused
    if await _owned_doc(state, space, doc_id) is None:
        return _error(404, "unknown_doc", f"no doc {doc_id!r}", "doc_id")
    # 32 bytes: unguessable, and the only thing standing between the page and
    # the internet, so it is not shortened for looks.
    row = await state["pool"].fetchrow(
        "insert into shares (token, object_id, space_id, created_by) values ($1,$2,$3,$4)"
        " on conflict (object_id) where revoked_at is null do nothing"
        " returning token, created_by, created_at",
        secrets.token_urlsafe(32), doc_id, space, actor_of(req))
    if row is None:
        row = await state["pool"].fetchrow(
            "select token, created_by, created_at from shares"
            " where object_id = $1 and revoked_at is null", doc_id)
    return {"doc_id": doc_id, "link": _link(req, row)}


@router.post("/api/v1/docs.unshare")
async def docs_unshare(req: Request):
    """Turn the link off. Anyone holding it gets a 404 from now on; sharing
    again makes a new link, so the old one never comes back to life."""
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    doc_id = (body.get("doc_id") or "").strip()
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key",
                      "a mutation needs an idempotency key", "idempotencyKey")
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, doc_id, space, "manage", "doc_id"):
        return refused
    if await _owned_doc(state, space, doc_id) is None:
        return _error(404, "unknown_doc", f"no doc {doc_id!r}", "doc_id")
    n = await state["pool"].fetchval(
        "with r as (update shares set revoked_at = now() where object_id = $1"
        " and revoked_at is null returning 1) select count(*) from r", doc_id)
    return {"doc_id": doc_id, "revoked": int(n or 0)}


async def _page(conn, row, space: str, viewer: str | None) -> str:
    """The doc as a page, its embeds drawn as `viewer` may see them."""
    from commonindex.gateway.artifacts import embeds

    props = json.loads(row["props"]) if isinstance(row["props"], str) else (row["props"] or {})
    return docrender.render_page(
        title=str(props.get("title") or row["title"] or "Untitled"), body=props.get("body"),
        updated=row["updated_at"].isoformat() if row["updated_at"] else None,
        rev=row["current_rev"], embeds=await embeds(conn, props.get("body"), space, viewer))


@router.post("/api/v1/docs.export")
async def docs_export(req: Request):
    """The doc as one self-contained HTML file — no script, no external
    requests but its own images — to download, attach or host anywhere.
    Embedded artifacts are their snapshots, as the person exporting sees them."""
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    doc_id = (body.get("doc_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, doc_id, space, "view", "doc_id"):
        return refused
    row = await _owned_doc(state, space, doc_id)
    if row is None:
        return _error(404, "unknown_doc", f"no doc {doc_id!r}", "doc_id")
    name = re.sub(r"[^a-z0-9]+", "-", str(row["title"] or "doc").lower()).strip("-") or "doc"
    async with state["pool"].acquire() as conn:
        html = await _page(conn, row, space, actor_of(req))
    if body.get("for_page"):
        from commonindex.gateway.videos import forbidden

        html = docrender.for_page(html)
        # Said here, by name, rather than as the page store's bare refusal.
        if why := forbidden(html):
            return _error(422, "not_a_page", f"this doc cannot become a page: {why}", "doc_id")
    return {"doc_id": doc_id, "filename": f"{name[:60]}.html", "html": html}


_NOT_FOUND = ("<!doctype html><meta charset=utf-8><title>Not found</title>"
              "<p style='font-family:sans-serif;padding:40px'>This link does not "
              "exist or was turned off by the person who shared it.</p>")


@router.get("/share/{token}", include_in_schema=False)
async def share_page(token: str, req: Request):
    """The public page. Outside /api/v1 on purpose: the auth middleware guards
    that prefix, and this route's only credential is the token in its path.

    A revoked link, an unknown one and a deleted doc answer identically, so
    the page cannot be used to learn which links once existed.

    Embedded artifacts show as the link's maker may see them now: making the
    link was their decision to publish the doc, and what they can no longer
    see stops showing.
    """
    state = req.app.state.commonindex
    headers = {"Content-Security-Policy": docrender.CSP, "X-Robots-Tag": "noindex",
               "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
               "Cache-Control": "no-store"}
    row = None
    if re.fullmatch(r"[A-Za-z0-9_-]{20,100}", token):
        row = await state["pool"].fetchrow(
            "select o.title, o.props, o.current_rev, o.updated_at, o.space_id, s.created_by from shares s"
            " join objects o on o.id = s.object_id"
            " where s.token = $1 and s.revoked_at is null and o.deleted_at is null", token)
    if row is None:
        return HTMLResponse(_NOT_FOUND, status_code=404, headers=headers)
    async with state["pool"].acquire() as conn:
        html = await _page(conn, row, row["space_id"], row["created_by"])
    return HTMLResponse(html, headers=headers)
