"""Videos, against a real database and a stand-in renderer.

A video is a composition written as code and the file rendered from it.
Defended: a composition must be self-contained (no way out of the page, no
GSAP) before it is saved or rendered; a new video is its creator's and starts
a draft; saving needs edit; a render records its outcome — ready with a file,
or failed with the reason — and a newer render owns the record; a gateway
without ffmpeg says so instead of failing late; the file goes only to people
who can see the video.
"""

from __future__ import annotations

import json
import stat

import pytest
from test_sharing import _doc_type, _PoolOf, _Req, call, db  # noqa: F401 - the fixture, reused

asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.integration

GOOD = """<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="3">
  <section class="clip" data-start="0" data-duration="3"><h1 class="t">Hello</h1>
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4" /></svg></section>
  <style>.t { animation: rise 600ms both; } @keyframes rise { from { opacity: 0 } to { opacity: 1 } }</style>
</div>"""


def _video_type():
    from commonindex.gateway.app import TYPES

    return next(t for t in TYPES if t.id == "video")


async def new_video(db, actor="maya", **props):  # noqa: F811
    from commonindex.gateway.collections import make_propose

    status, out = await call(db, make_propose(_video_type()), actor, title="Launch", brief="20s launch", **props)
    return status, out


# ── what a composition may be ───────────────────────────────────────────


@pytest.mark.parametrize("bad, why", [
    ('<img src="https://evil.test/x.png">', "URL"),
    ('<img src="//evil.test/x.png">', "protocol-relative"),
    ('<script src="app.js"></script>', "external script"),
    ("<script>fetch('/api')</script>", "network request"),
    ("<script>new WebSocket('x')</script>", "network request"),
    ("<iframe srcdoc='x'></iframe>", "iframe"),
    ("<style>@import 'x.css';</style>", "@import"),
    ("<script>window.location = 'x'</script>", "navigation"),
    ("<script>gsap.to('.t', {x: 1})</script>", "GSAP"),
])
def test_a_composition_stays_inside_its_page(bad, why):
    from commonindex.gateway.videos import check

    assert check(GOOD) is None                                   # inline SVG's namespace is no URL
    assert why in (check(GOOD.replace("<h1", bad + "<h1")) or "")


@pytest.mark.parametrize("media", [
    '<audio src="data:audio/mpeg;base64,SUQz"></audio>',
    '<video autoplay muted></video>',
    '<VIDEO><source src="data:video/mp4;base64,AAAA"></VIDEO>',
    "<div style=\"background:url('data:video/webm;base64,GkXf')\"></div>",
])
def test_a_composition_carries_no_media_for_ffmpeg_to_decode(media):
    """The renderer hands a composition's audio and video to ffmpeg; a crafted
    file there would be decoded on the worker. Text and CSS only."""
    from commonindex.gateway.videos import check

    assert "audio or video" in (check(GOOD.replace("<h1", media + "<h1")) or "")


def test_a_composition_follows_the_contract():
    from commonindex.gateway.videos import check

    assert "data-composition-id" in check("<div>hi</div>")
    assert "over" in check("<div data-composition-id='m'>" + "x" * 500_000 + "</div>")


# ── the collection ──────────────────────────────────────────────────────


async def test_a_new_video_is_its_creators_draft(db):  # noqa: F811
    from commonindex.gateway.collections import make_list

    status, out = await new_video(db)
    assert status == 200
    _, mine = await call(db, make_list(_video_type()), "maya")
    _, theirs = await call(db, make_list(_video_type()), "rhea")
    assert [v["id"] for v in mine["videos"]] == [out["id"]] and theirs["videos"] == []
    status, claimed = await new_video(db, state="ready")             # a render is the gateway's to report
    assert (status, claimed["error"]["code"]) == (422, "governed_field")


async def test_saving_needs_edit_and_makes_a_draft(db):  # noqa: F811
    from commonindex.gateway.videos import videos_save

    _, out = await new_video(db)
    status, refused = await call(db, videos_save, "rhea", video_id=out["id"], composition=GOOD)
    assert (status, refused["error"]["code"]) == (404, "unknown_item")   # not hers to see
    status, bad = await call(db, videos_save, "maya", video_id=out["id"], composition="<div>no root</div>")
    assert (status, bad["error"]["code"]) == (422, "bad_composition")
    status, saved = await call(db, videos_save, "maya", video_id=out["id"], composition=GOOD, format="square")
    assert status == 200 and saved["state"] == "draft"
    props = json.loads(await db.fetchval("select props from objects where id = $1", out["id"]))
    assert (props["composition"], props["format"]) == (GOOD, "square")
    delta = json.loads(await db.fetchval("select delta from revisions where object_id = $1 order by rev desc limit 1",
                                         out["id"]))
    assert "composition" not in delta["props"]                        # history holds what changed, not the HTML


# ── rendering ───────────────────────────────────────────────────────────


