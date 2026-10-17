"""Videos: a composition an agent writes as code, rendered to a file.

A video is one composition — HTML whose scenes carry their own
timing, animated with CSS keyframes or the Web Animations API — and the file
the renderer made from it. An agent (over MCP, or a person's) writes the
composition from a brief and saves it with `videos.save`; `videos.render`
turns it into an MP4 or WebM in the background; `videos.file` hands it back.

Three decisions, each written down because each was a question:

* **What a composition may contain.** It is rendered by a headless browser on
  the gateway's machine, so it is untrusted code with a network next to it.
  It must be self-contained: no URL with a scheme, no protocol-relative
  reference, no external script, frame or object, and none of the browser's
  ways of making a request. A denylist is not a sandbox; the render also runs
  with an empty environment, one at a time, under a time limit. A deployment
  The renderer's browser is offline and refuses every request, too.
* **No GSAP.** The popular animation library is free but not open source,
  and its license forbids tools that let people build animations without
  code. CSS keyframes and the Web Animations API are the browser's own, and
  our renderer (render/render.mjs) seeks both exactly as the editor's preview
  does; it carries no animation library of its own.
* **ffmpeg is not ours to ship.** The renderer calls it as a separate
  program; the deployment installs it (docs/videos.md). Encoding to WebM
  (VP9/Opus) is royalty-free; MP4 (H.264/AAC) is offered for reach.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.gateway.media import media_dir, store
from commonindex.workers.indexer import index_object

router = APIRouter()

ROOT = Path(__file__).resolve().parent.parent.parent
#: Our renderer (render/render.mjs): Chromium through playwright-core, frames to ffmpeg.
RENDERER = ROOT / "render" / "render.mjs"
RENDER_DEPS = ROOT / "render" / "node_modules" / "playwright-core"
#: Where a headless Chromium usually is, after COMMONINDEX_CHROME.
CHROME_NAMES = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome")
CHROME_APPS = ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
               "/Applications/Chromium.app/Contents/MacOS/Chromium")
FORMATS = {"mp4": "video/mp4", "webm": "video/webm"}
SIZES = {"landscape": (1920, 1080), "portrait": (1080, 1920), "square": (1080, 1080)}
MAX_COMPOSITION = 400_000
RENDER_SECONDS = 600
#: One render at a time per gateway: each is several Chrome processes.
_SLOT = asyncio.Semaphore(1)
_TASKS: set[asyncio.Task] = set()

#: What a composition may not contain. Each is a way out of the page.
_FORBIDDEN = [
    (re.compile(r"\b(?:https?|wss?|ftp|file|blob)\s*:", re.IGNORECASE), "a URL — it must be self-contained"),
    (re.compile(r"""(?:src|href|action|poster|srcset)\s*=\s*["']?\s*//""", re.IGNORECASE), "a protocol-relative URL"),
    (re.compile(r"""url\(\s*["']?\s*//""", re.IGNORECASE), "a protocol-relative URL in CSS"),
    (re.compile(r"@import", re.IGNORECASE), "a CSS @import"),
    (re.compile(r"<\s*(?:iframe|frame|object|embed|link|base|portal|form)\b", re.IGNORECASE), "an iframe, object, link or form"),
    (re.compile(r"<\s*meta\b[^>]*http-equiv", re.IGNORECASE), "a meta refresh"),
    (re.compile(r"<\s*script\b[^>]*\bsrc\s*=", re.IGNORECASE), "an external script"),
    (re.compile(r"\b(?:fetch|importScripts|sendBeacon)\s*\(|\bimport\s*\(|XMLHttpRequest|WebSocket|EventSource"
                r"|RTCPeerConnection|\bWorker\s*\(", re.IGNORECASE), "a network request from script"),
    (re.compile(r"\b(?:window|document|self|top|parent)\s*\.\s*(?:location|open)\b|\blocation\s*\.\s*(?:href|assign|replace)",
                re.IGNORECASE), "navigation from script"),
    (re.compile(r"\bgsap\b", re.IGNORECASE), "GSAP — animate with CSS keyframes or the Web Animations API"),
]


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "field": field}})




