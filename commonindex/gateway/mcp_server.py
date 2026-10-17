"""The MCP transport — the door onto the operations an agent can already see.

``mcp.build`` has produced a correct tool manifest since the beginning, and
nothing served it: no transport spoke the protocol, ``Op.handler`` was never
populated, and ``app.py`` never imported the module. Thirty-six tools, correctly
described, that no agent could connect to.

**Tools are dispatched through the ASGI app, not reimplemented.** A second
dispatch path is a second place for the two surfaces to drift, which is the
defect this codebase's parity tests exist to catch — so a tool call builds an
HTTP scope and invokes the same FastAPI application a browser reaches. The
handler, its validation and its typed errors are one implementation with two
front doors, by construction rather than by discipline.

**Resources carry the context, not just the tools.** An agent that can call
``experiments.readout`` but does not know that a failed sample-ratio check
invalidates every number in the response will narrate a confounded lift
confidently. So the generated skill is served as MCP resources: SKILL.md, the
per-dataset references, and the experiment catalogue with its decision
procedure. A client can attach them as context without spending a tool call, and
they are regenerated per read — there is no stored copy to go stale.
"""

from __future__ import annotations

import json
from typing import Any

import mcp.types as t
from mcp.server.lowlevel import Server

from commonindex.adapters import codemd, contextmd
from commonindex.gateway.mcp import build as build_tools

#: Where the generated skill is published. One resource per file in the bundle.
SCHEME = "commonindex://skill/"
CODE_QUERY_PATH = "references/code-query.md"
CODE_QUERY_GUIDE = """# Code Query

You are searching an enterprise's indexed source. The server routes across
repositories and enforces permissions; YOU drive the search, one hop at a time.

## Do not name a repository

`code.search` searches every repository the caller can read and reports which
ones answered. Omit `repos` unless you are deliberately narrowing. You are not
expected to know which repository holds the answer — that is what routing is
for, and guessing wrong silently searches the wrong half of the corpus.

If you do not know what exists, call `code.list_repos` first. It is the only
way to tell "nothing matched" from "nothing is indexed".

## One search is not a flow

A question like "trace the order placement journey from UI to database" cannot
be answered by one search. It takes a chain, and you must actually walk it:

1. `code.search` for the domain term ("place order", "checkout").
2. `code.find_symbol` on a function you found, to get its definition and lines.
3. `code.find_references` on that symbol, to find its callers and move outward.
4. `code.get_file` to read around a hit when the snippet is not enough.
5. Repeat until the path is connected — entry point through to persistence.

Do not report a flow you have not traced. If you searched once and found a
single file, say what you found and what is still unverified. A plausible
narrative assembled from one hit is the failure mode this tool exists to
prevent, and it is indistinguishable from a correct answer to the person
reading it.

## Query syntax

`code.search` accepts literal terms, regular expressions, and:
`sym:name` (definitions), `file:pattern`, `lang:python`, `-term` (exclude).
Identifier and regex search work properly here — prefer `sym:placeOrder` or
`place_?[Oo]rder` over hoping a prose search hits the right token.

## Every code response is markdown

These tools answer with a markdown document, not JSON: a summary table of how
the search was routed, one `###` section per cited excerpt with the citation as
its heading, and fenced code for each snippet. Read it as a document and you
have everything — including `object_id`, which is the argument `code.get_file`
takes for the next hop.

Pass it through when you show your work. It is already the shape a reader wants,
and re-describing a rendered table in prose loses the citations that make it
checkable.

## Read the whole document, not just the snippets

The routing table is above the excerpts because it changes what they are
evidence of:

- **Answered from** — which repositories actually answered, ranked.
- **Searched** — what was searched. If a repository you expected is absent, the
  caller may not have access to it.
- **Not indexed** — known but never indexed. Silence from these is not evidence.
- A `[!WARNING]` about a degraded index — the lexical index was unavailable and
  a weaker full-text fallback answered instead. Recall is materially worse; say
  so in your answer rather than only noticing it.
- **stale** on an excerpt — the search index and the stored file disagree on the
  revision. Verify with `code.get_file` before citing it.
- **Truncated** — you are seeing a prefix, not everything that matched.

## Citations

Every claim about behaviour cites `repo/path:Lx-Ly` from a hit you actually
received. Never cite a file you did not retrieve, and never infer a line range.
`code.find_references` returns LEXICAL matches, not resolved references: a
common name will match unrelated code, so confirm with `code.get_file` before
citing one as part of a flow.

## The hosted path

`code.ask` answers using the workspace's own configured model. Use the
retrieval tools above instead when your own model should synthesize — that is
the normal case over MCP, and it keeps the source in your context rather than
someone else's. Pass `include_diagram: true` only when a flow diagram was asked
for; its answer then carries the flow as a ```mermaid fence.

## Diagrams

A diagram in a response was drawn by the server from a validated node/edge
specification — the answering model supplied the graph, not the mermaid text.
When you draw one yourself, say that you drew it. The distinction matters to
whoever reads the two side by side: one was checked against retrieved code, and
the other is your reading of it.
"""


