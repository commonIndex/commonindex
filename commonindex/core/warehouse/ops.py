"""Dashboard operations, registered into the one operation registry.

Everything here becomes an HTTP route and an MCP tool from the same definition,
which is the contract tests/test_parity.py holds down. Panels are objects, so
list/get/propose come from the generic type registration — these are the verbs
that are specific to querying.
"""

from __future__ import annotations

from typing import Any

from commonindex.core.ops import Op, Registry
from commonindex.core.warehouse.build import OPS
from commonindex.core.warehouse.dashboard import MARKS, RANGES, TO_DATE

#: The one range control, as an argument. An agent asking for a panel's numbers
#: picks from the same three windows a person can, so the two cannot quote
#: periods the other has no way to reproduce.
#: Generated from the table itself. Written out by hand, the schema an agent
#: reads and the windows the server accepts were two lists that agreed only by
#: inspection — and the one an agent trusts is this one.
_RANGE = {"type": "string",
          "description": "A preset, a calendar period to date, or a span of dates with both "
                         "ends included, like 2026-08-01..2026-08-31.",
          "anyOf": [{"enum": [*RANGES, *TO_DATE]},
                    {"pattern": r"^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$"}]}

#: A WHERE clause, as data. The operator is a name from a closed table, never a
#: SQL fragment, so an agent composing a filter cannot compose a predicate.
_FILTERS = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "dimension": {"type": "string"},
            # Derived, for the same reason as the range above: this list and
            # the table the compiler checks against were two hand-kept copies.
            "op": {"type": "string", "enum": sorted(OPS)},
            "values": {"type": "array"},
            # Which panels this filter is for. Absent means every panel whose
            # dataset declares the column, which is right almost always — this
            # is for two tables that share a column NAME meaning two different
            # things. It narrows what the dataset would have allowed and never
            # widens it.
            "panels": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["dimension", "op"],
    },
}
_MARK = {"type": "string", "enum": list(MARKS)}
_SORT = {"type": "string", "enum": ["bucket", "value_desc", "value_asc"]}
# Closed, so a misspelt `better` is refused at registration rather than dropped
# and the guardrail read the wrong way round for the life of the experiment.
_GUARDRAIL = {"type": "object", "required": ["outcome"], "additionalProperties": False,
              "properties": {"outcome": {"type": "string"}, "metric_id": {"type": "string"},
                             "metric_version": {"type": "integer"},
                             "binary": {"type": "boolean"},
                             "better": {"type": "string", "enum": ["up", "down"]}}}
_AGG = {"type": "string", "enum": [
    "count", "sum", "avg", "min", "max", "count_distinct", "ratio", "share"]}


