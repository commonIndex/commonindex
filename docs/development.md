# Developing CommonIndex

How the code is laid out, how to run it from source, and the design records
behind it. To run the platform rather than work on it, see the
[README](../README.md) and [deploy.md](deploy.md).

## Design documents

| Document | What it is |
| --- | --- |

| [`backend/DESIGN.md`](../backend/DESIGN.md) | The system design — event log, ReBAC authorization, agent runtime, search, bridges |
| [`backend/mvp-schema.md`](../backend/mvp-schema.md) | What to create on day one — one Postgres, fourteen tables, and when to stop being simple |
| [`backend/context-plane.md`](../backend/context-plane.md) | How everything is indexed so agents and LLMs fetch context — chunking, hybrid retrieval, context packs |
| [`backend/human-agent-seam.md`](../backend/human-agent-seam.md) | Where the review loop breaks at high agent authorship — patterns, context receipts, agent questions, rejection signal |
| [`backend/evals-and-diagrams.md`](../backend/evals-and-diagrams.md) | Agent-generated diagrams as specs (the agent-evals half is removed from the platform; kept as a design record) |
| [`docs/code-query.md`](code-query.md) | Code retrieval and answers through HTTP or a user's own MCP-connected LLM |
| [`docs/code-query-zoekt-plan.md`](code-query-zoekt-plan.md) | Plan for permissive code search, symbol indexing, and multi-step flow retrieval |

## The data-context skill

`context.skill` generates an Agent Skill from the registry — which datasets
exist, what one row of each is, what its columns actually contain, which
definitions are ratified, and how each is queried on real dashboards. Install it
where Claude reads skills from:

```sh
make skill                                  # ./.claude/skills/warehouse-context
python scripts/install_skill.py --user      # ~/.claude/skills
make skill-zip                              # a .zip for claude.ai
```

It is a **snapshot of a registry that moves**, so re-run it after ratifying a
definition or building a dashboard. `.claude/skills/` is gitignored for the same
reason: a committed copy is the stale second source the whole design argues
against.


`datasets.profile` records what each column contains, which is the difference
between "`status` is sliceable" and "`status` is one of merged, rejected" — and
so between a filter that works and one that silently matches nothing.

## Experiments

`experiments.readout` computes an A/B result in the warehouse. The model is
the standard warehouse-native one: an **exposure table** joined to an
**outcome**, aggregated per variation, statistics over the summary. One
`GROUP BY` returning `(n, Σx, Σx²)` per arm is sufficient for both tests, and
leaves the aggregation where it belongs.

The join needs no new machinery — a virtual dataset is a saved query and a saved
query can contain a join, so an experiment dataset is one with a `variation`
column.

What this adds is a ratified metric. In the usual model a metric is defined
per experiment, so two experiments can measure "activation" differently and
nobody finds out. Here a readout may cite a **ratified** definition — the same
one the dashboards use, refused if nobody has stood behind it — and `better`
comes from that definition rather than being assumed. The same significant
movement is a win on conversion and a regression on latency; a readout that
guesses will congratulate you for the wrong one.

`commonindex/core/experiments/stats.py` is the statistics, in the standard library:
a normal CDF from `erf`, Student's t from a regularised incomplete beta, Welch's
test (which reduces to the two-proportion z on a binary outcome), and the delta
method for the relative-lift interval. Every function is pure over summary
statistics and checked against published table values.

**Intervals are always-valid by default**, which is the opposite of every
fixed-horizon tool and follows from what this platform is. A fixed-horizon
interval is valid for ONE look; daily peeking takes the real false-positive rate
from 5% to roughly 26%, and continuous monitoring past 30%. That is a footnote
for a human, who gets bored, and a design flaw for an agent, which does not — an
agent told to watch an experiment calls this every hour forever. A caveat in a
JSON response does not stop a loop, so the default has to be the safe one.

The method is Asymptotic Confidence Sequences (Waudby-Smith et al. 2023), and it
takes the same summary statistics. The
only difference is the multiplier on the standard error: a t critical value for
one look, a `√log N`-growing one for any number of looks. On the demo experiment
that is `[+7.7%, +26.2%]` fixed against `[+2.1%, +31.8%]` always-valid: wider,
and the width is what buys the freedom to look.

Still absent, and named in every response rather than omitted quietly: CUPED,
multiple-comparison adjustment, ratio metrics (which need a `Σxy` term), and
quantile metrics. Each changes the number, so shipping one silently would be
worse than not having it.

## The frontend

