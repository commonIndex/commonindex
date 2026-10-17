"""Render a Code Query result as Markdown, with the flow as a mermaid diagram.

One renderer, three consumers:

  * `code.ask` carries the document in `markdown`, and the web client renders it
    — headings, a diagram, a sources list and a routing table, instead of the
    one pre-wrapped paragraph `answer` is.
  * The MCP transport returns markdown as the tool result, so a connected
    client shows a readable answer with a visible diagram rather than a JSON
    blob whoever is reading it has to parse by eye.
  * Anything that writes the result to a file gets a `.md` that is correct
    markdown — which is what makes the first two more than a coat of paint.

**The mermaid text is generated here, from the server-validated flow.** The
model supplies `title`, `nodes` and `edges`, `gateway.app._valid_flow` bounds
and cleans them, and this module spells the diagram. That is the same rule the
structured contract already enforced — the model supplies data, the platform
draws the picture — restated in a format every markdown viewer knows how to
draw. It is also why a ```mermaid fence *inside the model's prose* is demoted
to a plain code block (`answer_body`): a diagram the validator never saw must
not reach a diagram renderer just because the model wrapped it in the right
fence.

Everything interpolated here — a model's answer, a repository name, a file body
— is untrusted text landing in a markdown channel, where a stray fence or
heading becomes document structure. It goes through `dataskill.one_line` and
`dataskill.fenced` for the same reason the generated skill does.
"""

from __future__ import annotations

import re
from typing import Any

from commonindex.adapters.dataskill import fenced, one_line

#: Mermaid's shape brackets, chosen by the `kind` a flow node carries. `kind` is
#: model text, so it is matched against this table and never spelled into the
#: diagram: an unrecognised kind is a plain box, not a syntax error in the
#: middle of a fence.
_SHAPES: tuple[tuple[tuple[str, ...], tuple[str, str]], ...] = (
    (("ui", "client", "browser", "page", "frontend", "user", "request"), ("([", "])")),
    (("store", "db", "database", "table", "postgres", "sql", "index", "cache",
      "disk", "bucket"), ("[(", ")]")),
    (("queue", "topic", "stream", "event", "bus", "job", "cron", "worker"), ("[/", "/]")),
    (("decision", "check", "branch", "gate", "guard", "if", "validate",
      "authz", "acl"), ("{", "}")),
    (("external", "ext", "third", "vendor", "provider", "model", "llm"), ("[[", "]]")),
)
_BOX = ("[", "]")

#: Fences the *model* may not have drawn as a diagram. See the module docstring:
#: a renderer that auto-draws these would be drawing something no validator saw.
_DIAGRAM_LANGS = frozenset({"mermaid", "plantuml", "puml", "dot", "graphviz"})

_HEADING = re.compile(r"^(#{1,6})(\s)")
_FENCE = re.compile(r"^(`{3,}|~{3,})")


def _shape(kind: str) -> tuple[str, str]:
    lowered = (kind or "").lower()
    for words, brackets in _SHAPES:
        if any(word in lowered for word in words):
            return brackets
    return _BOX


def _label(value: Any, limit: int = 120) -> str:
    """A mermaid node or edge label: one line, and unable to end its own quote.

    Mermaid reads `#` as the start of a character entity (`#quot;`) and `"` as
    the end of a quoted label, so those two are the whole escape. Newlines are
    removed rather than converted to `<br/>`: a label is not a place to accept
    markup from a model, not even mermaid's own.
    """
    text = " ".join(("" if value is None else str(value)).split())
    text = text.replace("#", "#35;").replace('"', "#quot;")
    return text[:limit] or "?"


