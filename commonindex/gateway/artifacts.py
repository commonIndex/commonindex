"""Artifacts: a piece of HTML that runs, kept as its own item and embedded in docs.

A doc's body is a block tree with no field markup fits in (types/doc.json), and
that stays true: a doc embeds an artifact by id — `{"type": "embed", "attrs":
{"ref": "artifact-…"}}` — and the HTML lives here, on an item with its own
access, history and owner. So:

* **Sharing a doc never shares what it embeds.** A reader who may not open the
  artifact sees that something is there, not what it is. One artifact can sit
  in several docs and is changed in one place.
* **It runs where it cannot reach anything.** The app shows it in a frame
  sandboxed without same-origin, under a policy with no network at all; the
  HTML is checked against the same list videos are (`videos.forbidden`), so a
  saved artifact is self-contained by construction rather than by luck.
* **Pages that run no script get a still.** A shared doc and an export carry a
  strict no-script policy (docrender.CSP). After every save the gateway takes a
  snapshot in headless Chrome — the browser the video renderer already
  installed — behind the same no-network policy, and those pages show that.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import secrets
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.gateway.collections import replayed
from commonindex.gateway.media import media_dir, store
from commonindex.gateway.videos import _env, chrome_path, forbidden
from commonindex.workers.indexer import index_object

router = APIRouter()

MAX_HTML = 400_000
DEFAULT_HEIGHT = 420
#: The width a snapshot is taken at: a shared doc's text column.
SNAPSHOT_WIDTH = 760
SNAPSHOT_SECONDS = 30
#: Each snapshot is a Chrome process; two at a time is plenty for saves.
_SLOT = asyncio.Semaphore(2)
_TASKS: set[asyncio.Task] = set()

#: The frame's policy: its own inline style and script, data: images and
#: fonts, and nothing else — no request leaves it. The web app's frame
#: (components/HtmlFrame.tsx) uses the same one.
POLICY = ("default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; "
          "script-src 'unsafe-inline'")


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "field": field}})


def check(html: str) -> str | None:
    """Why this HTML can't be saved, or None."""
    if not html.strip():
        return "the artifact is empty"
    if len(html) > MAX_HTML:
        return f"the artifact is over {MAX_HTML // 1000} KB — keep large assets out of it"
    return forbidden(html)


#: Run last in a measuring pass: writes the page's height where --dump-dom
#: will print it, once the artifact's own script has laid it out.
_MEASURE = ("<script>addEventListener('load',()=>setTimeout(()=>{document.documentElement"
            ".setAttribute('data-snapshot-height',Math.ceil(document.documentElement"
            ".getBoundingClientRect().height))},300))</script>")


def frame_page(html: str, measure: bool = False) -> str:
    """The page an artifact runs in — in a snapshot here, in the app's frame there."""
    return ('<!doctype html><html><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{POLICY}">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            "<style>html,body{margin:0;background:#fff;color:#1b1a16;"
            "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}</style>"
            f"</head><body>{html}{_MEASURE if measure else ''}</body></html>")


def _props(raw: Any) -> dict[str, Any]:
    return json.loads(raw) if isinstance(raw, str) else dict(raw or {})


#: A whole HTML document is shown as a page — laid out at desktop size in a
#: window of that size (web/src/components/HtmlFrame.tsx, HtmlPage) — and its
#: snapshot is that window.
PAGE_SIZE = (1280, 800)


def is_page(html: str) -> bool:
    return bool(re.match(r"\s*(?:<!--.*?-->\s*)*(?:<!doctype\s+html|<html[\s>])", html, re.IGNORECASE | re.DOTALL))


def height_of(props: dict[str, Any]) -> int:
    try:
        return max(120, min(1600, int(props.get("height") or DEFAULT_HEIGHT)))
    except (TypeError, ValueError):
        return DEFAULT_HEIGHT


def snapshot_key(artifact_id: str) -> str:
    """Where an artifact's still is kept in the media store."""
    return f"artifacts/{artifact_id}.png"


# ── the browser ───────────────────────────────────────────────────────────

async def chrome() -> str | None:
    """Headless Chrome for snapshots: the same one video renders use
    (COMMONINDEX_CHROME, one on PATH, or the macOS app). None when there is none."""
    return chrome_path()


