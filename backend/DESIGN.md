# CommonIndex — Backend Design

> **Design record.** This document records design reasoning from mid-2026. Parts of it describe plans that changed or were not built (for example SpiceDB, Temporal, Firecracker and GraphQL). For what exists today, see [backend/README.md](README.md), the code, and [docs/development.md](../docs/development.md).

Technical design for the unified human + agent workspace

v0.3 draft · July 12, 2026 · CommonIndex


## 1. Design tenets

  - Event-sourced single graph: the append-only event log is the source of truth; the graph, indexes, and inbox are read models over it.

  - Agents are principals: one identity/permission machinery for humans and agents; agent capability differs only by grants and tier.

  - UI/API parity: one operation registry, exposed as GraphQL (UI) and MCP (agents); parity enforced in CI.

  - Relationship-based authorization (ReBAC): permissions are tuples over the same graph the product exposes.

  - Replayability: any state is reconstructible from the log; backtests, audit, and disaster recovery are the same machinery.

  - The space is the unit of tenancy, partitioning, ordering, and policy.

## 2. Architecture overview

Two symmetric entry points — the human client (web/desktop, local-first) and agent sandboxes — converge on one API gateway backed by the authorization service. Core services (graph, sync, git, proposal) validate and persist mutations, each of which appends an event. Consumers of the log (search indexer, entity linker, agent scheduler, inbox, scorecards) maintain read models. Storage: Postgres (entities, events, tuples), object store (blobs, run IO), git object store, and index shards (vector + inverted).

> client (web/desktop, CRDT) agent sandboxes (Firecracker)
> 
> \\ /
> 
> one API gateway (GraphQL + MCP) ── authz (ReBAC)
> 
> |
> 
> graph · sync · git · proposal services
> 
> |
> 
> event log (per-space total order)
> 
> |
> 
> search · linker · scheduler · inbox · scorecards · bridges
> 
> |
> 
> Postgres · S3 · git store · index shards

## 3. Data model

Hot-path concepts get dedicated tables; long-tail object types (decision, chart, meeting, request, policy) are typed objects with schema-validated props, so adding an object type is data, not migration.

> actors (id, kind human|agent, display, owner\_id, trust\_tier)
> 
> spaces (id, org\_id, name, policy jsonb)
> 
> memberships(actor\_id, space\_id, role)
> 
> objects (id, type, space\_id, current\_rev, props jsonb)
> 
> revisions (object\_id, rev, author\_id, delta, ts)
> 
> edges (src, rel, dst, created\_by, ts) -- provenance
> 
> events (space\_id, seq, actor\_id, verb, object\_id,
> 
> payload jsonb, ts) -- append-only
> 
> grants (subject, relation, resource, expires\_at, budget)
> 
> proposals (id, target\_id, base\_rev, delta\_kind crdt|gitref|props,
> 
> delta, author\_id, status, decided\_by, decided\_at)
> 
> runs (id, agent\_id, trigger\_event, status, cost\_tokens, cost\_usd)
> 
> run\_steps (run\_id, n, tool, input\_ref, output\_ref, objects\_touched)
> 
> metrics (name, version, definition, status proposed|ratified,
> 
> ratified\_by\_decision)
> 
> backtests (id, agent\_id, tier, window, results jsonb)
> 
> bridge\_map (connector, external\_id, object\_id, etag)

Scorecards are materialized views over events and proposals, recomputed incrementally; they are not written by hand and cannot drift from the log.

## 4. Event log

Events carry (space\_id, seq) with a total order per space — strong enough for replay and audit, loose enough to scale horizontally by space. Implementation: Postgres outbox in the same transaction as the mutation, fanned out through NATS JetStream to consumers. Retention is indefinite; periodic snapshots bound replay time. GDPR erasure uses crypto-shredding of blob keys plus tombstone events rather than log rewrites. The replay API (used by backtests, new read models, and DR) streams any window of any space.

## 5. Authorization