#: Media a composition may not carry. The renderer hands any audio or video in
#: it to ffmpeg to decode, and ffmpeg's decoders are a long-standing source of
#: memory-safety bugs: a member could otherwise feed it a crafted file, embedded
#: as a data: URI, and run code as the worker. Videos here are CSS and text.
_MEDIA = re.compile(r"<\s*(?:audio|video|source|track)\b|data:\s*(?:audio|video)/", re.IGNORECASE)


def check(composition: str) -> str | None:
    """Why this composition can't be saved, or None."""
    if not composition.strip():
        return "the composition is empty"
    if len(composition) > MAX_COMPOSITION:
        return f"the composition is over {MAX_COMPOSITION // 1000} KB — keep assets out of it"
    if "data-composition-id" not in composition:
        return "the root element needs data-composition-id (the composition contract)"
    if _MEDIA.search(composition):
        return "it contains audio or video — compositions are animated HTML and CSS, without media files"
    return forbidden(composition)


def forbidden(html: str) -> str | None:
    """Why this HTML reaches outside itself, or None. Shared with artifacts:
    anything the workspace runs in a frame is held to the same list."""
    # Inline SVG names its namespace with a URL that is never fetched.
    text = re.sub(r"(?i)https?://www\.w3\.org/[\w/.#-]*", "", html)
    for pattern, what in _FORBIDDEN:
        if pattern.search(text):
            return f"it contains {what}"
    return None


def chrome_path() -> str | None:
    """A headless Chromium: COMMONINDEX_CHROME, else one on PATH, else the
    macOS app. Shared with artifact snapshots."""
    named = os.environ.get("COMMONINDEX_CHROME", "").strip()
    if named:
        return named if Path(named).exists() else None
    for name in CHROME_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return next((app for app in CHROME_APPS if Path(app).exists()), None)


def tools() -> dict[str, Any]:
    """What rendering needs on this machine, and whether it is there."""
    ffmpeg = shutil.which("ffmpeg")
    renderer = RENDERER.exists() and RENDER_DEPS.exists() and bool(shutil.which("node")) and bool(chrome_path())
    return {"renderer": renderer, "ffmpeg": bool(ffmpeg),
            "ready": renderer and bool(ffmpeg), "formats": list(FORMATS)}


async def _item(req: Request, conn, video_id: str | None, need: str):
    from commonindex.gateway import sharing
    from commonindex.gateway.auth import space_of

    space = space_of(req, {})
    row, refused = await sharing.require(req, conn, video_id or "", space, need, "video_id")
    if refused:
        return None, None, refused
    if row["type"] != "video":
        return None, None, _error(404, "unknown_video", "no such video", "video_id")
    props = await conn.fetchval("select props from objects where id = $1", row["id"])
    return row, (json.loads(props) if isinstance(props, str) else dict(props or {})), None


async def _write(conn, object_id: str, props: dict, actor: str, kind: str, title: str | None = None) -> None:
    rev = await conn.fetchval("select coalesce(max(rev), 0) + 1 from revisions where object_id = $1", object_id)
    await conn.execute("update objects set props = $2::jsonb, title = coalesce($3, title), updated_at = now()"
                       " where id = $1", object_id, json.dumps(props), title)
    await conn.execute("insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
                       object_id, rev, actor, json.dumps({"props": {k: v for k, v in props.items()
                                                                    if k != "composition"}, "kind": kind}))


def _actor(req: Request) -> str:
    from commonindex.gateway.auth import actor_of

    return actor_of(req)


@router.post("/api/v1/videos.save")
async def videos_save(req: Request):
    """Save a video's composition (and, optionally, its brief or format). It
    becomes a draft again: the last render no longer matches it."""
    body = await req.json()
    composition = body.get("composition")
    if composition is not None and (why := check(str(composition))):
        return _error(422, "bad_composition", why, "composition")
    if body.get("format") is not None and body["format"] not in SIZES:
        return _error(422, "bad_format", "format is landscape, portrait or square", "format")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, props, refused = await _item(req, conn, body.get("video_id"), "edit")
        if refused:
            return refused
        if props.get("state") == "rendering":
            return _error(409, "rendering", "it is rendering — save again when it finishes", "video_id")
        for field in ("composition", "brief", "format"):
            if body.get(field) is not None:
                props[field] = str(body[field])
        props["state"] = "draft"
        async with conn.transaction():
            await _write(conn, row["id"], props, _actor(req), "save", str(body["title"]) if body.get("title") else None)
            await index_object(conn, row["id"])
    return {"video_id": row["id"], "state": "draft", "composition_bytes": len(props.get("composition") or "")}