async def call_asgi(app, path: str, body: dict[str, Any],
                    token: str | None = None) -> tuple[int, Any]:
    """POST into the ASGI app in-process and read the response back.

    No HTTP socket and no second client library: the app is an ASGI callable,
    so this is the real route, the real middleware and the real handler with
    none of the loopback.
    """
    payload = json.dumps(body).encode()
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": path, "raw_path": path.encode(), "query_string": b"",
        "root_path": "", "client": ("127.0.0.1", 0), "server": ("mcp", 80),
        "headers": [(b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                    (b"host", b"mcp"),
                    # The agent's own credential. It goes through the same
                    # middleware a browser does, so an MCP client is authorized
                    # exactly like a person — including being denied.
                    *([(b"authorization", f"Bearer {token}".encode())] if token else [])],
    }

    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": payload, "more_body": False}

    status: int | None = None
    chunks: list[bytes] = []

    async def send(message):
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b"") or b"")

    try:
        await app(scope, receive, send)
    except Exception as e:
        # In-process there is no server in front to turn an unhandled error
        # into a 500, so it rose through the MCP session as a protocol failure
        # and the agent got nothing to act on. It is a result: an internal
        # error, typed, naming the operation — the same thing a browser sees.
        import logging

        logging.getLogger(__name__).exception("MCP tool %s failed", path)
        return 500, {"error": {"code": "internal",
                               "message": f"{path.removeprefix('/api/v1/')} failed on the server "
                                          f"({type(e).__name__}); this is a gateway bug, not your input"}}
    raw = b"".join(chunks)
    try:
        return status or 500, json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return status or 500, {"error": {"code": "unparseable",
                                         "message": raw.decode(errors="replace")[:400]}}


