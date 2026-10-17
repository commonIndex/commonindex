# Code Query

Code Query has two deliberately separate access modes over the same indexed,
ACL-filtered code chunks:

1. **Hosted answer API** — `POST /api/v1/code.ask` retrieves cited code and
   sends only that bounded context to the configured model.
2. **MCP retrieval** — `code.query`, `code.context`, and `code.get_file` let a
   connected user's LLM retrieve code and synthesize its own answer. The
   gateway never calls a model on this path.

Both paths receive the caller's bearer credential, use the same space grant,
and filter by imported code ACLs before a snippet can be returned.

## Local model

The hosted API speaks OpenAI-compatible `/chat/completions`, rather than using
a provider SDK. It therefore works with llama.cpp, Ollama's compatible API,
vLLM, and hosted compatible providers without a code change.

```sh
# Ollama — its OpenAI-compatible endpoint needs no adapter change
ollama serve &
ollama pull qwen2.5-coder:1.5b
export COMMONINDEX_LLM_BASE_URL=http://127.0.0.1:11434/v1
export COMMONINDEX_LLM_MODEL=qwen2.5-coder:1.5b

# or llama.cpp / vLLM / any compatible server
export COMMONINDEX_LLM_BASE_URL=http://127.0.0.1:8080/v1
export COMMONINDEX_LLM_MODEL=local-code-model

# Optional for local runtimes; required by providers that authenticate requests.
export COMMONINDEX_LLM_API_KEY=...
make dev-gateway
```

A small model is enough to verify the path works. It will not reason well about
a large flow, and that is fine — retrieval quality is what decides answer
quality here, and it is measured separately. What a small model *does* reliably
show is whether routing, ACL filtering, citations and the diagram contract hold
together end to end.

Two limits worth knowing before judging its output. A 1–4 GB model often ignores
a JSON contract, so `include_diagram` falls back to a plain answer rather than
failing — that path is tested. Observed with `qwen2.5-coder:1.5b`: it answers in
prose and leaves `diagram` null on most asks, and when it does honour the
contract it tends to wrap the JSON in a ```json fence, which is why the reply is
unfenced before it is parsed rather than being read as a refusal. And it will
follow a concrete instruction ("you were shown 2 files from 1 repository") far
better than an abstract one, which is why `code.ask` states the retrieval facts
in the prompt instead of telling the model to be careful.

**Do not use a small local model to test the MCP path.** There, tool-calling is
done by *your client's* model, not by anything configured here, and a small
model's unreliable tool use would look like a product failure that is not one.

`llama.cpp` is a practical 8 GB-machine runtime for an appropriately small
quantized GGUF model. Kimi K2.5 can use the same adapter when deployed behind
an OpenAI-compatible endpoint, but it is not an 8 GB local-model profile; do
not configure it as the default small-machine model.

## HTTP API

All routes require `Authorization: Bearer <token>` and an optional
`x-commonindex-space` header.

```sh
curl -X POST http://localhost:8000/api/v1/code.ask \
  -H "Authorization: Bearer $COMMONINDEX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"q":"How does a code pull become searchable?", "include_diagram":true}'