def mermaid(flow: dict, direction: str = "TD") -> str:
    """The validated flow as a mermaid `flowchart`.

    Node ids are renumbered `n0…nN` rather than passed through. A model id is a
    string like any other, and `a b` or `-->` in one would be mermaid syntax
    appearing where a name belongs; renumbering makes that impossible instead of
    filtering for it. The mapping is positional, so the same flow always renders
    the same text and a diff of two answers is a diff of two diagrams.
    """
    ids = {node["id"]: f"n{index}" for index, node in enumerate(flow.get("nodes") or [])}
    lines = [f"flowchart {direction if direction in ('TD', 'LR') else 'TD'}"]
    title = _label(flow.get("title"), 160)
    if title != "?":
        # A mermaid comment, so the title survives into any other viewer while
        # staying out of the graph itself.
        lines.append(f"%% title: {title}")
    for node in flow.get("nodes") or []:
        open_bracket, close_bracket = _shape(str(node.get("kind", "")))
        lines.append(f'  {ids[node["id"]]}{open_bracket}"{_label(node.get("label"))}"{close_bracket}')
    for edge in flow.get("edges") or []:
        source, target = ids.get(edge.get("from")), ids.get(edge.get("to"))
        if source is None or target is None:
            continue  # the validator already rejects these; belt and braces
        label = _label(edge.get("label"), 80)
        arrow = f'-->|"{label}"|' if edge.get("label") else "-->"
        lines.append(f"  {source} {arrow} {target}")
    return "\n".join(lines)


def answer_body(text: Any, depth: int = 3, limit: int = 20_000) -> str:
    """The model's prose, made safe to embed under a heading of `depth`.

    Two things are corrected, both of which break the *document* rather than the
    paragraph:

      * Headings are demoted so the model cannot open a section at the same
        level as ours, which would put "## Sources" inside its own answer.
      * An unterminated fence is closed. Left open, it swallows every section
        after the answer — sources, diagram and routing all render as code.

    And one thing is deliberately downgraded: a fence tagged as a diagram
    language becomes `text`, so only the validated flow is ever drawn.
    """
    raw = ("" if text is None else str(text)).replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    fence: str | None = None
    for line in raw[:limit].split("\n"):
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        marker = match.group(1) if (match := _FENCE.match(stripped)) else None
        if fence is None and marker:
            info = stripped[len(marker):].strip()
            if info.split(" ")[0].lower() in _DIAGRAM_LANGS:
                info = "text"
            fence = marker
            out.append(f"{indent}{marker}{info}")
        elif fence and marker and marker[0] == fence[0] and len(marker) >= len(fence) \
                and not stripped[len(marker):].strip():
            fence = None
            out.append(line)
        elif fence is None and (heading := _HEADING.match(stripped)):
            hashes = "#" * min(6, len(heading.group(1)) + depth - 1)
            out.append(f"{indent}{hashes}{stripped[len(heading.group(1)):]}")
        else:
            out.append(line)
    if fence is not None:
        out.append(fence)
    return "\n".join(out).strip()


def _note(tone: str, body: str) -> list[str]:
    """A GitHub-style alert. Renders as a callout where those are supported and
    as a plain blockquote everywhere else — never as nothing."""
    return [f"> [!{tone}]", *[f"> {line}" for line in body.splitlines()], ""]