def build_server(app, registry, token: str | None = None) -> Server:
    """One Server, wired to the registry for tools and to the gateway for
    everything it answers."""
    tools = build_tools(registry)
    by_name = {tool.name: tool for tool in tools}

    async def on_list_tools(ctx, params):
        return t.ListToolsResult(tools=[
            t.Tool(name=tool.name,
                   description=tool.description or tool.name,
                   input_schema=tool.input_schema or {"type": "object"})
            for tool in tools
        ])

    async def on_call_tool(ctx, params: t.CallToolRequestParams):
        if params.name not in by_name:
            # Named rather than a bare failure: the manifest and the dispatcher
            # read the same registry, so this can only mean a stale client.
            return t.CallToolResult(
                is_error=True,
                content=[t.TextContent(
                    type="text",
                    text=f"no operation {params.name!r}; this gateway serves "
                         f"{len(tools)} operations, listed by tools/list")])

        status, body = await call_asgi(
            app, f"/api/v1/{params.name}", dict(params.arguments or {}), token)
        # Code query answers in markdown: a heading per cited excerpt, the flow
        # as a ```mermaid fence, and routing as a table — so a client shows a
        # readable answer with a visible diagram instead of a JSON blob whoever
        # is reading it has to parse by eye. It is a RENDERING of this same
        # response, not a second one: `codemd.for_tool` renders only responses it
        # has a renderer for, and every field a caller needs to take the next hop
        # (`object_id`, the citation, `stale`, the routing) is in it, which is
        # what makes replacing the JSON honest rather than lossy.
        markdown = ((codemd.for_tool(params.name, body) or contextmd.for_tool(params.name, body))
                    if status < 400 else None)
        text = markdown or json.dumps(body, indent=2, default=str)
        # A typed error is a RESULT an agent can act on — the gateway already
        # returns a code and the offending field — so it comes back as content
        # with isError set, not as a protocol-level failure that erases it. It
        # stays JSON: the code and field are the actionable part, and prose
        # around them would only bury it.
        return t.CallToolResult(
            is_error=status >= 400,
            content=[t.TextContent(type="text", text=text)])

    async def _skill_files() -> dict[str, str]:
        status, body = await call_asgi(app, "/api/v1/context.skill", {}, token)
        if status >= 400 or not isinstance(body, dict):
            return {}
        return body.get("files") or {}

    async def on_list_resources(ctx, params):
        files = await _skill_files()
        files[CODE_QUERY_PATH] = CODE_QUERY_GUIDE
        return t.ListResourcesResult(resources=[
            t.Resource(
                uri=f"{SCHEME}{path}",
                name=path,
                description=_describe(path),
                mime_type="text/markdown" if path.endswith(".md") else "text/plain",
            )
            for path in sorted(files)
        ])

    async def on_read_resource(ctx, params: t.ReadResourceRequestParams):
        uri = str(params.uri)
        files = await _skill_files()
        files[CODE_QUERY_PATH] = CODE_QUERY_GUIDE
        path = uri.removeprefix(SCHEME)
        if path not in files:
            return t.ReadResourceResult(contents=[t.TextResourceContents(
                uri=params.uri, mime_type="text/plain",
                text=f"no resource {path!r}; this space publishes "
                     f"{', '.join(sorted(files)) or 'nothing'}")])
        return t.ReadResourceResult(contents=[t.TextResourceContents(
            uri=params.uri,
            mime_type="text/markdown" if path.endswith(".md") else "text/plain",
            text=files[path])])

    return Server(
        name="commonindex",
        version="0.1.0",
        instructions=(
            "Dashboards, experiments, code query and the metric registry for this workspace. "
            "Read the resources before writing SQL or reading out an experiment: "
            "they carry which definitions are ratified, which experiments are "
            "pre-registered, and the order a readout has to be read in. Every "
            "number here cites a definition somebody stood behind, and an "
            "operation will refuse rather than answer with one nobody has.\n\n"
            "If you are an agent here, people reach you by asking: a mention in a "
            "comment or a channel, a task handed to you, or a direct ask. Nothing "
            "runs you — read `agents.inbox` when you connect, and until you do, "
            "whoever asked sees you as asked and waiting. For each ask: claim it "
            "with `runs.start` (one run per ask). A `mention` names the thread — "
            "answer in it with `messages.post`, `subject_id` and `parent_id` as "
            "given. A `task` is yours to do: read it with `tasks.get`, then file "
            "the work with `tasks.submit`, one true or false per criterion, or stop "
            "and ask a person with `tasks.question`. Any other `ask` is answered "
            "where it was about. Then say how it went with `runs.finish`.\n\n"
            "To understand a problem, start with `workspace.context` and the question in "
            "plain words: one call returns everything the workspace holds about it — "
            "the dashboards, docs, experiments, designs, tasks and channels it touches, "
            "each read in full with its conversation and links, plus the definitions, "
            "comments, runs and code it matched — and names in `left_out` what did not "
            "fit, to open next.\n\n"
            "To find anything here, search the way a person does, in steps: "
            "`search.query` with a few words (narrow with types, author, since, "
            "or within one conversation; offset for the next page), `search.read` "
            "the ids that look right, then search again with the words those items "
            "actually use — the first words you think of are rarely the ones "
            "written. Follow links from what you read. Search finds code, metric "
            "and dataset definitions and agents' runs too (types code, metric, "
            "dataset, run), and what an item said before an edit (types history). "
            "Reading a dashboard runs its panels and says their numbers now. Answer "
            "only from what you read, and cite ids. `workspace.ask` does all of "
            "this for you with the gateway's model, when one is configured.\n\n"
            "A dashboard, doc or design can be private to the people it is shared "
            "with: you see and change only what you have been given. `items.access` "
            "says who can; its owners share it with workspace members by email "
            "(`items.share`, `items.unshare`, `items.set_visibility`)."
        ),
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
        on_list_resources=on_list_resources,
        on_read_resource=on_read_resource,
    )


def _describe(path: str) -> str:
    if path == CODE_QUERY_PATH:
        return "How to retrieve and cite code for the LLM connected to this MCP server."
    if path == "SKILL.md":
        return "How to answer questions here: the datasets, the ratified definitions, and the one rule about citing them."
    if path == "references/experiments.md":
        return "Pre-registered experiments and the order a readout must be read in — assignment, contract, interval, guardrails."
    if path.startswith("references/"):
        return f"Dataset reference: what one row is, which columns are sliceable, and the definitions bound to it ({path.split('/')[-1]})."
    return path


async def serve() -> None:
    """Run over stdio, owning the gateway's lifespan.

    The app's lifespan opens the connection pool and builds the metric registry,
    so it has to run here: an MCP server launched by an agent is its own
    process, not a client of a gateway somebody else started.
    """
    import os

    from mcp.server.stdio import stdio_server

    from commonindex.gateway.app import REGISTRY, app

    # The credential this agent runs as. Without it every tool call returns 401
    # from the same middleware a browser hits — which is correct: an MCP client
    # is a caller like any other, not a trusted internal path.
    token = os.environ.get("COMMONINDEX_TOKEN")
    async with app.router.lifespan_context(app):
        server = build_server(app, REGISTRY, token)
        async with stdio_server() as (read, write):
            await server.run(read, write,
                             server.create_initialization_options())


def main() -> int:
    import anyio

    anyio.run(serve)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