```

## Automatic repository routing

A question names no repository. `code.search` searches every repository the
caller may read, in one query, and reports which ones answered:

```json
{
  "selected_repos": [{"repo": "example/storefront", "files": 3, "score": 240.0}],
  "searched_repos": ["example/ledger", "example/storefront"],
  "routing": "searched 2 readable repositories; 1 answered...",
  "unindexed_repos": [], "degraded": null
}
```

Routing is deterministic and calls no model — Zoekt searches all shards at once,
so the hit distribution *is* the ranking. That matters for the MCP path: the
connected client's own LLM drives the hops, and it cannot do the routing itself
because it does not know which repositories exist or which this caller may see.

Authorization applies three times, on three mechanisms: the repository set is
built from the caller's grants, Zoekt is filtered to exactly that set, and every
hit is re-joined to `code_file` in Postgres with the ACL predicate on the same
statement. The third is not redundant — a shard is a snapshot, and a grant
revoked after indexing leaves an index that would still answer.

## Retrieval operations

| Operation | Purpose |
| --- | --- |
| `code.list_repos` | What the caller can search. Distinguishes "nothing matched" from "nothing indexed". |
| `code.search` | Routed search. Literals, regex, `sym:`, `file:`, `lang:`, `-exclude`. |
| `code.find_symbol` | Where a symbol is *defined*, with line range. |
| `code.find_references` | Where it is *used* — lexical matches, labelled as such. |
| `code.get_file` | Expand an indexed file by line range. |
| `code.query` | Deprecated alias for `code.search`. |

`code.context` returns a bounded pack for an external LLM. None of these call a
model.

## Lexical index

Set `COMMONINDEX_ZOEKT_URL` to enable Zoekt. Without it search falls back to
Postgres full-text and says so in `degraded` — `to_tsvector('english', body)`
stems source as English, so it will not unify `placeOrder` with `place_order`
and cannot express a regex. It is a fallback, not an equivalent.

```sh
docker compose up -d zoekt
make code-index REPOS="~/code/storefront ~/code/ledger"
export COMMONINDEX_ZOEKT_URL=http://127.0.0.1:6070
```

### Adding a repository by URL

An admin can index any https repository from the Code query page (**+ Add a
repository**) or over MCP with `code.index`:

```json
{"url": "https://github.com/org/repo", "branch": "main", "token": "…", "idempotencyKey": "…"}
```

The gateway keeps a shallow clone under `COMMONINDEX_CODE_CLONES` (default
`.code-clones/`), indexes it into Postgres, then builds its Zoekt shard with
`zoekt-git-index` — a binary on PATH with `COMMONINDEX_ZOEKT_INDEX_DIR`, or the
indexer image under Docker into `COMMONINDEX_ZOEKT_VOLUME` (default
`commonindex_zoekt-index`). The webserver picks the shard up without a
restart. Indexing the same URL again fetches into the clone and re-indexes what
changed. `code.list_repos` shows progress, and why an index failed, under
`indexing` (over MCP: a **Being indexed** table).

### Re-indexed on a schedule

Every repository indexed from the page, by URL or from a folder, is indexed
again by the job worker once it is due (`commonindex/workers/coderefresh.py`):
the clone is fetched, only the files that changed are re-indexed, and the
shard is rebuilt. Set the interval with `COMMONINDEX_CODE_REFRESH_SECONDS`
(default `3600`; `0` turns it off). A refresh runs as whoever indexed the
repository and grants nobody anything, so a read an admin revoked stays
revoked. A refresh that fails shows under `indexing` like any other.

A repository whose first index failed is not scheduled. Repositories listed in
`CODEQUERY_REPOS` are read through the GitHub API by the hourly CronJob
instead (`deploy/k8s/local/04-codequery-cronjob.yaml`).

With Zoekt in use, a repository's shard is built either by the worker
(`zoekt-git-index` on PATH, or Docker) or by a `zoekt-indexer` sidecar that
indexes every clone in the shared `code` volume (`COMMONINDEX_ZOEKT_SIDECAR=1`,
in both compose files) every `ZOEKT_EVERY_SECONDS` — 1800, 30 minutes, unless
`.env` sets it. Until its shard exists, search skips that repository
and names it in `unindexed_repos`; Postgres full-text is used only when Zoekt
is down or no readable repository has a shard.

- `branch` is optional; the repository's default branch is used without it.
- `token` is for a private repository. It is sent to the git host as a header,
  never logged or written into the clone's remote, and kept encrypted with
  `COMMONINDEX_SECRET_KEY` (in `code_sources`) so the scheduled re-index can
  fetch again; no operation returns it. Re-indexing without a token keeps the
  one held. `"keep_token": false` uses it once and forgets any kept token —
  the scheduled re-index of a private repository then fails and says so.
  Without a secret key it is never kept.
- Git runs without the operator's own git config, so a credential helper on
  the gateway's machine is never used to read a repository on a caller's
  behalf.
- Only https, no credentials in the URL, no redirects, and no hosts inside the
  network: the gateway dials this URL from inside it.

`COMMONINDEX_CODE_ROOTS` still allows indexing a clone's folder on the gateway's
machine instead of a URL.

`make code-index` writes both stores in one pass. Indexing them separately lets
the shard and the database disagree about a revision, which is what makes a
citation point at a line that has moved; a hit whose revision has drifted comes
back flagged `stale`.

## MCP

Start the stdio MCP process with the same database and caller token:

```sh
COMMONINDEX_TOKEN="$(uv run python scripts/mint_token.py <actor>)" make mcp
```

`make mcp` uses `DEV_DSN` (`postgresql://localhost/commonindex_dev`) and the Zoekt
on `127.0.0.1:6070`. Override the DSN when Postgres is the Compose container
rather than a local install:

```sh
export COMMONINDEX_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_dev
COMMONINDEX_TOKEN="$(COMMONINDEX_DSN=$COMMONINDEX_DSN uv run python scripts/mint_token.py maya)" \
  make mcp COMMONINDEX_DSN=$COMMONINDEX_DSN
```

The token must belong to an actor with a read grant on each repository — minting
prints the grants it found, and an actor with none searches nothing rather than
erroring. Use `make mcp-config` to print a client configuration. The MCP resource
`commonindex://skill/references/code-query.md` tells clients to use retrieval tools
for their own LLM and to preserve citations.

## The answer is a markdown document

`code.ask` returns the model's prose unchanged in `answer`, and the same answer
as a markdown document in `markdown`:

````markdown
# How does a code pull become searchable?

*Answered by `qwen2.5-coder:1.5b` from 3 file excerpt(s) in 1 of 2 searched repositories.*

## Answer

The cron worker pulls each configured repo…

## Flow — Pull to searchable

```mermaid
flowchart TD
%% title: Pull to searchable
  n0[/"codequery cron"/]
  n1["_upsert_code_file"]
  n2[("chunks")]
  n0 -->|"per repo"| n1
  n1 -->|"replace_code_chunks"| n2
```

## Sources

- `example/storefront/commonindex/workers/codequery.py:L88-L140`

## How this answer was reached

|  |  |
| --- | --- |
| Routing | searched 2 readable repositories; 1 answered |
| Engine | `zoekt` |
````

That document is what the web client renders, what the MCP transport returns,
and what `Download .md` writes — one rendering (`commonindex/adapters/codemd.py`)
rather than three views that drift. The retrieval operations render too:
`code.search` answers with its routing table above one `###` section per cited
excerpt, so `object_id`, `stale` and the routing survive into the text a
connected model actually reads. An operation with no renderer keeps its JSON,
and so does every error — a typed `code` and `field` are the actionable part of
a failure and prose around them would bury it.

Markdown is a channel where a stray fence or heading becomes document
structure, so model and repository text goes through the same `one_line` and
`fenced` primitives the generated skill uses. Two cases are worth naming: an
unterminated fence in an answer is closed (left open it swallows the sources,
the diagram and the routing), and a heading in an answer is demoted, so the
model cannot open a `## Sources` section of its own.

## Diagrams

`code.ask` accepts `include_diagram: true`. The model returns a bounded flow
data structure (`title`, nodes, edges) and the server validates it; the
mermaid fence is then written from the validated graph, with node ids
renumbered and labels escaped, so the model supplies the graph and the platform
spells the diagram. No model-provided HTML, CSS, SVG, JavaScript — or mermaid —
reaches a renderer: a mermaid fence inside the model's own prose is demoted
to a plain code block, because a diagram the validator never saw must not be
drawn just because it arrived in the right fence.

The web client draws the fence itself (`components/MermaidFlow.tsx`, from
`data/mermaid.ts`) rather than shipping a diagram engine: labels come from a
model and are rendered as SVG text nodes, node shape carries the kind of hop,
and a fence this parser cannot read renders as code instead of as half a
picture. Everywhere else — a file, a PR description, an MCP client — the same
fence is drawn by whatever already renders mermaid.