def register(reg: Registry) -> None:
    reg.register(Op(
        name="panels.query",
        relation="read",
        description=(
            "Run one panel and return its series. The window comes from the "
            "dashboard's range control, never from the panel."
        ),
        input_schema={
            "type": "object",
            "properties": {"panel_id": {"type": "string"}, "range": _RANGE},
            "required": ["panel_id"],
        },
    ))

    reg.register(Op(
        name="columns.values",
        relation="read",
        description=(
            "What a column actually contains, so a filter can be CHOSEN rather "
            "than typed blind — the values with their row counts, or for a "
            "number the range it spans. Bounded: a GROUP BY with a LIMIT over "
            "the dashboard's own window, and it says when it truncated rather "
            "than presenting the top N as the whole set."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "dashboard_id": {"type": "string"},
                "column": {"type": "string"},
                "range": _RANGE,
                "limit": {"type": "integer", "minimum": 1, "maximum": 500},
                "space_id": {"type": "string"},
            },
            "required": ["dashboard_id", "column"],
        },
    ))

    reg.register(Op(
        name="dashboards.render",
        relation="read",
        description=(
            "Run every panel on a dashboard against ONE window, and return the "
            "certification alongside. Panels bound to an unratified metric say "
            "so rather than looking like the trustworthy ones."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "dashboard_id": {"type": "string"}, "range": _RANGE,
                # The filter bar. A READING choice, like the range beside it:
                # slicing to one region does not change what a metric means, so
                # it does not touch certification. Every panel reports which of
                # these it could apply and which it could not, because a
                # dashboard where two of six cards silently ignored the filter
                # looks exactly like one where all six honoured it.
                "filters": _FILTERS,
                "compare": {"type": "boolean",
                            "description": "Also run each panel over the window of the same "
                                           "length just before, returned as `previous`."},
            },
            "required": ["dashboard_id"],
        },
    ))

    _ACCESS = {"type": "object", "properties": {}}

    reg.register(Op(
        name="people.list",
        relation="read",
        description=(
            "The humans in this workspace, and how many agents each already "
            "answers for. An agent has to name one to exist, and accountability "
            "spread across one person is a name on a form rather than an "
            "arrangement."
        ),
        input_schema={"type": "object", "properties": {}},
    ))

    reg.register(Op(
        name="agents.create",
        relation="admin",
        mutating=True,
        description=(
            "Bring an agent into existence: the actor, a grant, and a token, in "
            "one transaction. Creating the actor meant an INSERT and minting a "
            "token meant a script on the box — only the middle step was an "
            "operation, so permissions were administrable and identity was not. "
            "The token comes back ONCE; only its SHA-256 is stored."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "agent_id": {"type": "string",
                             "description": "appears in `created_by` on everything it makes"},
                "display": {"type": "string"},
                # An agent answers to a PERSON. A CHECK cannot read another row,
                # so the handler enforces it — without which the accountability
                # chain can close on itself.
                "owner_id": {"type": "string",
                             "description": "the human answerable for its conduct — "
                                            "whoever creates it, when not given"},
                "trust_tier": {"type": "string",
                               "enum": ["propose-only", "auto-merge-minor", "autonomous"]},
                "grant": {
                    "type": "object",
                    "description": "what it may do, and where. Without one it can "
                                   "authenticate and do nothing.",
                    "properties": {
                        "relation": {"type": "string",
                                     "enum": ["read", "propose", "merge", "admin"]},
                        "resource": {"type": "string"},
                        "days": {"type": "integer", "minimum": 1},
                    },
                },
                "token_label": {"type": "string"},
                "expires_days": {"type": "integer", "minimum": 1},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["agent_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="agents.revoke",
        relation="admin",
        mutating=True,
        description=(
            "Turn an agent off: every token destroyed, every grant removed. The "
            "actor row is KEPT — it is the attribution target for everything the "
            "agent ever made, and an agent whose history has been deleted is a "
            "governance hole wearing the word 'revoked'."
        ),
        input_schema={
            "type": "object",
            "properties": {"agent_id": {"type": "string"},
                           "idempotencyKey": {"type": "string"}},
            "required": ["agent_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="agents.ask",
        relation="propose",
        mutating=True,
        description=(
            "Ask an agent to do something about an object. Written as an EVENT — "
            "the append-only log already carries who acted, on what, and in what "
            "order, and a queue of its own would be a second history. Nothing is "
            "started: the agent reads this when it next connects, which is the "
            "only honest arrangement when the thing that runs it is a process "
            "this platform does not own and cannot wake."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "agent_id": {"type": "string"},
                "object_id": {"type": "string",
                              "description": "what it is about; optional"},
                "note": {"type": "string",
                         "description": "what you are asking for. An agent reading "
                                        "`asked` with no words has been tagged, "
                                        "not asked."},
                "space_id": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["agent_id", "note", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="agents.inbox",
        relation="read",
        description=(
            "What an agent has been asked and has not started. Defaults to the "
            "caller — an agent connects with its own token and asks what it "
            "should be doing. `Not started` is the absence of a run against that "
            "event rather than a flag on the ask: `runs.trigger_seq` already says "
            "which event a run answers."
        ),
        input_schema={
            "type": "object",
            "properties": {"agent_id": {"type": "string"}, "space_id": {"type": "string"}},
        },
    ))

    reg.register(Op(
        name="runs.start",
        relation="propose",
        mutating=True,
        description=(
            "Claim an ask. One run per event, which is what stops two workers on "
            "the same ask both thinking they have it."
        ),
        input_schema={
            "type": "object",
            "properties": {"trigger_seq": {"type": "integer"},
                           "space_id": {"type": "string"},
                           "idempotencyKey": {"type": "string"}},
            "required": ["trigger_seq", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="runs.finish",
        relation="propose",
        mutating=True,
        description=(
            "Say how it went and what it cost. `asking` is a real ending and not "
            "a failure: an agent that stopped to put a question to a person has "
            "done the right thing, and the status has said so since 0001."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "status": {"type": "string", "enum": ["done", "blocked", "asking"]},
                "cost_tokens": {"type": "integer", "minimum": 0},
                "cost_usd": {"type": "number", "minimum": 0},
                "space_id": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["run_id", "status", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="agents.list",
        relation="read",
        description=(
            "Every agent, and what the record actually says about each: who "
            "answers for it, what it may do in this space, when its token was "
            "last used, and what it has authored. Read from `actors`, `grants`, "
            "`actor_tokens` and `objects` — there were no agent operations at "
            "all, and the page was generated in the browser."
        ),
        input_schema={"type": "object", "properties": {"space_id": {"type": "string"}}},
    ))

    reg.register(Op(
        name="agents.get",
        relation="read",
        description=(
            "One agent, with its grants and authorship in full, and the most "
            "recent objects it made — which is the honest version of an "
            "activity feed while `events` has never been written to."
        ),
        input_schema={
            "type": "object",
            "properties": {"agent_id": {"type": "string"},
                           "space_id": {"type": "string"}},
            "required": ["agent_id"],
        },
    ))

    reg.register(Op(
        name="actors.me",
        relation="read",
        description=(
            "Who the caller is and which relations they hold in this space — "
            "read < propose < merge < admin, cumulatively. For a client to say "
            "'mine' and to offer only actions the gateway would allow."
        ),
        input_schema={"type": "object", "properties": {"space_id": {"type": "string"}}},
    ))

    reg.register(Op(
        name="access.list",
        relation="admin",
        description=(
            "Who can do what, and whether each grant has ever been used. This is "
            "the recertification query: a reviewer approving access normally sees "
            "names and cannot tell a load-bearing grant from one issued for a "
            "migration that finished last year. `never_used` and `idle_days` are "
            "that difference. Pass never_used:true for the revocation queue."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "resource": {"type": "string"},
                "never_used": {"type": "boolean"},
            },
        },
    ))

    reg.register(Op(
        name="access.grant",
        relation="admin",
        mutating=True,
        description=(
            "Give an actor a relation on a resource. Relations are ordered — "
            "admin > merge > propose > read — so the stronger one satisfies "
            "everything below it. `days` is optional, but a grant with no expiry "
            "is reported as such: permanent access should be a decision somebody "
            "made, not what happens when nobody chose."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "relation": {"enum": ["read", "propose", "merge", "admin"]},
                "resource": {"type": "string",
                             "description": "space:<id> or object:<id>"},
                "days": {"type": "integer", "minimum": 1},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["subject", "relation", "resource", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="access.revoke",
        relation="admin",
        mutating=True,
        description="Take a grant away. Idempotent — revoking twice is not an error.",
        input_schema={
            "type": "object",
            "properties": {"id": {"type": "string"},
                           "idempotencyKey": {"type": "string"}},
            "required": ["id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="access.tokens",
        relation="admin",
        description=(
            "Credentials in circulation — who holds one, when it was last used, "
            "when it lapses. Never their secrets: only a hash is stored, so this "
            "cannot return anything the reader could authenticate with."
        ),
        input_schema={"type": "object",
                      "properties": {"actor_id": {"type": "string"}}},
    ))

    reg.register(Op(
        name="access.revoke_token",
        relation="admin",
        mutating=True,
        description=(
            "Kill one credential. The actor keeps its grants — the difference "
            "between losing a laptop and leaving."
        ),
        input_schema={
            "type": "object",
            "properties": {"id": {"type": "string"},
                           "idempotencyKey": {"type": "string"}},
            "required": ["id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="metrics.list",
        relation="read",
        description=(
            "Definitions available to cite, from the metric registry — not from "
            "the object graph, which holds no metrics. Scoped by dataset when "
            "asked, because a metric's expression is written in one dataset's "
            "column names and citing it from another cannot compile."
        ),
        input_schema={
            "type": "object",
            "properties": {"space_id": {"type": "string"},
                           "dataset_id": {"type": "string"}},
        },
    ))

    reg.register(Op(
        name="metrics.ratify",
        relation="merge",
        mutating=True,
        description=(
            "Ratify a metric definition. A decision with an owner and a quorum, "
            "not a settings toggle — it re-renders every panel citing it and "
            "lands in the log as one event."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "metric_id": {"type": "string"},
                "version": {"type": "integer"},
                "decision_id": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["metric_id", "version", "decision_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="datasets.introspect",
        relation="read",
        description=(
            "Discover what a connection can be queried on. Tier A reads the "
            "semantic layer's metadata; tier B uses SQLAlchemy's Inspector."
        ),
        input_schema={
            "type": "object",
            "properties": {"connection_id": {"type": "string"}},
            "required": ["connection_id"],
        },
    ))

    reg.register(Op(
        name="connections.list",
        relation="read",
        description=(
            "The warehouses this space can build a panel on. Credentials are "
            "never returned — a connection carries a host and a database, and "
            "its secret stays behind a KMS handle."
        ),
        input_schema={
            "type": "object",
            "properties": {"space_id": {"type": "string"}},
        },
    ))

    reg.register(Op(
        name="panels.preview",
        relation="read",
        description=(
            "Run a definition that is being authored, before it exists as a "
            "metric. The authoring exception to 'only ratified definitions "
            "resolve': the expression is passed in, so there is no id to cite "
            "and no saved panel can be served from here."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "connection_id": {"type": "string"},
                "dataset_id": {"type": "string"},
                "agg": _AGG,
                "column": {"type": "string"},
                "denominator": {"type": "string"},
                "value": {},
                "filters": _FILTERS,
                "limit": {"type": "integer", "minimum": 0, "maximum": 5000},
                "sort": _SORT,
                "mark": _MARK,
                "grain": {"type": "string", "enum": ["day", "week", "month", "none"]},
                "dimension": {"type": "string"},
                "unit": {"type": "string", "enum": ["count", "pct", "currency", "duration"]},
                "range": _RANGE,
            },
            "required": ["connection_id", "dataset_id", "agg"],
        },
    ))

    reg.register(Op(
        name="dashboards.ai_edit",
        relation="propose",
        description=(
            "Propose an edit to an existing dashboard from an instruction: panels to add, "
            "remove or redefine in place, and a new title if asked. Sends the current panels "
            "and the source's column metadata to the configured model -- never rows or "
            "credentials -- and checks every new panel against the source. Saves nothing; "
            "apply with panels.add / panels.remove / panels.reorder / dashboards.update."
        ),
        input_schema={
            "type": "object",
            "properties": {"space_id": {"type": "string"},
                           "dashboard_id": {"type": "string", "minLength": 1},
                           "instruction": {"type": "string", "minLength": 1, "maxLength": 4000}},
            "required": ["dashboard_id", "instruction"],
        },
    ))

    reg.register(Op(
        name="dashboards.generate",
        relation="propose",
        description=(
            "Suggest up to six draft dashboard panels from an instruction and a selected "
            "table or saved SQL dataset. Sends only permitted source metadata to the configured "
            "model, never rows or credentials. Does not execute queries or save anything. "
            "Review with panels.preview, then explicitly save with dashboards.create."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "space_id": {"type": "string"},
                "connection_id": {"type": "string", "minLength": 1, "maxLength": 200},
                "dataset_id": {"type": "string", "minLength": 1, "maxLength": 300},
                "instruction": {"type": "string", "minLength": 1, "maxLength": 4000},
                "time_column": {"type": ["string", "null"], "maxLength": 160},
                "range": {"type": "string", "enum": list(RANGES)},
            },
            "required": ["connection_id", "dataset_id", "instruction"],
        },
    ))

    reg.register(Op(
        name="dashboards.create",
        relation="propose",
        mutating=True,
        description=(
            "Create a dashboard from a table. Every panel's definition is "
            "written down as a PROPOSED metric, never inlined on the panel — so "
            "the new dashboard starts uncertified and says why on its own face, "
            "rather than looking exactly like the reviewed ones."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "space_id": {"type": "string"},
                "connection_id": {"type": "string"},
                "dataset_id": {"type": "string"},
                "panels": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "mark": _MARK,
                            "agg": _AGG,
                            "column": {"type": "string"},
                            "denominator": {"type": "string"},
                            "value": {},
                            "filters": _FILTERS,
                            "limit": {"type": "integer", "minimum": 0, "maximum": 5000},
                            "sort": _SORT,
                            "grain": {"type": "string"},
                            "dimension": {"type": "string"},
                            "unit": {"type": "string"},
                            "better": {"type": "string", "enum": ["up", "down"]},
                        },
                        "required": ["title", "mark", "agg"],
                    },
                },
                "idempotencyKey": {"type": "string"},
            },
            "required": ["title", "connection_id", "dataset_id", "panels", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="dashboards.update",
        relation="propose",
        mutating=True,
        description="Rename a dashboard. The panels are edited through panels.add and panels.remove.",
        input_schema={
            "type": "object",
            "properties": {"dashboard_id": {"type": "string"}, "title": {"type": "string"},
                           "idempotencyKey": {"type": "string"}},
            "required": ["dashboard_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="dashboards.delete",
        # `merge`, not `propose`. The propose tier exists to hold back
        # changes somebody else should stand behind — `_may_ratify` is built
        # around exactly that — and it could delete a whole dashboard and every
        # panel on it. The line is reversibility at your own tier: a removed
        # panel can be added back with `panels.add`, which is `propose`, and a
        # deleted dashboard cannot be undeleted by anything.
        relation="merge",
        mutating=True,
        description=(
            "Tombstone a dashboard. Its metric definitions are left alone — a "
            "definition may be cited by panels elsewhere, and deleting one is a "
            "governance act, not a side effect of tidying a page away."
        ),
        input_schema={
            "type": "object",
            "properties": {"dashboard_id": {"type": "string"},
                           "idempotencyKey": {"type": "string"}},
            "required": ["dashboard_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="panels.add",
        relation="propose",
        mutating=True,
        description=(
            "Add a panel to an existing dashboard. Pass metric_id to CITE a "
            "definition that already exists, or agg/column to write a new one. "
            "Citing is what stops N dashboards inventing N definitions of the "
            "same number."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "dashboard_id": {"type": "string"},
                "title": {"type": "string"},
                "mark": _MARK,
                # Which dataset this panel reads. Defaults to the dashboard's,
                # and naming another is how one dashboard mixes a table with a
                # saved query.
                "dataset_id": {"type": "string"},
                # cite an existing definition ...
                "metric_id": {"type": "string"},
                # ... or author a new one, with the same arguments create takes
                "agg": _AGG, "column": {"type": "string"},
                "denominator": {"type": "string"}, "value": {},
                "unit": {"type": "string"}, "better": {"type": "string", "enum": ["up", "down"]},
                "grain": {"type": "string"}, "dimension": {"type": "string"},
                "filters": _FILTERS, "limit": {"type": "integer"}, "sort": _SORT,
                # A panel may read a different warehouse from its dashboard.
                # `dashboards.render` runs one query per panel, so nothing has
                # to join across them.
                "connection_id": {"type": "string"},
                # A panel may carry its own SELECT instead of citing a
                # definition. The dashboard holding one is reported
                # uncertified, which is true — nobody has stood behind that
                # number — and is how the escape hatch stays visible.
                "sql": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["dashboard_id", "title", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="panels.resize",
        relation="propose",
        mutating=True,
        description=(
            "Set how wide and how tall each panel is. `span` "
            "existed only on the client and was derived from the mark and the "
            "number of charts — a decent guess that cannot know which panel is "
            "the point of the page. Send `{panel_id: columns}`; send null to "
            "put one back on the heuristic."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "dashboard_id": {"type": "string"},
                "spans": {
                    "type": "object",
                    "description": "panel id -> columns out of 12, or null for automatic",
                    "additionalProperties": {
                        "anyOf": [{"type": "integer", "minimum": 2, "maximum": 12},
                                  {"type": "null"}],
                    },
                },
                # Where it starts across the twelve columns; null keeps the flow.
                "cols": {
                    "type": "object",
                    "description": "panel id -> starting column 1..12, or null to follow the panel before it",
                    "additionalProperties": {"anyOf": [{"type": "integer", "minimum": 1, "maximum": 12},
                                                       {"type": "null"}]},
                },
                # Pixels of PLOT, not grid rows. The grid's rows are auto-sized
                # to their content, so a row unit would be a unit whose size
                # depends on what happens to be in the row beside it.
                "heights": {
                    "type": "object",
                    "description": "panel id -> plot height in pixels, or null for the default",
                    "additionalProperties": {
                        "anyOf": [{"type": "integer", "minimum": 160, "maximum": 900},
                                  {"type": "null"}],
                    },
                },
                "space_id": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["dashboard_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="panels.reorder",
        relation="propose",
        mutating=True,
        description=(
            "Put the panels in the order they should be read. `position` has "
            "ordered the render since the first migration and was only ever set "
            "at insert, so a dashboard was stuck in the order its panels were "
            "created in. Send the WHOLE order: a drag is one intent, and "
            "applying it as pairwise moves leaves the stored order briefly "
            "neither old nor new."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "dashboard_id": {"type": "string"},
                "panel_ids": {"type": "array", "items": {"type": "string"},
                              "description": "every panel on the dashboard, in order"},
                "space_id": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["dashboard_id", "panel_ids", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="panels.remove",
        relation="propose",
        mutating=True,
        description="Remove a panel from a dashboard. Its metric definition survives.",
        input_schema={
            "type": "object",
            "properties": {"panel_id": {"type": "string"},
                           "idempotencyKey": {"type": "string"}},
            "required": ["panel_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="datasets.create_virtual",
        relation="propose",
        mutating=True,
        description=(
            "Save a SELECT as a dataset — a 'virtual dataset'. The "
            "query decides which ROWS exist; metrics on it still go through "
            "the registry, so what a number MEANS is still ratified."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "connection_id": {"type": "string"},
                "name": {"type": "string"},
                "sql": {"type": "string"},
                "time_column": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["connection_id", "name", "sql", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="datasets.preview_sql",
        relation="read",
        description=(
            "Run a SELECT and return a few rows and their inferred column "
            "kinds, without saving anything. The step before saving a virtual "
            "dataset: see the shape before committing to it."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "connection_id": {"type": "string"},
                "sql": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
            "required": ["connection_id", "sql"],
        },
    ))

    reg.register(Op(
        name="connections.create",
        relation="admin",
        mutating=True,
        description=(
            "Register a warehouse. The credential is passed once and stored "
            "behind a handle; it is never written to the connection row, never "
            "becomes an object, and is never returned by any read."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                # Every engine the compiler can emit. Opening one still needs
                # its driver installed, which is a deployment question rather
                # than a platform one.
                "kind": {
                    "type": "string",
                    "enum": ["postgres", "bigquery", "snowflake", "duckdb", "sqlite",
                             "mysql", "mariadb", "redshift", "clickhouse",
                             "databricks", "trino", "mssql"],
                },
                "host": {"type": "string"},
                "port": {"type": "integer"},
                "database": {"type": "string"},
                "user": {"type": "string"},
                "password": {"type": "string"},
                "impersonation": {"type": "boolean"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["name", "kind", "database", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="datasets.describe",
        relation="propose",
        mutating=True,
        description=(
            "Write the reference documentation for a dataset: what one row IS, "
            "what it covers, and what to know before trusting it. The part of "
            "the context no generator can produce, and the part that decides "
            "whether a COUNT means what the reader thinks."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "grain_note": {"type": "string"},
                "description": {"type": "string"},
                "caveats": {"type": "string"},
                "metric_id": {"type": "string"},
                "metric_description": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="datasets.profile",
        # `read`, and it WRITES — it stores the profile on the dataset row.
        # A read grant is the tier that may look at a dashboard; it should not
        # be the tier that can rewrite dataset metadata for everyone, or start
        # a full scan of a warehouse fact table on demand.
        relation="propose",
        mutating=True,
        description=(
            "Scan a dataset and record what it holds: how many rows, what period "
            "they cover, and the values each categorical column actually takes. "
            "The last of those is what turns 'status is sliceable' into "
            "'status is one of merged, rejected' — the difference between a "
            "filter that works and one that silently matches nothing."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "connection_id": {"type": "string"},
                "dataset_id": {"type": "string"},
                # The window to profile over. `build.py` states the rule this
                # was breaking: "an unbounded scan of a warehouse fact table is
                # how a dashboard becomes a billing incident, so a caller
                # cannot opt out by omitting the window." This ran one
                # COUNT(*) and up to ten GROUP BYs with no window at all.
                "range": _RANGE,
                "idempotencyKey": {"type": "string"},
            },
            "required": ["connection_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="experiments.readout",
        relation="read",
        description=(
            "Read out an experiment: split a dataset by its variation column, "
            "aggregate the outcome per arm, and test the difference. The "
            "outcome must cite a RATIFIED definition — two experiments "
            "measuring the same thing measure it the same way, which is the "
            "part a per-experiment metric cannot promise. Intervals are "
            "always-valid by default, so this is safe to poll."
        ),
        input_schema={
            "type": "object",
            "properties": {
                # Either name a pre-registered experiment and inherit its
                # contract, or describe the readout directly. The first is
                # held to what was registered; the second is exploratory and
                # says so in the response.
                "experiment_id": {"type": "string"},
                "connection_id": {"type": "string"},
                "dataset_id": {"type": "string"},
                "variation": {"type": "string"},
                # Split every arm by a second dimension. One query, grouped by both.
                "cohort": {"type": "string"},
                "outcome": {"type": "string"},
                "binary": {"type": "boolean"},
                # The unit of randomisation. Without it, n counts rows.
                "unit": {"type": "string"},
                "unit_agg": {"type": "string",
                             "enum": ["sum", "max", "min", "avg", "count"]},
                "cap": {"type": "number"},
                "null_is_zero": {"type": "boolean"},
                "control": {"type": "string"},
                # A column name, or the column with its own shape and direction:
                # support contacts going UP is the regression, and a rate is not
                # an amount. Read as a bare name, both were guessed.
                "guardrails": {"type": "array", "items": {"anyOf": [
                    {"type": "string"}, _GUARDRAIL]}},
                # outcome column -> the ratified definition it measures, which is
                # where 'better' comes from.
                "metric_ids": {"type": "object"},
                "alpha": {"type": "number", "minimum": 0.0001, "maximum": 0.5},
                # `sequential` and `tuning` used to be here, and on a
                # pre-registered experiment they are refused now: they select
                # the error-control regime, and reading a confidence sequence
                # as a fixed-horizon interval turns "no difference detected"
                # into "better" on the same counts. They belong to the
                # contract, and an ad-hoc readout with no contract still names
                # them below.
                "sequential": {"type": "boolean"},
                "tuning": {"type": "integer", "minimum": 100},
                # The split the experiment was DESIGNED for, arm -> weight.
                # Only needed when it is not even, but then it is essential:
                # a 90/10 holdout checked against an assumed 50/50 fails its
                # sample-ratio check every single time.
                "weights": {"type": "object"},
                # Keep what this readout said, as an object with an edge to
                # its experiment. Deliberate rather than automatic: a readout is
                # recomputed on every page load, and recording each one turns an
                # audit trail into a traffic log.
                "record": {"type": "boolean"},
                "range": _RANGE,
            },
            "anyOf": [
                {"required": ["experiment_id"]},
                {"required": ["connection_id", "dataset_id", "variation", "outcome"]},
            ],
        },
    ))

    reg.register(Op(
        name="experiments.srm",
        relation="read",
        description=(
            "Check the assignment before trusting the numbers: count units per "
            "arm and test that split against the one the experiment was designed "
            "for. A mismatch does not mean the traffic was slightly uneven, it "
            "means something also decided WHO is in each arm, so every lift "
            "computed across it is measuring that filter. Cheap enough to call "
            "first, and it is folded into experiments.readout so a clean-looking "
            "readout cannot be obtained from a broken assignment."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "connection_id": {"type": "string"},
                "dataset_id": {"type": "string"},
                "variation": {"type": "string"},
                # The unit of randomisation. Without it this counts ROWS, and a
                # chi-square scales linearly in N -- k rows per user multiplies
                # the statistic by k and fails an even split.
                "unit": {"type": "string"},
                "weights": {"type": "object"},
                # 0.001, not 0.05: this runs on every poll, and at 0.05 a healthy
                # 50/50 test cries wolf about once in twenty checks.
                "threshold": {"type": "number", "minimum": 1e-12, "maximum": 0.5},
                "range": _RANGE,
            },
            "required": ["connection_id", "dataset_id", "variation"],
        },
    ))

    reg.register(Op(
        name="experiments.suggest",
        relation="read",
        description=(
            "Look at a table and say whether an experiment was recorded in it: "
            "which column holds the version (a few values repeated many times), "
            "which identifies the person (close to unique per row), and what "
            "there is to measure. One scan. Asking an author these questions "
            "about their own data is how somebody picks an id column by mistake."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "connection_id": {"type": "string"},
                "dataset_id": {"type": "string"},
                "space_id": {"type": "string"},
                "range": _RANGE,
            },
            "required": ["connection_id", "dataset_id"],
        },
    ))

    reg.register(Op(
        name="experiments.history",
        relation="read",
        description=(
            "What an experiment has said over time, newest first — the question "
            "a live readout cannot answer. Each row is what the numbers were "
            "when somebody recorded them, so a verdict that changed, or a "
            "sample-ratio check that began failing halfway through, is visible "
            "as a sequence instead of as a single current state."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "experiment_id": {"type": "string"},
                "space_id": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
        },
    ))

    reg.register(Op(
        name="experiments.register",
        relation="propose",
        mutating=True,
        description=(
            "Pre-register an experiment: name the dataset, the arm column, the "
            "unit of randomisation, the outcome and the guardrails, and pin the "
            "metric version in force right now. Every column is checked against "
            "the real dataset here, so a contract that cannot compile is refused "
            "at registration rather than three weeks later. Once running, the "
            "contract can only be changed on the record."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "experiment_id": {"type": "string"},
                "name": {"type": "string"},
                "hypothesis": {"type": "string"},
                "owner": {"type": "string"},
                # Draft, or already running. Stopping and deciding have their
                # own operations, which check who is asking.
                "status": {"enum": ["draft", "running"]},
                "started_at": {"type": "string", "format": "date-time",
                               "description": "When traffic really began, for an "
                                              "experiment registered while already "
                                              "running. Readouts read from here."},
                "space_id": {"type": "string"},
                # Changing what is measured after data exists is the thing
                # pre-registration prevents, so it takes an explicit flag and
                # the previous contract is kept.
                "amend": {"type": "boolean"},
                "amend_reason": {"type": "string"},
                "contract": {
                    "type": "object",
                    "properties": {
                        "connection_id": {"type": "string"},
                        "dataset_id": {"type": "string"},
                        "variation": {"type": "string"},
                        # Split every arm by a second dimension. One query, grouped by both.
                        "cohort": {"type": "string"},
                        "unit": {"type": "string"},
                        "control": {"type": "string"},
                        "weights": {"type": "object"},
                        # Which table each outcome was joined from. The readout
                        # reads one flat dataset, so without this a reader
                        # cannot tell an outcome that sat beside the assignment
                        # from one joined in out of an events table.
                        "sources": {"type": "object"},
                        "outcome": {"type": "string"},
                        "binary": {"type": "boolean"},
                        "unit_agg": {"enum": ["sum", "max", "min", "avg", "count"]},
                        "cap": {"type": "number"},
                        "null_is_zero": {"type": "boolean"},
                        "metric_id": {"type": "string"},
                        "guardrails": {"type": "array", "items": _GUARDRAIL},
                        "alpha": {"type": "number"},
                        # Default TRUE. An agent polls, and a fixed-horizon
                        # interval read on a loop is a false-positive
                        # generator — which is exactly why the choice is made
                        # here, before the numbers exist, and not at read time.
                        "sequential": {"type": "boolean"},
                        "tuning": {"type": "integer", "minimum": 100},
                        # The p below which the split is called broken. 0.001,
                        # not 0.05: this runs on every readout, and at 0.05 one
                        # experiment in twenty is condemned for nothing. Frozen
                        # because an SRM failure OVERRIDES the verdict, so a
                        # threshold chosen afterwards is a way to remove the
                        # override.
                        "threshold": {"type": "number", "minimum": 0, "maximum": 1},
                        "mde": {"type": "number"},
                        "planned_days": {"type": "integer"},
                    },
                    "required": ["connection_id", "dataset_id", "variation", "outcome"],
                },
                "idempotencyKey": {"type": "string"},
            },
            "required": ["contract", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="semantic.export",
        relation="read",
        description=(
            "Export the space's semantic layer as Apache Ossie YAML — the "
            "vendor-neutral interchange for datasets, fields and metric "
            "definitions. Only ratified definitions are included."
        ),
        input_schema={
            "type": "object",
            "properties": {"space_id": {"type": "string"},
                           "connection_id": {"type": "string"}},
        },
    ))

    reg.register(Op(
        name="workspace.counts",
        relation="read",
        description=(
            "How many experiments, docs, dashboards, tasks and skills the caller can see, "
            "and how many of each need attention -- the numbers beside each collection, "
            "in one call instead of every list."
        ),
        input_schema={"type": "object", "properties": {}},
    ))

    reg.register(Op(
        name="context.skill",
        relation="read",
        description=(
            "The Agent Skill for this warehouse: which datasets exist, what one "
            "row of each is, which definitions are ratified, and how each is "
            "actually queried on real dashboards. Read this BEFORE writing SQL. "
            "Definitions and their status come from the registry and are current; "
            "column lists are as of dataset registration."
        ),
        input_schema={
            "type": "object",
            "properties": {"space_id": {"type": "string"},
                           "connection_id": {"type": "string"},
                           "zip": {"type": "boolean",
                                   "description": "The same files as a .zip, to install as a skill. "
                                                  "The web app downloads it with zip: true."}},
        },
    ))

    reg.register(Op(
        name="connections.check",
        relation="admin",
        description=(
            "Verify a connection opens, is read-only, and reports whether it can "
            "impersonate the caller. A connection that cannot is marked "
            "shared-principal and every panel bound to it inherits the marking."
        ),
        input_schema={
            "type": "object",
            "properties": {"connection_id": {"type": "string"}},
            "required": ["connection_id"],
        },
    ))

    _exp = {"experiment_id": {"type": "string"}, "space_id": {"type": "string"},
            "idempotencyKey": {"type": "string"}}

    reg.register(Op(
        name="experiments.start",
        relation="propose",
        mutating=True,
        description=(
            "Say when an experiment's traffic began (default now; in the past for one "
            "that was already running). From then on every readout reads the "
            "experiment's own days — start to stop — instead of the last N days, so "
            "the answer stops changing with the calendar. Needs a contract."
        ),
        input_schema={"type": "object",
                      "properties": {**_exp, "started_at": {"type": "string", "format": "date-time"},
                                     "stopped_at": {"type": "string", "format": "date-time",
                                                    "description": "Only for an experiment that "
                                                    "stopped before its dates were recorded."}},
                      "required": ["experiment_id", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="experiments.extent",
        relation="read",
        description=(
            "When traffic in an experiment's table starts and ends — the evidence for "
            "the dates of one registered after the fact. Read it before "
            "experiments.start rather than guessing a date."
        ),
        input_schema={"type": "object",
                      "properties": {"experiment_id": {"type": "string"},
                                     "space_id": {"type": "string"}},
                      "required": ["experiment_id"]},
    ))

    reg.register(Op(
        name="experiments.stop",
        relation="propose",
        mutating=True,
        description=(
            "Stop counting: running → readout. Readouts read up to the stop and no "
            "further, so late traffic cannot move a result somebody is deciding on."
        ),
        input_schema={"type": "object",
                      "properties": {**_exp, "reason": {"type": "string"}},
                      "required": ["experiment_id", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="experiments.explain",
        relation="read",
        description=(
            "A plain-language summary of a pre-registered experiment's readout: a headline, "
            "2-4 sentences, a recommendation (ship, kill, iterate, keep_running) and reasons. "
            "The statistics are the engine's; the model writes only the words, and every "
            "number and the recommendation are checked against the readout in code -- never "
            "'ship' with a guardrail worse, only 'iterate' when the split check failed."
        ),
        input_schema={"type": "object",
                      "properties": {**_exp, "fresh": {"type": "boolean",
                                                       "description": "Write a new one instead of reusing the "
                                                                      "summary of this same readout"}},
                      "required": ["experiment_id"]},
    ))
    reg.register(Op(
        name="experiments.draft_rationale",
        relation="read",
        description=(
            "Draft the rationale for a decision the person has chosen (ship, kill or "
            "iterate), from the readout. Records nothing; the numbers are checked against "
            "the readout. Record the decision with experiments.decide."
        ),
        input_schema={"type": "object",
                      "properties": {**_exp, "decision": {"enum": ["ship", "kill", "iterate"]}},
                      "required": ["experiment_id", "decision"]},
    ))
    reg.register(Op(
        name="experiments.write_up",
        relation="propose",
        mutating=True,
        description=(
            "Write the experiment up as a doc -- hypothesis, setup, a results table, notes "
            "and the decision -- built from the readout by code, not by a model, and filed "
            "in the experiment's projects. Pass the experiments.explain result as `summary` "
            "to include it, marked as AI-drafted."
        ),
        input_schema={"type": "object",
                      "properties": {**_exp, "summary": {"type": "object"}},
                      "required": ["experiment_id", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="experiments.decide",
        relation="merge",
        mutating=True,
        description=(
            "Ship, kill or iterate, with a required rationale. Cites a recorded readout "
            "(the last one by default; shipping requires one) and writes a decision "
            "object linked to the experiment and the readout, so 'why did we ship?' "
            "has an answer after the warehouse has moved on. Shipping on a readout "
            "whose sample-ratio check failed is refused."
        ),
        input_schema={"type": "object",
                      "properties": {**_exp,
                                     "decision": {"enum": ["ship", "kill", "iterate"]},
                                     "rationale": {"type": "string"},
                                     "readout_id": {"type": "string"}},
                      "required": ["experiment_id", "decision", "rationale", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="experiments.plan",
        relation="read",
        description=(
            "How many units and days an experiment needs to detect a relative change "
            "of `mde` — before it starts. Sized for the readout's own interval: "
            "always-valid by default, which needs more units than the textbook "
            "fixed-horizon formula. Name a table (connection, dataset, variation, "
            "outcome) and the baseline and daily traffic are read from it."
        ),
        input_schema={"type": "object", "properties": {
            "baseline": {"type": "number"}, "mde": {"type": "number"},
            "alpha": {"type": "number"}, "power": {"type": "number"},
            "binary": {"type": "boolean"}, "sd": {"type": "number"},
            "weights": {"type": "object"}, "control": {"type": "string"},
            "sequential": {"type": "boolean"}, "daily_units": {"type": "number"},
            "planned_days": {"type": "integer"},
            "connection_id": {"type": "string"}, "dataset_id": {"type": "string"},
            "variation": {"type": "string"}, "outcome": {"type": "string"},
            "unit": {"type": "string"}, "lookback_days": {"type": "integer"},
            # How the readout will aggregate and cap the outcome. Sized without
            # them, a few whales made revenue look ~80x noisier than the capped
            # readout measures it, and the plan asked for 595K users.
            "unit_agg": {"type": "string", "enum": ["sum", "max", "min", "avg", "count"]},
            "cap": {"type": "number"}, "null_is_zero": {"type": "boolean"},
            "space_id": {"type": "string"}},
            "required": ["mde"]},
    ))

    reg.register(Op(
        name="experiments.references",
        relation="read",
        description=(
            "What points at an experiment: the decisions made on it, the readouts "
            "recorded for it, and anything that lists it in its sources — a design "
            "drawn from its result, say. For answering 'what did we build on this?'"
        ),
        input_schema={"type": "object",
                      "properties": {"experiment_id": {"type": "string"},
                                     "space_id": {"type": "string"}},
                      "required": ["experiment_id"]},
    ))

    reg.register(Op(
        name="experiments.program",
        relation="read",
        description=(
            "The experimentation program in one grouped read over the experiments "
            "this space holds: how many are in flight, decided, shipped, the ship "
            "rate, median oriented win, and the effect-size distribution."
        ),
        input_schema={"type": "object", "properties": {"space_id": {"type": "string"}}},
    ))


def summary(reg: Registry) -> dict[str, Any]:
    """What this module contributed, for the parity test and for debugging."""
    return {op.name: op.relation for op in reg.all() if "." in op.name}
