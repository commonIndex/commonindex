# Code Query: Zoekt, Tree-sitter, and multi-step retrieval

## Decision

Adopt permissively licensed components for code intelligence while retaining
CommonIndex as the authority for repository ownership, ACLs, citations,
events, and MCP/API contracts.

| Concern | Decision | Why |
| --- | --- | --- |
| Lexical / regex search | [Zoekt](https://github.com/sourcegraph/zoekt) | Apache-2.0 trigram code search; mature cross-repository recall without implementing an indexer or query engine. |
| Parsing and symbols | [Tree-sitter](https://github.com/tree-sitter/tree-sitter) | MIT-licensed incremental parser; supplies symbol boundaries, imports, and line ranges. |
| Semantic retrieval | Existing Postgres + pgvector initially | Keeps current ownership and ACL-aware metadata in one database. Revisit Qdrant only when scale requires it. |
| Answering | Configured model or the MCP client's model | Retrieval is model-independent. CommonIndex never requires one vendor. |
| Authorization | CommonIndex Postgres grants + imported ACLs | Zoekt must never make an authorization decision. It is a candidate generator only. |

## Product behavior

The normal question needs no repository identifier:

```text
Explain the dashboard creation flow in this codebase, with source citations.
```

The planner searches every repository the caller may read, selects relevant
repositories automatically, traces the flow across files and symbols, and
returns a bounded evidence pack. `repo_id`, path, language, and a named scope
remain optional narrowing controls, not required inputs.

```text
Question
  → ACL-filtered repository routing
  → Zoekt lexical / regex recall across candidates
  → pgvector semantic recall
  → reciprocal-rank fusion + reranking
  → Tree-sitter symbol, import, definition, and reference expansion
  → bounded, line-cited context pack
  → configured model OR MCP client's model
  → answer and optional declarative flow diagram
```

## Boundaries

### CommonIndex owns

- Repository connection configuration and source-health objects.
- Imported ACLs, grants, tenant/space filtering, and staleness rules.
- `code_repo`, `code_file`, `code_symbol`, chunks, provenance edges, events,
  revisions, citations, and context receipts.
- Query planning, token/character budgets, audit records, API/MCP operations,
  and diagram validation/rendering.

### Zoekt owns

- Search shards generated from already-authorized-to-index file versions.
- Fast candidate recall for terms, regexes, language filters, paths, and
  repository/branch filters.

Zoekt results are always joined back to `code_file` rows and re-authorized in
Postgres before any body reaches an API response or an LLM. A shard hit alone
never grants access.

### Tree-sitter owns

- Parsing supported source languages.
- File-level symbol boundaries, kinds, signatures, imports, and line spans.

Tree-sitter output is treated as derived index data, not source of truth. A
parse failure falls back to safe line chunks and is observable as index health.

## Data model

1. Extend `code_repo` with source URL, branch, index generation, Zoekt shard
   generation, parser coverage, and index health timestamps.
2. Add `code_symbol` objects or a `code_symbols` table with `repo_id`,
   `file_id`, `name`, `qualified_name`, `kind`, `signature`, `start_line`,
   `end_line`, `language`, and content hash.
3. Add derived edges: `imports`, `defines`, `references`, and `calls` where a
   language extractor can establish them. All inferred edges carry confidence.
4. Store a repository summary and path/package summaries as chunks for routing.
5. Preserve code-file chunks as the durable citation source. Zoekt documents
   carry file path, repo id, branch, SHA, and file-id metadata so results can
   be resolved back to those chunks.

## Ingestion plan

### Phase 1 — reliable file and symbol index

1. Finish real GitHub/local-git pull support and tombstone deleted files.
2. On each changed file, write its object/revision/event in the existing
   transaction.
3. Parse changed source with Tree-sitter; emit symbols and imports. Fall back
   to line chunks when a grammar is unavailable or parsing fails.
4. Replace only that file's Postgres chunks/symbols and enqueue its Zoekt shard
   update. Content hashes make both steps idempotent.
5. Record per-repo index generation and health. Queries fail closed for stale
   ACLs and visibly report stale content/indexes.

### Phase 2 — Zoekt service

1. Run Zoekt as a dedicated internal service with persistent shard storage.
2. Add an adapter that submits changed repository revisions and queries Zoekt.
3. Never expose Zoekt directly outside the gateway; only the gateway maps hits
   to ACL-filtered CommonIndex objects.
4. Start with one local repository fixture, then measure recall/latency before
   indexing production repositories.

## Retrieval planner

Implement `code.explore(q, scope?, budget?)` as a deterministic server-side
operation. It does not call a model, making it suitable for MCP clients that
bring their own LLM.

1. **Route repositories.** Search readable repo metadata, summaries, paths,
   and initial global Zoekt hits. Select the top candidates; search all
   readable repos if confidence is low.
2. **Generate retrieval queries.** Use the original question plus deterministic
   identifier/path heuristics. A configured planner model may add query
   variants later, but is not required for v1.
3. **Recall.** Query Zoekt and Postgres vector/FTS over selected repos. Fuse
   hits with reciprocal-rank fusion and retain source-specific scores.
4. **Expand.** Read surrounding lines, containing symbols, import targets, and
   high-confidence definitions/references. Stop at a fixed hop and token limit.
5. **Package evidence.** Return ordered snippets, source citations, selected
   repositories, omitted-result counts, routing rationale, index freshness,
   and a clear insufficiency result when evidence is weak.

The planner must never silently exceed the caller's ACLs, context budget, or
expansion-hop limit.

## API and MCP

| Operation | Caller | Purpose |
| --- | --- | --- |
| `code.query` | UI / MCP | Fast direct search; repo filter optional. |
| `code.get_file` | UI / MCP | ACL-filtered line-range expansion. |
| `code.explore` | UI / MCP | Automatic multi-repo, multi-hop evidence pack. |
| `code.ask` | UI / MCP | Runs `code.explore`, then asks the configured compatible model. |
| `code.context` | Compatibility alias | Becomes a thin wrapper around `code.explore`. |

For MCP, publish instructions requiring the client's LLM to call `code.explore`
before claiming a cross-file flow, preserve citations, and state when the pack
is insufficient. The MCP path does not require CommonIndex to call a
model.

## Diagrams

Only generate a diagram after an answer has cited enough source evidence. The
model returns bounded node/edge data; the server validates it; the web client
renders trusted HTML/CSS. Diagram sources store the exact cited files/symbols,
so a changed source marks the diagram stale.

## Security and operations

- Apply space and caller ACL filters before routing, retrieval, expansion, and
  model submission.
- Re-check each Zoekt hit against the current file object and its ACL keys.
- Do not put source text, bearer tokens, or provider keys in logs.
- Encrypt provider credentials; allow only server-configured credentials for
  the hosted-answer path.
- Cap result count, files per expansion, hops, body bytes, and model timeout.
- Report index/ACL freshness and withheld result counts with every response.

## Evaluation and rollout

1. Build a curated evaluation set of flow, ownership, entry-point, and
   cross-repository questions with expected citations.
2. Measure retrieval recall before judging generated answers: correct answer
   quality cannot exceed the evidence pack.
3. Compare current single lexical search against FTS + vector fusion, then
   against Zoekt + Tree-sitter expansion.
4. Shadow-run planner results for a small set of repositories; log only IDs,
   rankings, timing, and evaluator judgments.
5. Release `code.explore` to MCP first, then UI, then enable `code.ask` behind
   an explicit compatible-model configuration.

## Acceptance criteria

- A user can ask a flow question with no repository id.
- Only repositories/files authorized for that caller are searched or returned.
- A cross-file flow answer cites each material claim by repository, path, SHA,
  and line range.
- The system exposes selected repositories, expansion steps, and evidence
  limits instead of pretending a one-file result is a complete flow.
- A changed file updates its Postgres metadata, Tree-sitter symbols, and Zoekt
  search representation idempotently.
- Tests prove ACL isolation, stale-index behavior, routing without `repo_id`,
  symbol expansion, citation validity, and diagram-source provenance.

## Open decisions before implementation

1. Run Zoekt in Docker Compose now or only in Kubernetes?
2. Which initial language grammars are mandatory: Python, TypeScript/TSX,
   JavaScript, SQL, and YAML are recommended for this repository.
3. Should repo scopes be inferred from repository metadata first, manually
   administered first, or both?
4. Which model is allowed to generate optional query variants for the hosted
   path, and should that be disabled by default for privacy-sensitive tenants?
