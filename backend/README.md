# Design records

The documents in this folder record how the platform was designed and why.
They were written before and during the build, so parts describe plans that
changed or were never built. Read them for the reasoning; read the code and
[docs/](../docs/) for what exists.

## What exists today

| Area | Built | Planned in these records, not built |
|---|---|---|
| Storage | One Postgres database (with pgvector) for every object, event, revision and permission | — |
| Authorization | Grants in Postgres (subject, relation, resource), checked on every request; admins see their whole workspace | A SpiceDB relationship service |
| API | RPC over HTTP (`POST /api/v1/<operation>`) and the same operations as MCP tools, from one registry | A GraphQL schema for the web client |
| Background work | A job queue in Postgres, run by a worker process | Temporal workflows |
| Agents | Agents as members with tokens, propose-only trust, an inbox; a reference agent process | Firecracker micro-VMs for running agent code |
| Search | Postgres full-text search, semantic search with a configured embedding model, and Zoekt for code | — |
| Connectors | GitHub and local git repositories (code search), Slack | Most other connectors described |

## The records

- [DESIGN.md](DESIGN.md): the overall system design.
- [mvp-schema.md](mvp-schema.md): the first database schema.
- [context-plane.md](context-plane.md): how content is indexed and retrieved.
- [human-agent-seam.md](human-agent-seam.md): where review breaks down when agents write a lot.
- [evals-and-diagrams.md](evals-and-diagrams.md): agent-generated diagrams.