def _routing_rows(pack: dict) -> list[tuple[str, str]]:
    """How the answer was reached, as label/value pairs.

    Rendered for the reader, not only for the model: "answered from 1 of 6
    repositories" changes how far the paragraph above should be trusted, and a
    reader who cannot see it will read a thin answer as a complete one.
    """
    rows: list[tuple[str, str]] = []
    if pack.get("routing"):
        rows.append(("Routing", one_line(pack["routing"], 300)))
    if pack.get("selected_repos"):
        rows.append(("Answered from", ", ".join(
            f"`{one_line(entry.get('repo'), 80)}`" for entry in pack["selected_repos"])))
    if pack.get("searched_repos"):
        rows.append(("Searched", ", ".join(
            f"`{one_line(repo, 80)}`" for repo in pack["searched_repos"])))
    # Absence of results from a repository nobody indexed is not evidence, and
    # saying so is the difference between "not there" and "not looked at".
    if pack.get("unindexed_repos"):
        rows.append(("Not indexed", ", ".join(
            f"`{one_line(repo, 80)}`" for repo in pack["unindexed_repos"])
            + " — silence from these means nothing yet"))
    if pack.get("unknown_repos"):
        rows.append(("Unknown", ", ".join(
            f"`{one_line(repo, 80)}`" for repo in pack["unknown_repos"])))
    if pack.get("withheld_repos"):
        # Not "cannot read": this is the caller's own `repos` filter excluding
        # repositories they can read perfectly well. A reader shown the other
        # sentence goes looking for a grant that is not missing.
        rows.append(("Not searched", (f"{pack['withheld_repos']} other readable "
                                      "repository/repositories, outside the ones named")))
    if pack.get("withheld"):
        rows.append(("Over budget", (f"{pack['withheld']} matched excerpt(s) did not fit "
                                     "the context budget")))
    if pack.get("relaxed_to"):
        rows.append(("Broadened to", f"`{one_line(pack['relaxed_to'], 160)}`"))
    if pack.get("as_identifiers"):
        rows.append(("Searched as identifiers", f"`{one_line(pack['as_identifiers'], 160)}`"))
    if pack.get("as_literal"):
        rows.append(("Searched as literal text", (f"`{one_line(pack['as_literal'], 160)}` — as a "
                                                  "pattern it was invalid or matched nothing")))
    if pack.get("truncated"):
        rows.append(("Truncated", "more matched than was returned"))
    if pack.get("engine"):
        rows.append(("Engine", f"`{one_line(pack['engine'], 40)}`"))
    return rows


def _table(head: tuple[str, ...], rows: list[tuple[str, ...]]) -> list[str]:
    if not rows:
        return []
    return ["| " + " | ".join(head) + " |",
            "|" + "|".join(" --- " for _ in head) + "|",
            *["| " + " | ".join(cell for cell in row) + " |" for row in rows],
            ""]


def answer(*, question: Any, text: Any, flow: dict | None = None,
           citations: list[str] | None = None, pack: dict | None = None,
           model: str | None = None) -> str:
    """The `code.ask` document: question, answer, diagram, sources, routing."""
    pack = pack or {}
    shown = len(pack.get("context") or [])
    lines = [f"# {one_line(question, 200) or 'Code query'}", ""]

    searched = len(pack.get("searched_repos") or [])
    reach = (f"{shown} file {'excerpt' if shown == 1 else 'excerpts'} from "
             f"{len(pack.get('selected_repos') or [])} of {searched} searched "
             f"{'repository' if searched == 1 else 'repositories'}")
    docs = len(pack.get("docs") or [])
    if docs:
        reach += f" and {docs} doc {'section' if docs == 1 else 'sections'}"
    if model:
        provenance = f"Answered by `{one_line(model, 80)}`" + (f" from {reach}." if pack else ".")
    elif not pack:
        provenance = "Retrieval only — no model was called."
    elif not searched and not docs:
        provenance = "Retrieval only — no repositories were searched."
    else:
        provenance = f"Retrieval only — no model was called. Built from {reach}."
    lines += [f"*{provenance}*", ""]

    if pack.get("degraded"):
        lines += _note("WARNING", "The precise code index was unavailable, so this was "
                                  "answered from a weaker full-text search — recall is "
                                  f"materially worse than usual. {one_line(pack['degraded'], 200)}")

    lines += ["## Answer", "", answer_body(text) or "_The model returned nothing._", ""]

    if flow:
        lines += [f"## Flow — {one_line(flow.get('title'), 160)}", "",
                  f"```mermaid\n{mermaid(flow)}\n```", ""]

    if citations:
        lines += ["## Sources", "",
                  *[f"- `{one_line(citation, 200)}`" for citation in citations], ""]

    rows = _routing_rows(pack)
    if rows:
        lines += ["## How this answer was reached", "",
                  *_table(("", ""), [(label, value) for label, value in rows])]
    return "\n".join(lines).rstrip() + "\n"


