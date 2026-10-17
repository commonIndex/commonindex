# The human/agent seam — where the loop breaks at volume

> **Design record.** This document records design reasoning from mid-2026. Parts of it describe plans that changed or were not built (for example SpiceDB, Temporal, Firecracker and GraphQL). For what exists today, see [backend/README.md](README.md), the code, and [docs/development.md](../docs/development.md).

Companion to `DESIGN.md` §9 (agent runtime). The architecture
makes agents first-class principals and gives them the same API as humans. What it does not yet
design is the *seam* — the moment agent work meets human judgment. Every gap below lives there.

## The premise that breaks

The PRD targets **50% of merged changes agent-authored by day 90**, and the inbox is "a review
queue, not a notification feed." Both are right. Together they are a contradiction nobody has
costed: at 50% agent authorship, a queue that hands a human one decision at a time makes the human
the bottleneck the product was built to remove. The digest in §7.1 is a receipt for work already
done inside granted trust, not a review affordance for work awaiting it.

Everything else here follows from taking that number seriously.

## Gaps, in order of what they cost

### 1. The unit of review is the instance, not the edit — **built**

An agent that files one change across fourteen docs produces fourteen inbox rows. The human reads
the same diff fourteen times and, on the eleventh, stops reading. That is not a UI annoyance; it is
how a reviewer's attention gets spent on repetition and runs out before the one case that mattered.

The fix is to make the **pattern** the reviewable object: proposals that share an edit shape group
into one decision with N targets. Merging emits one event per target, so each stays individually
undoable and the audit trail is unchanged. Critically, anything that deviates is **lifted out by
name** — a batch that quietly swallows its exceptions teaches reviewers to stop trusting batches,
which costs more than the batching saved.

### 2. A proposal arrives with no record of what the agent read — **built**

`context.pack` assembles a working set within a token budget, in priority order. Nothing keeps that
pack with the proposal it produced. So reviewing agent output means re-deriving its reasoning from
scratch — slower than doing the work yourself, which is the failure mode that kills adoption.

The **receipt** keeps the pack: what was retrieved, at what rev, at what token cost. The section
that earns it is **what did not fit**. An agent that read the wrong thing is rare. An agent that
never saw the one object that would have changed its mind is the ordinary failure, and today it is
invisible in every surface we have. A reviewer who can see "the exception decision D-31 fell off the
end of the budget" diagnoses in seconds what otherwise looks like an agent being wrong for no reason.

The receipt also carries a **withheld count** — objects that matched retrieval but sat outside the
agent's grants. Counted, never named: the count is not the leak, and it tells a reviewer whether the
agent was working blind for permission reasons rather than budget ones.

### 3. An agent that hits ambiguity fails instead of asking — **built**

§9's failure path is "bounded retries, then a blocked run lands in the owner's inbox with the trace
attached." The only outcome of ambiguity is a dead run and a human redoing the work by hand. But
most real ambiguity is one question wide: *two ratified sources disagree, which is authoritative?*

A **question** makes that a paused run rather than a failed one. It costs a human a minute instead
of a redo. Two properties matter:

- It must carry **the conflicting evidence**, not just the question. That is what shows the agent was
  right to stop rather than guess and file a confident edit.
- The answer must land in **a durable object** — a superseding decision, a catalogue entry, a metric
  deprecation — not in a chat reply. Otherwise the same question is asked again next week, and the
  human learns that answering agents is a treadmill.

### 4. Rejection carries no signal — **built**

Proposals are pending · merged · rejected. A rejection lowers an acceptance rate and teaches the
skill nothing. "Wrong on the merits," "right but out of scope," and "needs a decision first" are
three completely different corrections: the first is an eval case, the second narrows a trigger, the
third should re-queue the pattern behind a decision. Recording which one it was is nearly free and is
the only thing that makes `evals-and-diagrams.md`'s replayed history worth replaying.

### 5. Agent memory is invisible and uncorrectable — **not built**

§9 gives each agent "per-agent KV + embedding store, distinct from the org graph." Nothing in the
product shows what an agent believes, where it learned it, or lets a human correct it. If Scribe has
internalised a convention that was superseded in March, the remedy today is nothing — you cannot see
the belief, so you cannot argue with it. This should be inspectable, attributable to the event that
taught it, and correctable by the same propose-and-merge path as everything else. It is the largest
remaining trust gap and the natural next build.

### 6. There is no "view as agent" — **not built**

§5 says "what can Scribe see?" is a reverse expansion, sub-millisecond against the authz service.
That query is already there. Rendering the workspace through it — the collections, the search
results, the context rail, exactly as one agent sees them — turns agent behaviour from mysterious
into inspectable, at close to zero architectural cost. It is the cheapest large trust win available.

### 7. Cost and latency are invisible at the point of asking — **not built**

Runs record `cost_tokens` and `cost_usd` after the fact. A human about to trigger agent work sees
neither the projected cost nor the expected latency, so budgets are something you discover you
exceeded. The backtest service already projects cost for promotion decisions; the same estimate
belongs on the button.

### 8. A run cannot be steered, only killed — **not built**

A human watching a run go down the wrong path has one control: pause, which revokes its grants. The
missing middle is a mid-run correction that becomes part of the trace — closer to "actually, use the
staging config" than to a kill switch. This is the hardest of the eight to get right and the least
urgent; it matters at autonomous tier, not at propose-only.

## What ties them together

Four of these are already objects rather than affordances, which is what keeps them replayable,
auditable, and undoable like everything else in the log: a pattern is a grouping over proposals, a
receipt is the pack that produced an edit, a question is a paused run, a rejection reason is an
event. The remaining four are the same shape of idea applied to memory, visibility, cost, and
control.

One line: the platform designs beautifully for agents to *act* and humans to *review*, and barely at
all for the two to *meet* — so build the seam as objects, and the review loop scales with agent
throughput instead of collapsing under it.
