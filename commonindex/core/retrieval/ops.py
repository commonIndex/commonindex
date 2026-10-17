"""Code Query's retrieval operation, registered into the one operation registry.

Mirrors `commonindex/core/warehouse/ops.py`'s shape: the definition lives beside
the engine it calls, and the handler is written by hand in the gateway because
it is a query verb, not a generated list/get/propose over one type.
"""

from __future__ import annotations

from commonindex.core.ops import Op, Registry

#: Appended to every operation that has a markdown rendering. Said in the tool
#: description because an agent decides how to use a result partly from what
#: shape it expects it in — and a rendered document is worth passing through,
#: where a JSON blob is worth summarising.
_MARKDOWN = (
    "\n\nOver MCP this answers with a MARKDOWN document rather than JSON: the "
    "routing summary first, then one section per cited excerpt with its citation "
    "as the heading, `object_id` in its metadata line, and the code in a fence. "
    "Read it as a document; it holds everything the JSON does."
)

#: Shared by every search-shaped operation. `repos` is optional on purpose —
#: the caller is not expected to know which repository holds the answer, and
#: omitting it is the normal case rather than the lazy one.
_SCOPE = {
    "repos": {"type": "array", "items": {"type": "string"},
              "description": "Optional. Narrow to these repositories, as 'org/repo'. "
                             "OMIT THIS to search everything the caller can read — "
                             "the server routes automatically and reports which "
                             "repositories it chose."},
    "path_glob": {"type": "string",
                  "description": "Optional glob over the file path, e.g. 'src/*.ts'"},
    "language": {"type": "string",
                 "description": "Optional language filter, e.g. 'python', 'typescript'"},
    "space_id": {"type": "string"},
}