@pytest.fixture
def renderer(tmp_path, monkeypatch):
    """A stand-in for the renderer: writes the output file, or fails, as told."""
    from commonindex.gateway import videos

    script = tmp_path / "fake-renderer"
    script.write_text("#!/bin/sh\n"
                      "if [ -f FAIL ] || grep -q fail-me index.html; then echo 'Chrome crashed at frame 12' >&2; exit 3; fi\n"
                      'while [ "$1" != "--output" ]; do shift; done; printf video > "$2"\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(videos, "RENDERER", script)
    monkeypatch.setattr(videos, "tools", lambda: {"renderer": True, "ffmpeg": True, "ready": True,
                                                   "formats": ["mp4", "webm"]})
    monkeypatch.setenv("COMMONINDEX_MEDIA_DIR", str(tmp_path / "media"))
    return tmp_path


async def _render(db, video_id, fmt="mp4"):  # noqa: F811
    from commonindex.gateway import videos

    status, out = await call(db, videos.videos_render, "maya", video_id=video_id, format=fmt)
    # Renders are queued for a worker; run what is queued.
    from commonindex.workers.jobs import drain

    await drain(_PoolOf(db))
    return status, out, json.loads(await db.fetchval("select props from objects where id = $1", video_id))


async def test_a_render_becomes_a_file_and_says_so(db, renderer):  # noqa: F811
    from commonindex.gateway.videos import videos_file, videos_save

    _, out = await new_video(db)
    status, _ = await call(db, videos_file, "maya", video_id=out["id"])
    assert status == 404                                              # nothing rendered yet
    await call(db, videos_save, "maya", video_id=out["id"], composition=GOOD)
    status, started, props = await _render(db, out["id"], "webm")
    assert status == 200 and started["state"] == "rendering"
    assert (props["state"], props["render"]["status"], props["render"]["format"]) == ("ready", "ready", "webm")
    assert (renderer / "media" / "videos" / f"{out['id']}.webm").read_bytes() == b"video"
    status, info = await call(db, videos_file, "maya", video_id=out["id"])
    assert status == 200 and info["format"] == "webm" and info["bytes"] == 5
    status, _ = await call(db, videos_file, "rhea", video_id=out["id"])
    assert status == 404                                              # only for those who can see it


async def test_a_failed_render_says_why(db, renderer):  # noqa: F811
    from commonindex.gateway.videos import videos_save

    _, out = await new_video(db)
    await call(db, videos_save, "maya", video_id=out["id"], composition=GOOD.replace("Hello", "fail-me"))
    _, _, props = await _render(db, out["id"])
    assert props["state"] == "failed" and "Chrome crashed" in props["render"]["error"]


async def test_a_gateway_without_ffmpeg_says_so(db, monkeypatch):  # noqa: F811
    from commonindex.gateway import videos

    monkeypatch.setattr(videos, "tools", lambda: {"renderer": True, "ffmpeg": False, "ready": False,
                                                   "formats": ["mp4", "webm"]})
    _, out = await new_video(db)
    status, refused = await call(db, videos.videos_render, "maya", video_id=out["id"])
    assert status == 503 and "ffmpeg" in refused["error"]["message"]


async def test_a_newer_render_owns_the_record(db, renderer):  # noqa: F811
    from commonindex.gateway.videos import run_render, videos_save

    _, out = await new_video(db)
    await call(db, videos_save, "maya", video_id=out["id"], composition=GOOD)
    props = json.loads(await db.fetchval("select props from objects where id = $1", out["id"]))
    props.update(state="rendering", render={"status": "rendering", "format": "mp4", "job": "newer"})
    await db.execute("update objects set props = $2::jsonb where id = $1", out["id"], json.dumps(props))
    await run_render(_PoolOf(db), out["id"], GOOD, "mp4", "maya", job="older")
    after = json.loads(await db.fetchval("select props from objects where id = $1", out["id"]))
    assert after["render"]["job"] == "newer" and after["state"] == "rendering"


def test_the_renderer_is_ours_and_is_told_where_chrome_is(tmp_path, monkeypatch):
    """render/render.mjs, with the composition, the output, the format, the
    browser, and no sandbox only where the image says the container is it."""
    from commonindex.gateway import videos

    chrome = tmp_path / "chromium"
    chrome.write_text("")
    monkeypatch.setenv("COMMONINDEX_CHROME", str(chrome))
    monkeypatch.delenv("COMMONINDEX_CHROME_NO_SANDBOX", raising=False)
    cmd = videos._command(tmp_path, tmp_path / "video.mp4", "mp4")
    assert cmd[0].endswith("render/render.mjs")
    assert cmd[1:] == ["--input", str(tmp_path / "index.html"), "--output", str(tmp_path / "video.mp4"),
                       "--format", "mp4", "--chrome", str(chrome)]
    monkeypatch.setenv("COMMONINDEX_CHROME_NO_SANDBOX", "1")
    assert videos._command(tmp_path, tmp_path / "v.webm", "webm")[-1] == "--no-sandbox"


def test_without_a_browser_rendering_is_not_offered(monkeypatch):
    from commonindex.gateway import videos

    monkeypatch.setattr(videos, "chrome_path", lambda: None)
    assert videos.tools()["renderer"] is False and videos.tools()["ready"] is False


def test_the_renderer_carries_no_animation_library():
    """It used to be a package that bundled GSAP; now it is one file and one
    browser driver, and neither may bring one back."""
    import json
    from pathlib import Path

    render = Path(__file__).resolve().parent.parent / "render"
    assert json.loads((render / "package.json").read_text())["dependencies"] == {"playwright-core": "1.64.1"}
    assert "gsap" not in (render / "render.mjs").read_text().lower()


def test_a_composition_renders_to_a_video_of_its_length(tmp_path):
    """The real renderer, end to end, where this machine can run it."""
    import shutil
    import subprocess

    from commonindex.gateway import videos

    if not (videos.RENDER_DEPS.exists() and shutil.which("node") and shutil.which("ffmpeg") and videos.chrome_path()):
        pytest.skip("needs render/node_modules, node, ffmpeg and a Chrome")
    composition = ('<div data-composition-id="t" data-width="320" data-height="180" data-duration="2">'
                   '<style>@keyframes in{from{opacity:0}to{opacity:1}}h1{animation:in 1s both}</style>'
                   '<div class="clip" data-start="0" data-duration="2"><h1>Hi</h1></div></div>')
    videos._project(tmp_path, composition)
    out = tmp_path / "video.mp4"
    done = subprocess.run(videos._command(tmp_path, out, "mp4"), env=videos._env(), capture_output=True,
                          text=True, timeout=180, check=False)
    assert done.returncode == 0, done.stderr
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height:format=duration",
                            "-of", "csv=p=0", str(out)], capture_output=True, text=True, check=True).stdout.split()
    assert probe[0].rstrip(",") == "320,180" and abs(float(probe[1]) - 2.0) < 0.1
    # Standard range: the frames are full-range JPEGs, and a file tagged
    # yuvj420p is one some players show with washed-out or crushed colours.
    pix = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=pix_fmt,color_range",
                          "-of", "csv=p=0", str(out)], capture_output=True, text=True, check=True).stdout.strip().rstrip(",")
    assert pix == "yuv420p,tv", pix