async def take_snapshot(artifact_id: str, html: str, height: int) -> dict[str, Any]:
    """A still of the artifact as it looks once its script has run. The page
    has no network by policy, and Chrome is pointed at a proxy that does not
    exist besides, so a policy bug is not a request."""
    browser = await chrome()
    if not browser:
        return {"status": "unavailable", "error": "no headless Chrome on this gateway — see docs/artifacts.md"}
    work = media_dir() / "artifacts" / f".{artifact_id}-{secrets.token_hex(4)}"
    out = work / "shot.png"
    try:
        async with _SLOT:
            work.mkdir(parents=True, exist_ok=True)
            (work / "page.html").write_text(frame_page(html))
            (work / "measure.html").write_text(frame_page(html, measure=True))
            flags = [browser, "--headless", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
                     "--no-first-run", "--disable-extensions", "--disable-background-networking",
                     "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
                     f"--user-data-dir={work / 'profile'}", "--virtual-time-budget=2000"]
            # Chrome's own sandbox cannot start as a non-root user under
            # Docker's default seccomp profile. The video image sets this: the
            # container is the sandbox there, and the page has no network
            # (the proxy above goes nowhere). Unset, Chrome sandboxes itself.
            if os.environ.get("COMMONINDEX_CHROME_NO_SANDBOX", "").strip() in ("1", "true", "yes"):
                flags.append("--no-sandbox")
            width, scale = SNAPSHOT_WIDTH, 2
            if is_page(html):
                # A page is its first screen at desktop size, as the app shows it.
                (width, height), scale = PAGE_SIZE, 1
            else:
                # The app shows an artifact as tall as its content, up to its max
                # height; the still does the same, rather than trailing blank page.
                dom = await _run(flags + [f"--window-size={width},{height}", "--dump-dom",
                                          (work / "measure.html").as_uri()], work)
                if dom is None:
                    return {"status": "failed", "error": f"the snapshot took longer than {SNAPSHOT_SECONDS} seconds"}
                if m := re.search(rb'data-snapshot-height="(\d+)"', dom):
                    height = max(60, min(height, int(m.group(1))))
            if await _run(flags + [f"--window-size={width},{height}", f"--force-device-scale-factor={scale}",
                                   f"--screenshot={out}", (work / "page.html").as_uri()], work) is None:
                return {"status": "failed", "error": f"the snapshot took longer than {SNAPSHOT_SECONDS} seconds"}
            if not out.exists():
                return {"status": "failed", "error": "headless Chrome could not draw it"}
            size = await store().put(snapshot_key(artifact_id), out, "image/png")
            return {"status": "ready", "bytes": size}
    except OSError as e:
        return {"status": "failed", "error": str(e)[:300]}
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def _run(args: list[str], work: Path) -> bytes | None:
    """One headless Chrome run: what it printed, or None when it took too long."""
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(work), env=_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), SNAPSHOT_SECONDS)
    except TimeoutError:
        proc.kill()
        return None
    return out


async def run_snapshot(pool, artifact_id: str, html: str, height: int, job: str) -> None:
    result = await take_snapshot(artifact_id, html, height)
    result = {**result, "job": job, "at": datetime.now(tz=UTC).isoformat()}
    async with pool.acquire() as conn:
        # Only if no later save has asked for a newer one.
        await conn.execute(
            "update objects set props = jsonb_set(props, '{snapshot}', $2::jsonb)"
            " where id = $1 and props->'snapshot'->>'job' = $3",
            artifact_id, json.dumps(result), job)


def _pending() -> dict[str, Any]:
    """The mark a save leaves: a snapshot is wanted, and which one."""
    return {"status": "pending", "job": secrets.token_hex(6)}


async def _start_snapshot(pool, artifact_id: str, props: dict[str, Any]) -> None:
    """Queue the snapshot `props` asks for; a worker takes it
    (commonindex/workers/jobs.py). Called once the mark is committed, so the
    result always finds it."""
    from commonindex.workers.jobs import enqueue

    async with pool.acquire() as conn:
        await enqueue(conn, "snapshot", {"artifact_id": artifact_id, "html": props.get("html") or "",
                                         "height": height_of(props), "job": props["snapshot"]["job"]},
                      key=artifact_id)


# ── routes ────────────────────────────────────────────────────────────────