`web/` is the product UI — Vite + React + TypeScript, virtualized collections
proven at hundreds of objects. `src/data/api.ts` is seeded in the browser;
`src/data/gateway.ts` is the seam where the real backend plugs in, and the
dashboards collection mixes both: a warehouse-backed dashboard is a row beside
the seeded ones, badged, and its range control re-queries Postgres rather than
slicing something already fetched.

`/dashboards/new` builds a dashboard from a table: connect a database, pick a
table introspected by SQLAlchemy, compose a panel as a sentence, and watch the
preview run against the warehouse on every change. Creating it writes each
definition into the metric registry — ratified if a person authored it,
proposed if a propose-only agent did.

The design system is "the ledger": paper surfaces on a warm mineral desk, a mono
voice for anything addressable, violet reserved for agents, ink for the one
committing action on a screen. Tokens are at the top of `web/src/styles.css`.


## Skeleton

A Python skeleton of the backend, structured from the LLD. Packages, types and
signatures; every body raises `NotImplementedError`. `make check` runs ruff and
the test suite, which is where the architectural guards live.

```
commonindex/                            the OPEN substrate (P1)
  core/                          the engine — names no collection
    registry/                    the type registry: schema, presenting, facets, measures, prose, relations
    graph/                       objects and provenance edges
    eventlog/                    append, consume, replay
    authz/                       ReBAC + imported ACLs
    proposals/                   file, merge, pattern grouping, receipts
    retrieval/                   chunk, embed, hybrid search, context.pack
    ops/                         one registry; every protocol target reads it
    warehouse/                   dashboards — dialects, query builder
  adapters/                      vendor-specific: semantic-layer response shapes
  gateway/                       http.py and mcp.py, both from ops.Registry
  workers/                       indexer, linker, identity, aclcrawl, inbox, scorecards
    connectors/                  slack, github — read-only, no write method exists
  runner/                        sandboxed agent runs
commonindex_enterprise/                 the PAID half: SSO/SCIM, audit export, residency, BYOK, trust governance
migrations/                      0001 core (16 tables) · 0002 dashboards (5 tables)
types/                           registry entries — adding a collection is one of these
tests/test_core_isolation.py     the guards
```

### Why Python

The trigger was the dashboards: Go has no SQLAlchemy, so the
warehouse layer needed a hand-written engine spec per database. Python already
had connection, pooling and introspection across fifty engines, and sqlglot for
dialect emission — leaving only the ~40% no library covers. That was
the sixth Python-shaped component after the linker, the pattern grouper, the
reranker, exact token counting for context receipts, and F4's dbt adapter.

The runner is the weakest fit and is noted as such in place; Firecracker's
orchestration ecosystem is Go-heavy.

### Running it

```sh
make dev-db                    # create commonindex_dev, migrate, seed 400 proposals + 300 runs
make dev-gateway               # serve it on :8000
cd web && npm install && npm run dev   # the UI, on :5173
```

`commonindex_dev` is a **different database from the one the tests use**, and that is
load-bearing: `tests/db.py` opens every integration run with
`drop schema public cascade`, which destroys whatever a running gateway was
serving. Found the hard way — `pytest -q` emptied the dashboards the UI had open.

### Run Code Query locally

Code Query uses a hybrid local setup: Postgres runs in Docker, while the
gateway, web UI, and MCP server run as local processes. Start the database:

```sh
docker compose up -d db
```

For the disposable Compose database used in local Code Query testing, apply
migrations once, then start the gateway on port 8002:

```sh
COMMONINDEX_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_test \
  uv run python scripts/migrate.py

COMMONINDEX_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_test \
  uv run uvicorn commonindex.gateway.app:app --host 127.0.0.1 --port 8002 --reload
```

In a second terminal, start the UI and open `http://localhost:5173/code`:

```sh
cd web
VITE_GATEWAY_URL=http://127.0.0.1:8002 \
VITE_COMMONINDEX_TOKEN=<your bearer token> \
  npm run dev -- --host 127.0.0.1 --port 5173
```

To enable hosted answers (`code.ask`), point the gateway at any
OpenAI-compatible local or hosted model endpoint:

```sh
export COMMONINDEX_LLM_BASE_URL=http://127.0.0.1:8080/v1
export COMMONINDEX_LLM_MODEL=your-local-model
export COMMONINDEX_LLM_API_KEY=optional
```

The MCP server is a local stdio process that Codex starts on demand; it shares
the same Postgres database and caller token. Register it once:

```sh
codex mcp add commonindex \
  --env COMMONINDEX_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_test \
  --env COMMONINDEX_TOKEN=<your bearer token> \
  --env COMMONINDEX_SECRET_KEY="$(uv run python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')" \
  -- "$(command -v uv)" run --project "$(pwd)" python -m commonindex.gateway.mcp_server

codex mcp list
```

