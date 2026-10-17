"""The video verbs. `videos.list`, `videos.get` and `videos.propose` are the
type's own (types/video.json); these write, render and fetch."""

from __future__ import annotations

from commonindex.core.ops import Op, Registry

_KEY = {"idempotencyKey": {"type": "string"}, "space_id": {"type": "string"}}

COMPOSITION_GUIDE = (
    "A composition is one HTML document: a root <div data-composition-id=\"main\" "
    "data-width=\"1920\" data-height=\"1080\" data-duration=\"<seconds>\">, and inside it timed scenes "
    "<section class=\"clip\" data-start=\"<s>\" data-duration=\"<s>\">. Animate with CSS @keyframes "
    "(finite duration, animation-fill-mode: both, timed from each clip's own start) or the Web Animations "
    "API. Self-contained: no URLs, external scripts, iframes, links, fetch or GSAP — it is refused otherwise. "
    "Inline SVG and data: images are fine."
)


def register(reg: Registry) -> None:
    reg.register(Op(
        name="videos.assist",
        relation="read",
        description="Suggest video edits with the configured model. Requires item edit access. "
                    "Returns a composition for review; saves and renders nothing. Context may describe "
                    "the selected scene. Send the current draft, including unsaved edits.",
        input_schema={"type": "object", "properties": {
            "video_id": {"type": "string"}, "instruction": {"type": "string", "maxLength": 4000},
            "composition": {"type": "string", "maxLength": 400000},
            "context": {"type": "string", "maxLength": 2000}, "title": {"type": "string"},
            "brief": {"type": "string"},
        }, "required": ["video_id", "instruction", "composition"]},
    ))
    reg.register(Op(
        name="videos.save",
        relation="read",
        mutating=True,
        description=("Save a video's composition — the video written as code — and optionally its brief, "
                     "title or format. " + COMPOSITION_GUIDE + " Saving makes it a draft until rendered again."),
        input_schema={"type": "object",
                      "properties": {"video_id": {"type": "string"}, "composition": {"type": "string"},
                                     "brief": {"type": "string"}, "title": {"type": "string"},
                                     "format": {"enum": ["landscape", "portrait", "square"]}, **_KEY},
                      "required": ["video_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="videos.render",
        relation="read",
        mutating=True,
        description=("Render the saved composition to an MP4 (default) or a royalty-free WebM, in the "
                     "background. Poll videos.get until state is ready or failed (render.error says why)."),
        input_schema={"type": "object",
                      "properties": {"video_id": {"type": "string"}, "format": {"enum": ["mp4", "webm"]}, **_KEY},
                      "required": ["video_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="videos.file",
        relation="read",
        description=("The rendered file's details — format, size, length. The web app downloads the file "
                     "itself with download: true."),
        input_schema={"type": "object",
                      "properties": {"video_id": {"type": "string"}, "download": {"type": "boolean"},
                                     "poster": {"type": "boolean", "description": "A still for a thumbnail."},
                                     "space_id": {"type": "string"}},
                      "required": ["video_id"]},
    ))
    reg.register(Op(
        name="videos.delete",
        relation="read",
        mutating=True,
        description="Delete a video and its rendered files. Its owners only.",
        input_schema={"type": "object", "properties": {"video_id": {"type": "string"}, **_KEY},
                      "required": ["video_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="videos.tools",
        relation="read",
        description="Whether this gateway can render videos: the renderer and ffmpeg, installed or not.",
        input_schema={"type": "object", "properties": {"space_id": {"type": "string"}}},
    ))