def _actor(req: Request) -> str:
    from commonindex.gateway.auth import actor_of

    return actor_of(req)


async def _item(req: Request, conn, artifact_id: str | None, need: str):
    from commonindex.gateway import sharing
    from commonindex.gateway.auth import space_of

    row, refused = await sharing.require(req, conn, artifact_id or "", space_of(req, {}), need, "artifact_id")
    if refused:
        return None, None, refused
    if row["type"] != "artifact":
        return None, None, _error(404, "unknown_artifact", "no such artifact", "artifact_id")
    full = await conn.fetchrow("select props, current_rev from objects where id = $1", row["id"])
    return row, {**_props(full["props"]), "_rev": int(full["current_rev"] or 1)}, None


def _artifact_type():
    from commonindex.gateway.app import TYPES

    return next(t for t in TYPES if t.id == "artifact")


@router.post("/api/v1/artifacts.propose")
async def artifacts_propose(req: Request):
    """The generated `propose` — private to its author, indexed — with the HTML
    checked first, and a snapshot taken once it exists."""
    from commonindex.gateway.collections import make_propose

    body = await req.json()
    if body.get("html") is not None and (why := check(str(body["html"]))):
        return _error(422, "bad_html", why, "html")
    if body.get("snapshot") is not None:
        return _error(422, "governed_field", "the snapshot is the gateway's to take", "snapshot")
    got = await make_propose(_artifact_type())(req)
    if isinstance(got, dict) and got.get("created") and body.get("html"):
        pool = req.app.state.commonindex["pool"]
        props = {"html": str(body["html"]), "height": body.get("height"), "snapshot": _pending()}
        await pool.execute("update objects set props = jsonb_set(props, '{snapshot}', $2::jsonb) where id = $1",
                           got["id"], json.dumps(props["snapshot"]))
        await _start_snapshot(pool, got["id"], props)
    return got


@router.post("/api/v1/artifacts.save")
async def artifacts_save(req: Request):
    """Save an artifact's HTML, title, description or height — a new revision,
    with the whole artifact in it, so any version can be read back. A
    snapshot for script-free pages follows in the background."""
    body = await req.json()
    html = body.get("html")
    if html is not None and (why := check(str(html))):
        return _error(422, "bad_html", why, "html")
    if body.get("height") is not None:
        try:
            if not 120 <= int(body["height"]) <= 1600:
                raise ValueError
        except (TypeError, ValueError):
            return _error(422, "bad_height", "height is a whole number of pixels from 120 to 1600", "height")
    pool = req.app.state.commonindex["pool"]
    async with pool.acquire() as conn:
        row, props, refused = await _item(req, conn, body.get("artifact_id"), "edit")
        if refused:
            return refused
        at = props.pop("_rev")
        key = body.get("idempotencyKey")
        if not key:
            return _error(422, "missing_idempotency_key", "a mutation needs an idempotency key", "idempotencyKey")
        # A retry of a save that already landed: that revision, not a second one.
        if done := await replayed(conn, row["id"], key):
            return {"artifact_id": row["id"], "rev": done, "html_bytes": len(props.get("html") or ""),
                    "snapshot": (props.get("snapshot") or {}).get("status"), "replayed": True}
        if body.get("if_rev") is not None and int(body["if_rev"]) != at:
            return _error(409, "stale_revision", f"this artifact is at rev {at} and you last read rev "
                          f"{body['if_rev']} — somebody else changed it. Reload it and save again.", "if_rev")
        for field in ("html", "title", "description"):
            if body.get(field) is not None:
                props[field] = str(body[field])
        if body.get("height") is not None:
            props["height"] = int(body["height"])
        drawn = html is not None or body.get("height") is not None
        if drawn:
            props["snapshot"] = _pending()
        rev = at + 1
        async with conn.transaction():
            await conn.execute(
                "insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
                row["id"], rev, _actor(req),
                json.dumps({"props": {k: v for k, v in props.items() if k != "snapshot"}, "kind": "save",
                            "key": key}))
            await conn.execute(
                "update objects set props = $2::jsonb, title = $3, current_rev = $4, updated_at = now() where id = $1",
                row["id"], json.dumps(props), str(props.get("title") or row["title"]), rev)
            await index_object(conn, row["id"])
    if drawn:
        await _start_snapshot(pool, row["id"], props)
    return {"artifact_id": row["id"], "rev": rev, "html_bytes": len(props.get("html") or ""),
            "snapshot": props.get("snapshot", {}).get("status")}