Start a new Codex session after registration to access `code.query`,
`code.context`, and `code.get_file`. The code operations answer with a markdown
document rather than JSON — a routing summary, a section per cited excerpt, and
the flow as a mermaid diagram when one was asked for — so a client renders the
answer instead of showing a blob to read past. See
[`docs/code-query.md`](code-query.md).

To index local clones for Code Query, point the indexer at them. It drives the
same connector, transaction and tombstone logic the hourly cron does, and
grants the actor read on each repo — indexing a repo and being allowed to read
it are separate facts, and without the grant a search returns nothing:

```sh
export COMMONINDEX_DSN=postgresql://commonindex:commonindex@localhost:5433/commonindex_test
uv run python scripts/index_repos.py --actor maya                # this repo
uv run python scripts/index_repos.py ~/code/storefront ~/code/ledger
```

Re-running is cheap: unchanged files are skipped by content hash, so a second
pass over an untouched clone indexes nothing and emits no events. Repo
identity comes from the clone's `origin`, so a repo indexed from disk keeps
the same id — and the same grants — when the GitHub connector later takes over.

Index several genuinely different repositories. Automatic repo routing is what
that corpus exercises, and repos that all say the same thing cannot show that
routing chose correctly.

The dev database registers *itself* as a warehouse connection, so
`/dashboards/new` has real tables with real rows to build a panel on without
anyone bringing a warehouse first.

### Running the tests

```sh
make test-unit          # 61 tests, no database needed
make db-up              # local Postgres 17 + pgvector
make test-integration   # 14 tests: migrations from zero, then real queries
```

`docker compose up -d db` is the alternative, pinned to `pgvector/pgvector:pg17`
on port 5433 so it never collides with a local install. Integration tests skip
themselves when no database is reachable, so `make test` is safe anywhere.

Every integration run **applies the migrations to an empty schema**. That is
slower than reusing state and it is the point: a migration that only works on top
of yesterday's database will fail in production, and applying from zero is the
only way to find out.

### Warehouses

| Engine | Spec | Driver | Proven |
| --- | --- | --- | --- |
| Postgres | ✅ | `asyncpg` — async | ✅ tier C, 14 tests |
| DuckDB | ✅ | `duckdb-engine` — **sync** | ✅ 6 tests |
| SQLite | ✅ | `aiosqlite` — async | ✅ 6 tests |
| BigQuery | ⚠️ see below | `sqlalchemy-bigquery` — sync | ✗ needs an account |
| Snowflake | ✅ | `snowflake-sqlalchemy` — sync | ✗ needs an account |

**Most analytical warehouse dialects are sync-only** — BigQuery, Snowflake and
DuckDB all are, while Postgres and SQLite are the exceptions. So
`DirectWarehouseSource` runs sync dialects in a worker thread, and the async path
is the special case rather than the default. That is the reverse of what "any of
fifty engines" suggests, and it is checked by `ASYNC_DRIVERS`.

SQLite is included deliberately as the stress case: it has **no `DATE_TRUNC`**,
so its grains are `strftime` expressions. If the grain interface had quietly
assumed Postgres, it would fail there rather than in production on someone's
warehouse.

**BigQuery is not finished.** It has three truncation functions chosen by column
type — `TIMESTAMP_TRUNC`, `DATETIME_TRUNC`, `DATE_TRUNC` — and picking wrong is a
type error. `bucket(grain, col)` only receives the expression, so it cannot
choose; `BIGQUERY_DATE` exists as a second spec and nothing selects between them.

### The guards

Six tests, not a grep. The Go version used `! grep -rn`, which passed on plurals,
on case changes, on string concatenation, and — silently — when the directory it
searched did not exist.

| Test | Enforces |
| --- | --- |
| `test_core_names_no_collection` | No collection name in `commonindex.core`, singular or plural, case-folded, including concatenations. Names come from `types/*.json`, so the list cannot go stale. |
| `test_core_does_not_branch_on_type` | Bans the *shape* — a `match` on `.type` is per-collection behaviour even when it spells no name. |
| `test_core_does_not_import_outward` | The engine may not reach into the surfaces built on it. |
| `test_open_substrate_does_not_import_paid` | P1: `commonindex_enterprise` may import `commonindex`, never the reverse. |
| `test_adapters_do_not_branch_on_collection_type` | Adapters may name vendors — that is what they are for — but per-collection *behaviour* still belongs nowhere. |
| `test_types_directory_is_readable`, `test_core_package_exists` | Guard the guard — a rename must fail loudly rather than pass by vacuity. |

