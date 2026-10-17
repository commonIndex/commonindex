"""The artifact verbs: HTML that runs, embedded in docs by id.
`artifacts.list`, `artifacts.get` and `artifacts.propose` are the type's own
(types/artifact.json); these write, draw and remove."""

from __future__ import annotations

from commonindex.core.ops import Op, Registry

_KEY = {"idempotencyKey": {"type": "string"}, "space_id": {"type": "string"}}

HTML_GUIDE = (
    "An artifact is one self-contained HTML fragment — a chart, a calculator, a styled table, a small "
    "interactive demo — with inline <style> and <script>, inline SVG and data: images. No URLs, external "
    "scripts, iframes, links, forms, fetch or other network calls: it is refused otherwise, and it runs in a "
    "sandboxed frame with no network and no access to the app. Put it in a doc with an embed block: "
    "{\"type\": \"embed\", \"attrs\": {\"ref\": \"<artifact id>\"}} in docs.revise, or the line "
    ":::embed {ref=\"<artifact id>\"} ::: in markdown."
)


def register(reg: Registry) -> None:
    reg.register(Op(
        name="artifacts.save",
        relation="read",
        mutating=True,
        description=("Save an artifact's HTML, title, description or height (CSS pixels, 120-1600). "
                     + HTML_GUIDE + " Each save is a revision; a snapshot for pages that run no script "
                     "follows in the background."),
        input_schema={"type": "object",
                      "properties": {"artifact_id": {"type": "string"}, "html": {"type": "string"},
                                     "title": {"type": "string"}, "description": {"type": "string"},
                                     "height": {"type": "integer"}, "if_rev": {"type": "integer"}, **_KEY},
                      "required": ["artifact_id", "idempotencyKey"]},
    ))
    reg.register(Op(
        name="artifacts.draft",
        relation="read",
        description=("Write an artifact's HTML from an instruction — or change the HTML given — with the "
                     "workspace's model. kind \"block\" (default) is a piece that sits in a doc; kind \"page\" is "
                     "a complete, responsive HTML document, which a doc holding only that embed opens as. Returns "
                     "HTML that passes the same check a save does; saves nothing."),
        input_schema={"type": "object",
                      "properties": {"instruction": {"type": "string"}, "html": {"type": "string"},
                                     "kind": {"enum": ["block", "page"]},
                                     "space_id": {"type": "string"}},
                      "required": ["instruction"]},
    ))
    reg.register(Op(
        name="artifacts.snapshot",
        relation="read",
        description="The artifact's still image (PNG), as a shared doc or an export shows it.",
        input_schema={"type": "object",
                      "properties": {"artifact_id": {"type": "string"}, "space_id": {"type": "string"}},
                      "required": ["artifact_id"]},
    ))
    reg.register(Op(
        name="artifacts.delete",
        relation="read",
        mutating=True,
        description="Delete an artifact and its snapshot. Its owners only; docs that embed it say it is gone.",
        input_schema={"type": "object", "properties": {"artifact_id": {"type": "string"}, **_KEY},
                      "required": ["artifact_id", "idempotencyKey"]},
    ))