def _flags(hit: dict) -> str:
    flags = []
    if hit.get("stale"):
        flags.append("**stale** — index and file disagree on the revision, verify "
                     "with `code.get_file` before citing")
    if hit.get("truncated"):
        flags.append("truncated excerpt")
    return "; ".join(flags)


def _hit_sections(hits: list[dict], heading: str = "###") -> list[str]:
    """One section per hit: its citation as the heading, then the excerpt.

    `object_id` is in the metadata line because it is the argument
    `code.get_file` takes. A rendering that drops it would force a caller who
    needs more of the file to search again for something it was already handed.
    """
    lines: list[str] = []
    for index, hit in enumerate(hits, start=1):
        lines += [f"{heading} {index}. `{one_line(hit.get('citation'), 200)}`", ""]
        meta = [f"repo `{one_line(hit.get('repo') or hit.get('repo_id'), 80)}`"]
        if hit.get("language"):
            meta.append(f"lang `{one_line(hit['language'], 40)}`")
        if hit.get("score") is not None:
            meta.append(f"score {float(hit['score']):.1f}")
        if hit.get("object_id"):
            meta.append(f"object_id `{one_line(hit['object_id'], 80)}`")
        lines += [" · ".join(meta), ""]
        if flags := _flags(hit):
            lines += [f"> {flags}", ""]
        lines += [fenced(hit.get("snippet"), str(hit.get("language") or "").lower(),
                         limit=4_000), ""]
    return lines


def search(body: dict, *, title: str = "Code search") -> str:
    """A routed search result: what answered, then the cited excerpts.

    The summary table comes first deliberately. A caller — a person or a model —
    needs to know that two of six repositories answered *before* reading the
    first snippet, because that fact changes what the snippets are evidence of.
    """
    hits = body.get("hits") or body.get("context") or []
    query = one_line(body.get("query") or body.get("symbol"), 200)
    lines = [f"# {title}: `{query}`" if query else f"# {title}", ""]
    if body.get("caveat"):
        lines += _note("IMPORTANT", one_line(body["caveat"], 400))
    if body.get("degraded"):
        lines += _note("WARNING", "The precise code index was unavailable; these results "
                                  "come from a weaker full-text search and may be "
                                  f"incomplete. {one_line(body['degraded'], 200)}")
    if body.get("kind"):
        lines += [f"*Result kind: `{one_line(body['kind'], 40)}`"
                  + (f", confidence `{one_line(body['confidence'], 40)}`"
                     if body.get("confidence") else "") + ".*", ""]
    rows = _routing_rows(body)
    if rows:
        lines += _table(("", ""), [(label, value) for label, value in rows])
    if not hits:
        lines += ["## No matches", "",
                  ("Nothing readable matched. This is not the same as nothing existing — "
                   "check `Not indexed` above, and `code.list_repos` for what is "
                   "searchable at all."), ""]
        return "\n".join(lines).rstrip() + "\n"
    lines += [f"## {len(hits)} excerpt(s)", ""]
    lines += _table(
        ("#", "Citation", "Score", "Notes"),
        [(str(index), f"`{one_line(hit.get('citation'), 160)}`",
          f"{float(hit['score']):.1f}" if hit.get("score") is not None else "—",
          _flags(hit) or "")
         for index, hit in enumerate(hits, start=1)])
    lines += _hit_sections(hits)
    return "\n".join(lines).rstrip() + "\n"


def _jobs(body: dict) -> list[str]:
    """What `code.index` started and has not finished — or failed. Without it an
    agent that asked for a repository to be indexed could not tell "still
    cloning" from "refused", and would poll a list that never changes."""
    jobs = body.get("indexing") or []
    if not jobs:
        return []
    return ["## Being indexed", "", *_table(
        ("Repository", "State", "Detail"),
        [(f"`{one_line(job.get('repo'), 120)}`", one_line(job.get("state"), 20),
          one_line(job.get("error") if job.get("state") == "failed" else job.get("step"), 300) or "—")
         for job in jobs])]