@router.post("/api/v1/artifacts.snapshot")
async def artifacts_snapshot(req: Request):
    """The artifact's still, as a PNG — what a page that runs no script shows."""
    body = await req.json()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, props, refused = await _item(req, conn, body.get("artifact_id"), "view")
        if refused:
            return refused
    missing = _error(404, "no_snapshot", "no snapshot yet — it is taken after each save", "artifact_id")
    if (props.get("snapshot") or {}).get("status") != "ready":
        return missing
    return await store().response(snapshot_key(row["id"]), "image/png") or missing


@router.post("/api/v1/artifacts.delete")
async def artifacts_delete(req: Request):
    """Delete an artifact and its snapshot. Its owners only. Docs that embed it
    say it is gone."""
    body = await req.json()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, _, refused = await _item(req, conn, body.get("artifact_id"), "manage")
        if refused:
            return refused
        await conn.execute("update objects set deleted_at = now() where id = $1", row["id"])
        await conn.execute("delete from chunks where object_id = $1", row["id"])
    await store().delete(snapshot_key(row["id"]))
    return {"artifact_id": row["id"], "deleted": True}


# ── written by the model ──────────────────────────────────────────────────

DRAFT_SYSTEM = (
    "You write small self-contained HTML artifacts that run inside a document: charts, "
    "calculators, styled tables, timelines, small interactive demos.\n"
    "Rules:\n"
    "- Answer with the HTML fragment only: no <html>, <head> or <body>, no explanation, "
    "no code fence.\n"
    "- Everything inline: one <style>, one <script> if it needs one, inline SVG for "
    "drawings. Plain JavaScript, no libraries.\n"
    "- Never use a URL of any kind: no external scripts, stylesheets, fonts or images, no "
    "fetch, XMLHttpRequest, WebSocket, iframe, form, link or navigation. It runs with no "
    "network and anything that reaches out is refused.\n"
    "- It is shown about 700px wide; keep it readable at that width.\n"
    "- Never invent data the request does not give you; if you need sample data, label it "
    "as sample data."
)
PAGE_SYSTEM = (
    "You write complete, self-contained web pages that open as a page of their own: landing pages, "
    "one-page sites, dashboards, reports, product pages.\n"
    "Rules:\n"
    "- Answer with ONE complete HTML document: <!doctype html>, <html lang>, <head> with <meta charset> "
    "and <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">, a <title>, and <body>. "
    "No explanation, no code fence.\n"
    "- Everything inline: <style> in the head, at most one <script> at the end of the body, inline SVG for "
    "drawings and icons. Plain JavaScript, no libraries.\n"
    "- Never use a URL of any kind: no external scripts, stylesheets, fonts or images, no fetch, "
    "XMLHttpRequest, WebSocket, iframe, form or navigation. Links only to #sections on the page. It runs with "
    "no network and anything that reaches out is refused.\n"
    "- Responsive: laid out for a 1280px desktop window and readable on a 390px phone (use flex/grid and "
    "a media query). Use system fonts.\n"
    "- A real page: a clear header or nav, sections with a visual hierarchy, consistent spacing and colour.\n"
    "- Never invent facts the request does not give you; label sample data as sample data."
)
MAX_DRAFT_INSTRUCTION = 4_000


def _as_page(html: str, title: str) -> str:
    """A fragment the model returned when a page was asked for, as a page."""
    from html import escape

    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
            f"<title>{escape(title[:80] or 'Page')}</title>\n</head>\n<body>\n{html}\n</body>\n</html>")


def _strip_fence(text: str) -> str:
    m = re.fullmatch(r"\s*```[a-zA-Z]*\n(.*?)\n?```\s*", text, re.DOTALL)
    return (m.group(1) if m else text).strip()