@router.post("/api/v1/videos.tools")
async def videos_tools(req: Request):
    """Whether this gateway can render, and what it would need to."""
    state = req.app.state.commonindex
    ai_configured = bool(state.get("llm") or state.get("generate") or (
        os.environ.get("COMMONINDEX_MODEL_PROVIDER", "").strip().lower() == "anthropic"
        and os.environ.get("COMMONINDEX_MODEL_API_KEY", "").strip()))
    return {**tools(), "install": "docs/videos.md", "ai_configured": ai_configured}


def _project(folder: Path, composition: str) -> None:
    """The composition, in a folder of its own for one render."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "index.html").write_text(composition)


def _command(folder: Path, out: Path, fmt: str) -> list[str]:
    """The renderer's command line. Chrome's sandbox cannot start as a
    non-root user under Docker's default seccomp profile; the video image sets
    COMMONINDEX_CHROME_NO_SANDBOX, and the page has no network either way."""
    cmd = [str(RENDERER), "--input", str(folder / "index.html"), "--output", str(out), "--format", fmt]
    browser = chrome_path()
    if browser:
        cmd += ["--chrome", browser]
    if os.environ.get("COMMONINDEX_CHROME_NO_SANDBOX", "").strip() in ("1", "true", "yes"):
        cmd.append("--no-sandbox")
    return cmd


def _env() -> dict[str, str]:
    """Nothing of the gateway's: no keys, no database, no tokens."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp"),
            "LANG": "C.UTF-8"}


async def _seconds(path: Path) -> float | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=_env())
        out, _ = await asyncio.wait_for(proc.communicate(), 20)
        return round(float(out.decode().strip()), 2)
    except (OSError, ValueError, TimeoutError):
        return None


async def _poster(video: Path, seconds: float | None) -> bool:
    """A still from the rendered file for the gallery: a frame two fifths in,
    where a launch video has usually said what it is about — and a little
    past that, since a round fraction of a round length is often a cut."""
    length = seconds or 0
    at = f"{min(length * 0.4 + 0.7, max(length - 0.1, 0)):.2f}"
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-y", "-ss", at, "-i", str(video), "-frames:v", "1",
            "-vf", "scale=720:-2", "-q:v", "4", str(video.with_suffix(".jpg")),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, env=_env())
        await asyncio.wait_for(proc.communicate(), 30)
        return proc.returncode == 0 and video.with_suffix(".jpg").exists()
    except (OSError, TimeoutError):
        return False