def repos(body: dict) -> str:
    listed = body.get("repos") or []
    lines = ["# Repositories this caller can search", ""]
    if not listed:
        lines += [("Nothing is indexed, or nothing readable is. A search here cannot "
                   "answer anything yet, and an empty result means *not indexed* "
                   "rather than *not found*."), ""]
        lines += _jobs(body)
        return "\n".join(lines).rstrip() + "\n"
    lines += _table(
        ("Repository", "Branch", "Provider", "Health", "Last indexed"),
        [(f"`{one_line(repo.get('repo'), 120)}`", one_line(repo.get("branch"), 80) or "—",
          one_line(repo.get("provider"), 40) or "—", one_line(repo.get("health"), 40) or "—",
          one_line(repo.get("last_indexed_at"), 40) or "**never**")
         for repo in listed])
    if any(not repo.get("last_indexed_at") for repo in listed):
        lines += _note("NOTE", "A repository that has never been indexed cannot answer a "
                               "search. Absence of results from one proves nothing.")
    lines += _jobs(body)
    return "\n".join(lines).rstrip() + "\n"


def code_file(body: dict) -> str:
    citation = one_line(body.get("citation"), 200)
    lines = [f"# `{citation}`", ""]
    meta = [f"object_id `{one_line(body.get('object_id'), 80)}`"]
    if body.get("sha"):
        meta.append(f"sha `{one_line(body['sha'], 40)}`")
    meta.append(f"lines {body.get('start_line')}–{body.get('end_line')}")
    lines += [" · ".join(meta), ""]
    if body.get("truncated"):
        lines += _note("NOTE", "This excerpt hit the character budget and is a prefix. "
                               "Ask for a narrower line range to see the rest.")
    lines += [fenced(body.get("body"), _lang_of(body.get("path")), limit=50_000), ""]
    return "\n".join(lines).rstrip() + "\n"


#: Enough to get a fence tagged for highlighting. A wrong guess costs colour,
#: so the fallback is no tag rather than a plausible one.
_LANGS = {"py": "python", "ts": "typescript", "tsx": "tsx", "js": "javascript",
          "jsx": "jsx", "go": "go", "rs": "rust", "java": "java", "kt": "kotlin",
          "rb": "ruby", "php": "php", "cs": "csharp", "c": "c", "h": "c",
          "cc": "cpp", "cpp": "cpp", "hpp": "cpp", "swift": "swift", "sql": "sql",
          "sh": "bash", "yaml": "yaml", "yml": "yaml", "json": "json", "md": "markdown",
          "css": "css", "html": "html", "tf": "hcl", "scala": "scala"}


def _lang_of(path: Any) -> str:
    suffix = str(path or "").rsplit(".", 1)
    return _LANGS.get(suffix[-1].lower(), "") if len(suffix) == 2 else ""


#: Which operations render, and as what. Absent from this table means "leave the
#: JSON alone": a markdown rendering of a response nobody wrote a renderer for
#: would be a worse copy of the JSON, not a better one.
_SEARCH_TITLES = {
    "code.search": "Code search",
    "code.query": "Code search",
    "code.context": "Code context pack",
    "code.find_symbol": "Symbol definitions",
    "code.find_references": "Symbol references",
}


def for_tool(name: str, body: Any) -> str | None:
    """The markdown for one operation's response, or None if it has no rendering.

    Called by the MCP transport, which does not otherwise know anything about
    code query — so the decision about which responses have a markdown form
    lives here, next to the renderers, rather than as a list of names in the
    transport.
    """
    if not isinstance(body, dict) or body.get("error"):
        return None
    if name == "code.ask":
        pack = body.get("context") or {}
        return answer(question=pack.get("query"), text=body.get("answer"),
                      flow=body.get("diagram"), citations=body.get("citations"),
                      pack=pack, model=body.get("model"))
    if name in _SEARCH_TITLES:
        return search(body, title=_SEARCH_TITLES[name])
    if name == "code.list_repos":
        return repos(body)
    if name == "code.get_file":
        return code_file(body)
    return None