@router.post("/api/v1/artifacts.draft")
async def artifacts_draft(req: Request):
    """Write an artifact's HTML, or change the HTML given, with the workspace's
    model — a block for inside a doc, or with `kind: "page"` a whole page.
    Returns HTML that passed the same check a save does; saves nothing."""
    body = await req.json()
    instruction = str(body.get("instruction") or "").strip()
    current = str(body.get("html") or "")
    kind = body.get("kind") or ("page" if is_page(current) else "block")
    if kind not in ("block", "page"):
        return _error(422, "bad_kind", "kind is block or page", "kind")
    if not instruction:
        return _error(422, "no_instruction", "say what the artifact should be or what to change", "instruction")
    if len(instruction) > MAX_DRAFT_INSTRUCTION:
        return _error(422, "too_long", f"the instruction is over {MAX_DRAFT_INSTRUCTION} characters", "instruction")
    if len(current) > MAX_HTML:
        return _error(422, "too_long", f"the HTML is over {MAX_HTML // 1000} KB", "html")
    llm = req.app.state.commonindex.get("llm")
    if llm is None:
        return _error(503, "llm_unconfigured",
                      "no model is configured for this workspace. Set COMMONINDEX_LLM_BASE_URL and "
                      "COMMONINDEX_LLM_MODEL on the gateway to write artifacts with AI.")
    prompt = (f"<current>\n{current}\n</current>\n<instruction>{instruction}</instruction>\n"
              "Answer with the complete revised HTML." if current.strip() else
              f"<instruction>{instruction}</instruction>\nAnswer with the HTML.")
    from commonindex.gateway.llm import LlmTruncated, LlmUnavailable

    try:
        raw = await llm.complete([{"role": "system", "content": PAGE_SYSTEM if kind == "page" else DRAFT_SYSTEM},
                                  {"role": "user", "content": prompt}],
                                 max_tokens=8192, require_finished=True)
    except LlmTruncated:
        return _error(502, "model_truncated", "the model ran out of room before finishing — ask for something smaller")
    except LlmUnavailable as e:
        return _error(502, "llm_unavailable", str(e))
    except Exception as e:  # noqa: BLE001 - provider failures are not ours to classify
        ref = secrets.token_hex(4)
        logging.getLogger(__name__).warning("artifacts.draft failed [%s]: %r", ref, e)
        return _error(502, "model_failed", f"the model call failed (ref {ref}) — the detail is in the gateway log.")
    html = _strip_fence(raw or "")
    # Asked for a page, a small model sometimes writes only the body: it is
    # wrapped rather than refused, so what comes back is always a page.
    if kind == "page" and html and not is_page(html):
        html = _as_page(html, instruction)
    if why := check(html):
        return _error(422, "bad_html", f"the model wrote HTML that can't be used: {why}. Ask again, or edit it.")
    return {"html": html, "kind": kind, "model": llm.model, "note": "nothing was saved"}


# ── for docs ──────────────────────────────────────────────────────────────

#: The most embeds one shared page or export draws; past this, a link each.
MAX_DRAWN = 24


def refs(tree: Any) -> list[str]:
    """The artifact ids a doc body embeds, in order, once each."""
    out: list[str] = []

    def walk(node: Any) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "embed":
            ref = str((node.get("attrs") or {}).get("ref") or "")
            if ref and ref not in out:
                out.append(ref)
        for child in node.get("content") or []:
            walk(child)

    walk(tree)
    return out


async def embeds(conn, tree: Any, space: str, viewer: str | None) -> dict[str, dict[str, Any] | None]:
    """What a script-free page may show for each embed, as `viewer` may see
    it: its title, its still as a data: URI, and where to open it live — or
    None, which the page draws as "not shared with you". With no viewer
    (a link whose maker is gone) nothing is shown."""
    from commonindex.gateway import sharing
    from commonindex.gateway.signin import public_url

    out: dict[str, dict[str, Any] | None] = {}
    for n, ref in enumerate(refs(tree)):
        row = await sharing.item(conn, ref, space)
        if viewer is None or row is None or row["type"] != "artifact" or \
                await sharing.level(conn, viewer, space, row) == "none":
            out[ref] = None
            continue
        props = _props(await conn.fetchval("select props from objects where id = $1", ref))
        image = None
        if n < MAX_DRAWN and (props.get("snapshot") or {}).get("status") == "ready" and \
                (png := await store().read(snapshot_key(ref))):
            image = "data:image/png;base64," + base64.b64encode(png).decode()
        out[ref] = {"title": str(row["title"] or "Artifact"), "image": image,
                    "url": f"{public_url()}/artifacts/{ref}"}
    return out