async def test_a_render_leaves_a_still_for_the_gallery(db, renderer, monkeypatch):  # noqa: F811
    from commonindex.gateway import videos

    async def still(video, seconds):
        video.with_suffix(".jpg").write_bytes(b"jpeg")
        return True

    monkeypatch.setattr(videos, "_poster", still)
    _, out = await new_video(db)
    await call(db, videos.videos_save, "maya", video_id=out["id"], composition=GOOD)
    _, _, props = await _render(db, out["id"])
    assert props["render"]["poster"] is True
    req = _Req({"video_id": out["id"], "poster": True}, db, "maya")
    response = await videos.videos_file(req)
    assert response.media_type == "image/jpeg"


async def test_only_its_owners_delete_a_video(db, renderer):  # noqa: F811
    from commonindex.gateway.collections import make_list
    from commonindex.gateway.sharing import items_set_visibility
    from commonindex.gateway.videos import videos_delete

    _, out = await new_video(db)
    await call(db, items_set_visibility, "maya", id=out["id"], visibility="workspace", role="edit")
    status, refused = await call(db, videos_delete, "rhea", video_id=out["id"])
    assert (status, refused["error"]["code"]) == (403, "not_allowed")        # can edit, not delete
    status, _ = await call(db, videos_delete, "maya", video_id=out["id"])
    _, listed = await call(db, make_list(_video_type()), "maya")
    assert status == 200 and listed["videos"] == []


async def test_a_render_kept_in_a_bucket_is_served_from_it(db, renderer, monkeypatch):  # noqa: F811
    """With COMMONINDEX_MEDIA_STORE=s3 the finished file goes to the bucket, no
    copy stays on this machine, and the download is read back from the bucket."""
    from test_media_store import FakeS3, _body
    from test_sharing import _Req

    from commonindex.gateway import media
    from commonindex.gateway.videos import videos_delete, videos_file, videos_save

    fake = FakeS3()
    monkeypatch.setenv("COMMONINDEX_MEDIA_STORE", "s3")
    monkeypatch.setattr(media, "_s3", lambda *_: media.S3Store(fake, "media-bucket", "ci"))
    _, out = await new_video(db)
    await call(db, videos_save, "maya", video_id=out["id"], composition=GOOD)
    _, _, props = await _render(db, out["id"], "mp4")
    assert props["state"] == "ready" and props["render"]["bytes"] == 5
    assert fake.objects[("media-bucket", f"ci/videos/{out['id']}.mp4")] == (b"video", "video/mp4")
    assert not (renderer / "media" / "videos" / f"{out['id']}.mp4").exists()
    resp = await videos_file(_Req({"video_id": out["id"], "download": True}, db, "maya"))
    assert await _body(resp) == b"video"
    await call(db, videos_delete, "maya", video_id=out["id"])
    assert not fake.objects
