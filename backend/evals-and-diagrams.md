# Agent evals and generated diagrams

> **Design record.** This document records design reasoning from mid-2026. Parts of it describe plans that changed or were not built (for example SpiceDB, Temporal, Firecracker and GraphQL). For what exists today, see [backend/README.md](README.md), the code, and [docs/development.md](../docs/development.md).

Two capabilities, one theme: both reuse primitives CommonIndex already has instead of growing new subsystems.

## 1. Agent evals — which agent works best with which LLM

> **Removed from the platform (2026-10-05).** The Agent evals screen showed sample data only;
> nothing replayed history. This section is kept as a design record; §2, diagrams, is current.

### The insight: the event log is an eval dataset that writes itself

Every proposal an agent files gets a human verdict — merged unchanged, edited then merged,
or rejected. That verdict, with the full trigger context, is a labeled datapoint. A workspace
that has run for three months has thousands of them, per agent, for free. No hand-built
golden sets, no separate eval harness to keep in sync with production.

### Mechanism: the backtest engine with a different knob

`DESIGN.md` §11 already specifies replaying an event window through a sandboxed agent to
preview a *trust tier* change. Evals are the same replay with the *model* varied:

```
eval(agent, window, models[]) →
  for each model m:
    replay triggers through agent config with model=m (sandbox, no real writes)
    score each output:
      agreement   — did it reach the human's recorded verdict?
      judge       — rubric score from an LLM judge (clarity, correctness, scope)
      cost, p50   — token accounting per run (runs table already tracks this)
  → eval object {agent, window, per-model scores}, linked to every replayed trigger
```

Results are objects with provenance. **Adopting a winner is a proposal**: a model-routing
policy change ("Triage → compact class in all spaces"), ratified like any decision, applied
by the model router (§9), reversible like everything else.

### Continuous evals in production

Propose-only agents are always reviewed, so live traffic keeps generating labels. The router
can run a small exploration share (e.g. 5% of runs on a candidate model); scorecards segment
by model automatically since every run records which model served it. New model ships →
bench it against your own history the same day, with zero eval-set curation.

### What to watch

- **Judge bias:** the LLM judge is a tiebreaker, never the headline number. Agreement with
  human verdicts is the primary metric precisely because it can't be gamed by style.
- **Distribution shift:** replayed windows age; evals report the window they ran on and
  re-run on a schedule.
- **Per-task-class routing:** the right answer is often split (frontier for rewrites,
  compact for lint-class fixes) — the router keys on (agent, task class, space).

## 2. Generated diagrams — docs → visuals everyone can see

### The rule that makes it safe: agents emit specs, never markup

When an agent turns a complex distributed-architecture doc into a flow diagram, it outputs a
**declarative spec** — nodes, edges, kinds, labels — and CommonIndex's renderer draws it. The agent
(any model) never produces HTML/JS. Four reasons:

1. **Security.** Arbitrary agent-authored HTML rendered org-wide is an XSS/exfiltration
   vector. A spec rendered by trusted code has no script surface.
2. **Reviewability.** A diagram change is a spec diff inside a normal proposal — reviewers
   see "added node: risk-svc; edge pay→risk" plus a visual before/after, not a blob diff.
3. **Freshness.** The spec's sources are provenance edges. When a source doc section changes,
   the diagram flips to `stale` and the docs gardener proposes a regeneration — same loop
   as spec-drift today.
4. **Consistency.** Deterministic rendering means the same object looks identical in the doc,
   the thread embed, and the dashboard — and theming/brand is CommonIndex's, not per-model.

### The object

```
diagram {
  sources[]      — object refs + sections (provenance edges, drive staleness)
  generated_by   — agent + model class + run ref (trace inspectable)
  spec           — nodes/edges/kinds, schema-validated (flow | sequence | state | er …)
  rev, status    — versioned like a doc; edits are proposals
}
```

Embeds anywhere as a block (like charts); ACL is the object's ACL, so "everyone in the org
can see it" is just membership. Diagram types are schema additions, not new subsystems —
same long-tail-object pattern as decisions and policies (`DESIGN.md` §3).

### Escalation path

Flow/sequence/state diagrams cover most architecture communication. When a visual needs
interactivity beyond a static render (click-through runbooks, live status overlays), that's
the v2+ Canvas layer: still spec-driven, rendered into a sandboxed iframe with a scoped
MCP token — the same trust model as agents themselves.

## Where they live in the UI

- **Agent evals:** its own collection view (sidebar, under Agents) — per-agent model matrix,
  recommendation, "Adopt" files the routing proposal. Implemented in `web/` at `/evals`.
- **Diagrams:** blocks inside docs (see `/docs/doc-rfc` in `web/` for the working example),
  embeddable in threads and dashboards like any object.