async def run_render(pool, video_id: str, composition: str, fmt: str, actor: str, job: str) -> None:
    """Render one composition in the background and record how it went."""
    work = media_dir() / "videos" / video_id / job
    out = work / f"video.{fmt}"
    result: dict[str, Any]
    async with _SLOT:
        try:
            _project(work, composition)
            proc = await asyncio.create_subprocess_exec(
                *_command(work, out, fmt), cwd=str(work), env=_env(),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            try:
                logged, _ = await asyncio.wait_for(proc.communicate(), RENDER_SECONDS)
            except TimeoutError:
                proc.kill()
                logged = b"the render took longer than %d seconds and was stopped" % RENDER_SECONDS
            if proc.returncode == 0 and out.exists():
                # Measured and posterised here, on the working copy; then the
                # file and its still move to the store (a folder or a bucket).
                length = await _seconds(out)
                poster = await _poster(out, length)
                size = await store().put(f"videos/{video_id}.{fmt}", out, FORMATS[fmt])
                if poster:
                    await store().put(f"videos/{video_id}.jpg", out.with_suffix(".jpg"), "image/jpeg")
                result = {"status": "ready", "format": fmt, "bytes": size, "seconds": length, "poster": poster}
            else:
                text = re.sub(r"\x1b\[[0-9;]*m", "", logged.decode(errors="replace"))
                result = {"status": "failed", "format": fmt, "error": text.strip()[-800:] or "the renderer failed"}
        except Exception as e:  # noqa: BLE001 - whatever happened, the video says so
            result = {"status": "failed", "format": fmt, "error": str(e)[:800]}
        finally:
            shutil.rmtree(work, ignore_errors=True)
            try:
                work.parent.rmdir()   # the video's working folder, once no render is using it
            except OSError:
                pass
    async with pool.acquire() as conn:
        props = await conn.fetchval("select props from objects where id = $1", video_id)
        props = json.loads(props) if isinstance(props, str) else dict(props or {})
        if (props.get("render") or {}).get("job") != job:
            return   # a newer render owns the record now
        props["render"] = {**props["render"], **result, "finished_at": datetime.now(tz=UTC).isoformat()}
        props["state"] = "ready" if result["status"] == "ready" else "failed"
        await _write(conn, video_id, props, actor, "rendered" if result["status"] == "ready" else "render_failed")


@router.post("/api/v1/videos.render")
async def videos_render(req: Request):
    """Render the saved composition to a file, in the background. videos.get
    says when it is done; videos.file hands it over."""
    body = await req.json()
    fmt = body.get("format") or "mp4"
    if fmt not in FORMATS:
        return _error(422, "bad_format", "format is mp4 or webm", "format")
    have = tools()
    if not have["ready"]:
        missing = [name for name in ("renderer", "ffmpeg") if not have[name]]
        return _error(503, "cannot_render", f"this gateway can't render: {', '.join(missing)} not installed "
                                             "— see docs/videos.md")
    pool = req.app.state.commonindex["pool"]
    async with pool.acquire() as conn:
        row, props, refused = await _item(req, conn, body.get("video_id"), "edit")
        if refused:
            return refused
        composition = props.get("composition") or ""
        if not composition:
            return _error(409, "no_composition", "save a composition first (videos.save)", "video_id")
        if why := check(composition):
            return _error(422, "bad_composition", why, "video_id")
        started = (props.get("render") or {}).get("started_at")
        if props.get("state") == "rendering" and started and \
                time.time() - datetime.fromisoformat(started).timestamp() < RENDER_SECONDS + 60:
            return {"video_id": row["id"], "state": "rendering", "already": True}
        job = secrets.token_hex(6)
        props["state"] = "rendering"
        props["render"] = {"status": "rendering", "format": fmt, "job": job,
                           "started_at": datetime.now(tz=UTC).isoformat(), "by": _actor(req)}
        async with conn.transaction():
            await _write(conn, row["id"], props, _actor(req), "render")
            # Rendered by a worker, not in this request's process
            # (commonindex/workers/jobs.py): a restart no longer loses it.
            from commonindex.workers.jobs import enqueue

            await enqueue(conn, "render", {"video_id": row["id"], "composition": composition, "format": fmt,
                                           "actor": _actor(req), "job": job}, key=row["id"])
    return {"video_id": row["id"], "state": "rendering", "format": fmt}


@router.post("/api/v1/videos.file")
async def videos_file(req: Request):
    """The rendered file: its details, or with `download: true` the file itself."""
    body = await req.json()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, props, refused = await _item(req, conn, body.get("video_id"), "view")
        if refused:
            return refused
    render = props.get("render") or {}
    fmt = render.get("format")
    key = f"videos/{row['id']}.{fmt}" if fmt in FORMATS else None
    not_rendered = _error(404, "not_rendered", "no rendered file yet — videos.render makes one", "video_id")
    if props.get("state") != "ready" or key is None:
        return not_rendered
    if body.get("poster") is True:
        still = await store().response(f"videos/{row['id']}.jpg", "image/jpeg")
        return still or _error(404, "no_poster", "no still for this video yet — render it again", "video_id")
    if body.get("download") is True:
        out = await store().response(key, FORMATS[fmt], filename=f"{row['key'] or row['id']}.{fmt}")
        return out or not_rendered
    if not await store().exists(key):
        return not_rendered
    return {"video_id": row["id"], "format": fmt, "bytes": render.get("bytes"), "seconds": render.get("seconds"),
            "download": "POST videos.file with download: true"}


@router.post("/api/v1/videos.delete")
async def videos_delete(req: Request):
    """Delete a video, and its rendered files. Its owners'."""
    body = await req.json()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row, _, refused = await _item(req, conn, body.get("video_id"), "manage")
        if refused:
            return refused
        await conn.execute("update objects set deleted_at = now() where id = $1", row["id"])
        await conn.execute("delete from chunks where object_id = $1", row["id"])
    for ext in (*FORMATS, "jpg"):
        await store().delete(f"videos/{row['id']}.{ext}")
    return {"video_id": row["id"], "deleted": True}