SpiceDB-style relationship tuples: subject → relation → resource, with inheritance org → space → container → object. Agent scopes are ordinary tuples with two extra dimensions: expiry and budget. Checks happen at the gateway on every operation; search results are filtered by ACL keys stored in the index and re-verified at read. “Can Scribe propose on this doc?” is one tuple check; “what can Scribe see?” is a reverse expansion — both sub-millisecond against a dedicated authz service with a consistency token to avoid the new-enemy problem.

## 6. API and MCP gateway

A single operation registry defines every mutation and query once; codegen emits the GraphQL schema for the client and the MCP tool manifest for agents. A CI rule fails the build if a UI action lacks a registered operation — parity is structural, not aspirational. All mutations take idempotency keys. Rate limits and budgets are enforced per actor.

|                                               |                                                      |
| --------------------------------------------- | ---------------------------------------------------- |
| **Operation**                                 | **Notes**                                            |
| object.read / object.create                   | Reads honor ACL; creates emit events                 |
| object.propose → proposal.file                | The only write path for propose-only actors          |
| proposal.merge / reject                       | Tier- and scope-checked; merge applies delta by kind |
| thread.reply, decision.raise, decision.ratify | Quorum rules from space policy                       |
| search.query                                  | Hybrid retrieval, ACL-filtered, citations included   |
| chart.create, metric.propose                  | Metric resolution only against ratified definitions  |
| grant.request / approve                       | Approval chains advance on grant events              |
| events.subscribe                              | Trigger source for agents; filtered by scope         |

## 7. Docs, sync, and git

Documents are Yjs CRDTs; the sync service handles websockets, presence, and awareness. On quiescence, CRDT state compacts into a revision row, so live editing and git-style history coexist. The git service (gitaly-like) hosts repos; a PR is a proposal whose delta is a ref pair, and merging executes through the git backend then appends the same proposal.merge event as any doc merge — one review model across code and prose.

## 8. Search and knowledge plane

Indexers consume the log with a seconds-level freshness SLO. Retrieval is hybrid — Tantivy BM25 plus embedding vectors (pgvector to start, dedicated store at scale) — fused and reranked. The entity linker (rules plus a small model) writes edges at ingest time: PR ↔ thread ↔ doc ↔ decision. ⌘K answers run retrieval, then synthesize with mandatory citations; answers about drifted state (e.g., a spec with a pending sync proposal) surface the pending proposal rather than silently choosing a side.

## 9. Agent runtime

  - Scheduler: matches events against trigger subscriptions (event patterns, mentions, cron); enforces per-agent concurrency and budgets before starting runs.

  - Sandbox: Firecracker microVM per run; no network except the MCP gateway and allow-listed connectors; short-lived token minted from the agent’s tuples.

  - Model router: policy-driven model class per task (triage-class vs frontier-class), BYO keys per org; per-run token and dollar accounting into runs.cost.

  - Memory: per-agent KV + embedding store, distinct from the org graph; anything an agent wants to assert into shared knowledge goes through a proposal like everyone else.

  - Failure: bounded retries, then a blocked run lands in the owner’s inbox with the trace attached; escalation is an event.

## 10. Scorecards and promotion

Materialized from events: proposals filed/merged/rejected, undo-after-merge rate, median review wait, cost. Space policy sets thresholds (e.g., ≥90% acceptance over 90 days). Crossing a threshold flags eligibility; promotion requires a clean backtest and a human ratification, recorded as a trust.promote event. Regression triggers automatic demotion per policy — also an event, also reversible.

## 11. Backtest service

Given (agent, target tier, window): replay the window’s events into a shadow space; run the agent with simulated tier; capture would-be writes in the shadow store; diff against what humans actually did. External connector calls replay from recorded IO where available and are skipped-and-flagged otherwise — a backtest never touches the outside world. Output: agreement rate, would-have-merged set, boundary violations attempted (expected: zero), cost projection. Results attach to the promotion request.

## 12. Meetings pipeline

Media lands in the object store → ASR provider produces a transcript object with speaker turns and timestamps → an extraction agent files decision and task drafts as proposals anchored to transcript ranges → drafts appear in the inbox for ratification. Nothing extracted becomes real without a human accept; accepted items carry provenance back to the exact seconds of audio.

## 13. Requests and approvals