def register(reg: Registry) -> None:
    reg.register(Op(
        name="search.query",
        relation="read",
        description=(
            "Find anything in the workspace by what it is called or what was said "
            "about it: objects in every collection by key, title and the text their "
            "type declares (a doc by any sentence in it; a dashboard by its panels and "
            "the definitions they chart; an experiment by its registration, readouts "
            "and decisions; a task by its definition of done and review), agents by "
            "name, comments and channel messages by their words, code by what its "
            "lines say, metric and dataset definitions, agents' runs by what each was "
            "asked, and earlier versions by what an item said before an edit. Every "
            "word of `q` must match, each as a prefix, so a half-typed query works. "
            "Returns objects first, best named match first, then a few of each other "
            "kind; each message hit names what it was about."
        ),
        input_schema={"type": "object",
                      "properties": {
                          "q": {"type": "string"},
                          "types": {"type": "array", "items": {"type": "string"},
                                    "description": "Optional. Only these kinds: item types (dashboard, "
                                                   "doc, experiment, design, task, channel) and message, "
                                                   "agent, code, metric, dataset, run, history. One kind "
                                                   "alone pages with offset."},
                          "author": {"type": "string", "description": "Optional. Who wrote it."},
                          "since": {"type": "string", "description": "Optional. A date, 2026-09-01."},
                          "until": {"type": "string", "description": "Optional. A date."},
                          "within": {"type": "string",
                                     "description": "Optional. One conversation: the messages about "
                                                    "this item, or in this channel."},
                          "offset": {"type": "integer", "description": "Skip this many — the next page."},
                          "limit": {"type": "integer"},
                          "space_id": {"type": "string"}},
                      "required": ["q"]},
    ))
    reg.register(Op(
        name="search.read",
        relation="read",
        description=(
            "Open one item a search found, as the index holds it: its text in "
            "sections, the latest of the conversation about it, what is linked to "
            "it, and what it said before its last edits. A dashboard also says what "
            "its panels show now, run live. Code files, metrics, datasets and runs "
            "open by their ids too. Search, read, then search again with the words "
            "the item uses — that is how to find what a first search missed."
        ),
        input_schema={"type": "object",
                      "properties": {"id": {"type": "string"},
                                     "numbers": {"type": "boolean",
                                                 "description": "Run a dashboard's panels for their "
                                                                "current values. Default true."},
                                     "space_id": {"type": "string"}},
                      "required": ["id"]},
    ))
    reg.register(Op(
        name="workspace.context",
        relation="read",
        description=(
            "Everything the workspace holds about one question, in one call — start "
            "here when you need context, not one item. Ask in plain words: the "
            "question is searched with every word, then with any word (items holding "
            "more of its words first), and each item found — dashboard, doc, "
            "experiment, design, task, channel — is read in full: its text, the latest "
            "of its conversation, its links, what it said before its last edits, and a "
            "dashboard's numbers now. Then one hop out to what those items link to. "
            "Beside them: the metric and dataset definitions, comments, agents' runs, "
            "code and earlier versions the question matched. Bounded by `max_chars`; "
            "whatever did not fit is named in `left_out` — open those with "
            "`search.read`. Only what the caller may see. Needs no model: you reason "
            "over it."
        ),
        input_schema={"type": "object",
                      "properties": {
                          "q": {"type": "string", "description": "The question or problem, in plain words."},
                          "items": {"type": "integer", "minimum": 1, "maximum": 20,
                                    "description": "Items to read in full before following links. Default 8."},
                          "max_chars": {"type": "integer", "minimum": 5000, "maximum": 150000,
                                        "description": "The budget in characters. Default 40000."},
                          "numbers": {"type": "boolean",
                                      "description": "Run dashboards' panels for their current values. "
                                                     "Default true."},
                          "space_id": {"type": "string"}},
                      "required": ["q"]},
    ))
    reg.register(Op(
        name="workspace.ask",
        relation="read",
        description=(
            "Answer a question from the workspace: the gateway's model searches, "
            "reads, searches again with the words it learned, and answers only from "
            "what it read, citing each item. Returns the answer, its citations and "
            "the steps taken. Needs a model configured on the gateway."
        ),
        input_schema={"type": "object",
                      "properties": {"q": {"type": "string"},
                                     "steps": {"type": "integer", "minimum": 1, "maximum": 10},
                                     "space_id": {"type": "string"}},
                      "required": ["q"]},
    ))

    reg.register(Op(
        name="code.index",
        relation="admin",
        mutating=True,
        description=(
            "Index a repository into code query — its files into the search index "
            "and Zoekt — and grant the caller read on it. Give `url`: any https git "
            "repository the caller can read (a public one, or a private one with "
            "`token`). Or give `path`: a clone on the gateway's machine, only under "
            "a folder the operator listed in COMMONINDEX_CODE_ROOTS. Runs in the "
            "background: `code.list_repos` shows it under `indexing` until it is "
            "searchable, or says why it failed. It is then indexed again on a "
            "schedule (hourly by default), so it follows the branch."
        ),
        input_schema={"type": "object",
                      "properties": {"url": {"type": "string",
                                             "description": "An https repository URL, e.g. "
                                                            "https://github.com/org/repo."},
                                     "branch": {"type": "string",
                                                "description": "Branch to index; the repository's "
                                                               "default branch when omitted."},
                                     "token": {"type": "string",
                                               "description": "An access token that can read a "
                                                              "private repository. Kept encrypted "
                                                              "for the scheduled re-index, never "
                                                              "returned or logged."},
                                     "keep_token": {"type": "boolean",
                                                    "description": "false: use the token for this "
                                                                   "index only and forget any kept "
                                                                   "one; the scheduled re-index then "
                                                                   "fails for a private repository."},
                                     "path": {"type": "string",
                                              "description": "Instead of url: a clone's folder on "
                                                             "the gateway's machine."},
                                     "space_id": {"type": "string"},
                                     "idempotencyKey": {"type": "string"}},
                      "required": ["idempotencyKey"]},
    ))
    reg.register(Op(
        name="code.list_repos",
        relation="read",
        description=(
            "List the repositories this caller can search, with how recently each "
            "was indexed. Call this first when you do not know what exists — it "
            "distinguishes 'nothing matched' from 'nothing indexed', which no "
            "search result can tell you on its own." + _MARKDOWN
        ),
        input_schema={"type": "object",
                      "properties": {"space_id": {"type": "string"}}},
    ))
    reg.register(Op(
        name="code.search",
        relation="read",
        description=(
            "Search indexed code across every repository the caller may read, "
            "ACL-filtered. DO NOT pass `repos` unless you are deliberately "
            "narrowing: with it omitted the server searches all readable "
            "repositories and tells you which ones answered, in `selected_repos`.\n\n"
            "Supports literal terms, regular expressions, and Zoekt syntax: "
            "`sym:name` for definitions, `file:pattern`, `lang:python`, and "
            "`-term` to exclude.\n\n"
            "Returns line-cited snippets. To trace a flow across files, call this "
            "repeatedly — search a term, then follow what you find with "
            "code.find_symbol and code.find_references, and widen with "
            "code.get_file. One search is not a flow." + _MARKDOWN
        ),
        input_schema={
            "type": "object",
            "properties": {
                "q": {"type": "string",
                      "description": "Terms, a regex, or Zoekt syntax such as sym:place_order"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                **_SCOPE,
            },
            "required": ["q"],
        },
    ))
    reg.register(Op(
        name="code.find_symbol",
        relation="read",
        description=(
            "Find where a function, class, or method is DEFINED, with its line "
            "range. Use this after a search turns up a call site and you need the "
            "implementation. Returns kind='definitions' when a symbol index was "
            "used and kind='mentions' when it fell back to plain search — treat "
            "the second as weaker evidence." + _MARKDOWN
        ),
        input_schema={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Exact symbol name"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                **_SCOPE,
            },
            "required": ["name"],
        },
    ))
    reg.register(Op(
        name="code.find_references",
        relation="read",
        description=(
            "Find where a symbol is USED, to follow a flow outward from a "
            "definition to its callers. These are LEXICAL identifier matches, not "
            "resolved references: a short or common name ('create', 'handler') "
            "will return unrelated code. Confirm with code.get_file before citing "
            "a reference as part of a flow." + _MARKDOWN
        ),
        input_schema={
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                **_SCOPE,
            },
            "required": ["name"],
        },
    ))
    reg.register(Op(
        name="code.query",
        relation="read",
        description=(
            "Deprecated alias for code.search, kept so existing callers keep "
            "working. Prefer code.search: it routes across every readable "
            "repository and reports which ones it chose."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "q": {"type": "string"},
                "space_id": {"type": "string"},
                "repo_id": {"type": "string"},
                "path_glob": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            "required": ["q"],
        },
    ))
    reg.register(Op(
        name="code.get_file",
        relation="read",
        description=("Read an ACL-filtered range of one indexed code file by object id."
                     + _MARKDOWN),
        input_schema={
            "type": "object",
            "properties": {
                "object_id": {"type": "string"},
                "start_line": {"type": "integer", "minimum": 1},
                "end_line": {"type": "integer", "minimum": 1},
                "max_chars": {"type": "integer", "minimum": 1, "maximum": 50000},
                "space_id": {"type": "string"},
            },
            "required": ["object_id"],
        },
    ))
    reg.register(Op(
        name="code.context",
        relation="read",
        description=("Build a bounded, cited code context pack for a user-owned LLM. "
                     "This never calls a model." + _MARKDOWN),
        input_schema={
            "type": "object",
            "properties": {
                "q": {"type": "string"},
                "repo_id": {"type": "string"},
                "path_glob": {"type": "string"},
                "max_chars": {"type": "integer", "minimum": 1, "maximum": 50000},
                "space_id": {"type": "string"},
            },
            "required": ["q"],
        },
    ))
    reg.register(Op(
        name="code.ask",
        relation="read",
        description=("Answer a code question with the configured model using only cited, "
                     "ACL-filtered context. The answer comes back as prose in `answer` "
                     "and as a markdown document in `markdown` — the prose under a "
                     "heading, the citations as a list and the routing as a table. Set "
                     "include_diagram to have the flow drawn in it as a mermaid "
                     "flowchart, written by the server from a specification it "
                     "validated. Over MCP the markdown document is the result."),
        input_schema={
            "type": "object",
            "properties": {
                "q": {"type": "string"},
                "repo_id": {"type": "string"},
                "path_glob": {"type": "string"},
                "include_diagram": {"type": "boolean"},
                "max_context_chars": {"type": "integer", "minimum": 1, "maximum": 50000},
                "space_id": {"type": "string"},
            },
            "required": ["q"],
        },
    ))