A request object carries a chain specification — an ordered list of approvers or roles, each step with an SLA timer. The engine advances on grant events, escalates on timeout, and short-circuits on deny. Because steps are events, approval history is audit-grade for free. Long-running orchestration (chains, bridge syncs, backtests) runs on Temporal.

## 14. Charts and metrics

The metric registry holds versioned definitions; only ratified versions resolve at query time, so natural-language questions cannot silently invent semantics. NL→query binds to the registry and a semantic-layer adapter (dbt metrics / Cube) before any SQL is generated; execution goes through read-only MCP connectors to the customer warehouse. Results cache (default 15 minutes); every embed renders from the object so the same chart shows the same number everywhere; snapshots preserve what a chart showed at cited moments.

## 15. Bridges

Per-connector sync workers (chat, code hosting, docs, ticketing, email) maintain bridge\_map rows (external\_id ↔ object\_id, etag). Ingest is webhook-incremental with periodic reconciliation backfills; writes out are idempotent upserts. Conflict policy: the external system wins for objects it owns; CommonIndex wins for CommonIndex-native objects; conflicts surface as proposals rather than silent overwrites. Bridges are the migration on-ramp and are staffed accordingly.

## 16. Security and compliance

  - Tenancy: org-level isolation with per-space partitions; row-level security as defense in depth.

  - Encryption at rest everywhere; BYOK on the enterprise roadmap; secrets in a dedicated KMS-backed store.

  - DLP hooks subscribe to the event stream (redaction agents are just propose-only agents with a narrow scope).

  - Audit export: signed slices of the event log; eDiscovery and legal hold fall out of log immutability.

  - Data residency: space-pinned storage regions (later); model calls routable to region-local endpoints.

## 17. Reliability and scale

Read models per surface keep hot paths simple: inbox, board, and dashboards are incrementally maintained projections. Postgres shards by space; the log compacts via snapshots. Target SLOs: event → index visibility p95 \< 2s; gateway reads p99 \< 150ms; agent trigger → run start p95 \< 5s. DR is log replay into a fresh region; RPO bounded by log replication lag.

## 18. Technology choices

|                          |                                             |                                            |
| ------------------------ | ------------------------------------------- | ------------------------------------------ |
| **Concern**              | **Choice**                                  | **Rationale**                              |
| Entities, events, tuples | PostgreSQL                                  | One trustworthy store; outbox pattern; RLS |
| Event fan-out            | NATS JetStream                              | Simple ops; per-subject ordering; replay   |
| Authorization            | SpiceDB (Zanzibar model)                    | ReBAC matches the product graph exactly    |
| Doc collaboration        | Yjs                                         | Mature CRDT; offline-first clients         |
| Code hosting             | libgit2 / gitaly-style service              | Proven git plumbing                        |
| Search                   | Tantivy + pgvector → dedicated vector store | Hybrid retrieval; start simple             |
| Agent sandboxes          | Firecracker                                 | Strong isolation, fast start               |
| Orchestration            | Temporal                                    | Approval chains, bridges, backtests        |
| Blobs / run IO           | S3-compatible store                         | Cheap, versioned, region-pinnable          |

## 19. Key flows

  - **Write:** client op → authz check → revision + event in one transaction → index, inbox, and triggers update within seconds.

  - **Agent run:** event matches trigger → budget check → sandbox with scoped token → MCP calls → proposal filed → trace persisted → inbox.

  - **Merge:** human (or tier-authorized agent) merges → delta applied by kind → event → provenance edges → scorecards update.

  - **Promotion:** threshold crossed → backtest → human ratifies → trust.promote event → tuples updated; demotion is the mirror image.

  - **Meeting:** media → transcript object → extraction proposals → ratified items link back to timestamp ranges.

## 20. Open questions

  - Self-hosted model endpoints for regulated buyers, and how the router abstracts them.

  - Cross-org shared spaces: tuple namespaces and event-log ownership across trust boundaries.

  - When pgvector stops being enough, and which dedicated vector store earns the migration.

  - How deep connector sandboxing must go for third-party MCP servers in the app platform.

  - Whether code review comments should move onto CRDTs for live co-review.
