"""The generation operation, registered into the one operation registry.

Same shape as `commonindex/core/retrieval/ops.py`: the definition lives beside the
engine it calls and the handler is written by hand in the gateway, because this
is a verb rather than a generated list/get/propose over one type.
"""

from __future__ import annotations

from commonindex.core.ops import Op, Registry


def register(reg: Registry) -> None:
    reg.register(Op(
        name="jobs.get",
        relation="read",
        description=(
            "Where a job you started stands, and its answer once it has one. A slow "
            "operation — a model's answer — asked for with the header "
            "`Prefer: respond-async` returns 202 and a job_id instead of waiting; "
            "this returns `state` (queued, running, done, failed) and, when done, "
            "`result` with the operation's own status and body."
        ),
        input_schema={"type": "object", "properties": {"job_id": {"type": "string"}},
                      "required": ["job_id"]},
    ))
    reg.register(Op(
        name="designs.revise",
        relation="propose",
        mutating=True,
        description=(
            "Replace a design's spec and keep the old one. Every revision is "
            "written to `revisions`, so a draft is something you can come back "
            "to tomorrow and a wrong turn is something you can undo — rather "
            "than a value living in a browser tab until you navigate away."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "design_id": {"type": "string"},
                "spec": {"type": "object"},
                "title": {"type": "string"},
                "sources": {"type": "array", "items": {"type": "string"},
                            "description": "Object ids this design is derived from — "
                                           "the decision it implements, the task that "
                                           "asked for it, the experiment it came out of. "
                                           "Provenance, and the thing that makes a design "
                                           "go stale when what it was drawn from changes."},
                "note": {"type": "string",
                         "description": "What changed, in the author's words. The "
                                        "brief that produced it, usually — which is "
                                        "what makes the history readable later."},
                "space_id": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["design_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="designs.references",
        relation="read",
        description=(
            "What a design was drawn from, resolved: the decision it implements, "
            "the task that asked for it, the dashboard whose numbers it shows. "
            "Reports which of them have changed since the design last did, which "
            "is what `stale` means here — a design is not wrong because time "
            "passed, it is wrong because what it was drawn from moved."
        ),
        input_schema={
            "type": "object",
            "properties": {"design_id": {"type": "string"}, "space_id": {"type": "string"}},
            "required": ["design_id"],
        },
    ))

    reg.register(Op(
        name="designs.history",
        relation="read",
        description=(
            "Every revision of a design, newest first: who changed it, when, and "
            "what they said they were doing. Restoring one is an ordinary revise "
            "carrying an older spec, so going back is itself recorded rather than "
            "quietly rewinding the record. Lists metadata only; pass `rev` for one "
            "revision's spec, or `with_spec` for every one."
        ),
        input_schema={
            "type": "object",
            "properties": {"design_id": {"type": "string"}, "space_id": {"type": "string"},
                           "rev": {"type": "integer"}, "with_spec": {"type": "boolean"}},
            "required": ["design_id"],
        },
    ))

    reg.register(Op(
        name="designs.generate",
        relation="propose",
        description=(
            "Describe what you want and get a design spec back. Returns the "
            "spec; it does NOT file it — generating is cheap to redo and "
            "filing is a proposal somebody reviews, so they are separate acts. "
            "The model is constrained to the design type's own schema, so it "
            "composes within the role catalogue and cannot answer with markup. "
            "Cite a template and the brief is grounded in that template's "
            "tokens, which is how a generated screen lands on-system instead "
            "of inventing a fourth blue."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "brief": {"type": "string",
                          "description": "What to design, in plain language. Detail "
                                         "earns its keep here: a brief naming the "
                                         "states and the real copy gets a screen "
                                         "somebody can judge, and a vague one gets "
                                         "a generic wireframe."},
                "surface": {"enum": ["mobile", "web", "email"]},
                "cites": {"type": "string",
                          "description": "Id of an approved design whose tokens this "
                                         "should be built on."},
                "sources": {"type": "array", "items": {"type": "string"},
                            "description": "Object ids to design against — the decision "
                                           "this implements, the task that asked for it. "
                                           "Their titles go into the brief, which is the "
                                           "thing a design tool outside this platform "
                                           "cannot do: the context is an object in the "
                                           "same graph, not a link pasted into a prompt."},
                "screens": {"type": "integer", "minimum": 1, "maximum": 6},
                "element": {"type": "string",
                            "description": "Id of the one element to change. With it the "
                                           "brief is a correction to that element and "
                                           "everything else is to be returned untouched — "
                                           "which is what makes an edit reviewable as an "
                                           "edit rather than as a redesign."},
                "base": {"type": "object",
                         "description": "The spec being refined. Send it and `brief` "
                                        "reads as a change to make rather than a "
                                        "design to start: 'make the CTA secondary' "
                                        "only means anything against something. The "
                                        "conversation lives in the caller — this "
                                        "operation stays stateless, which is what "
                                        "keeps it a request and not a run."},
                "space_id": {"type": "string"},
            },
            "required": ["brief", "surface"],
        },
    ))

    _review = {"design_id": {"type": "string"},
               "if_rev": {"type": "integer",
                          "description": "The revision you read. Refused if the design "
                                         "has moved since."},
               "note": {"type": "string"},
               "space_id": {"type": "string"},
               "idempotencyKey": {"type": "string"}}

    reg.register(Op(
        name="designs.request_review",
        relation="propose",
        mutating=True,
        description=(
            "Send a draft design for approval. Only a draft can be sent; editing a "
            "design in review returns it to draft, so what is approved is what was "
            "asked about."
        ),
        input_schema={"type": "object", "properties": _review,
                      "required": ["design_id", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="designs.approve",
        relation="merge",
        mutating=True,
        description=(
            "Approve a design in review, at the revision you read. Nobody approves "
            "changes they made — the creator, until a first approval, and anyone who "
            "edited it since the last one. An admin may approve their own work with "
            "`self_approve` and a reason in `note`; that is recorded on the design and "
            "as a decision object. Approved designs are what Starters are made of."
        ),
        input_schema={"type": "object",
                      "properties": {**_review, "self_approve": {"type": "boolean"}},
                      "required": ["design_id", "if_rev", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="designs.request_changes",
        relation="merge",
        mutating=True,
        description=(
            "Send a design in review back to draft, saying in `note` what should "
            "change. The note is required: a design returned without a reason is one "
            "nobody knows how to fix."
        ),
        input_schema={"type": "object", "properties": _review,
                      "required": ["design_id", "note", "idempotencyKey"]},
    ))

    reg.register(Op(
        name="designs.review",
        relation="read",
        description=(
            "Where a design stands in review, who made what is up for approval, and "
            "what the caller may do next — so a client offers Approve only to someone "
            "the gateway would let approve."
        ),
        input_schema={"type": "object",
                      "properties": {"design_id": {"type": "string"},
                                     "space_id": {"type": "string"}},
                      "required": ["design_id"]},
    ))

    reg.register(Op(
        name="docs.revise",
        relation="propose",
        mutating=True,
        description=(
            "Replace a doc's body and keep the old one. Every revision is a full "
            "snapshot in `revisions`, so an edit — a person's or a model's — can "
            "be read back and undone. Pass `if_rev` with the revision you last "
            "read: a doc somebody else changed since is refused rather than "
            "silently overwritten."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "doc_id": {"type": "string"},
                "body": {"type": "object",
                         "description": "The whole block tree, as `docs.get` returns it."},
                "title": {"type": "string"},
                "freshness": {"enum": ["fresh", "stale", "verified"]},
                "if_rev": {"type": "integer"},
                "note": {"type": "string",
                         "description": "What changed, in the author's words. An AI "
                                        "edit carries the instruction that made it."},
                "space_id": {"type": "string"},
                "idempotencyKey": {"type": "string"},
            },
            "required": ["doc_id", "idempotencyKey"],
        },
    ))

    reg.register(Op(
        name="docs.history",
        relation="read",
        description=(
            "Every revision of a doc, newest first: who changed it, when, what "
            "they said they were doing, and the body as it was."
        ),
        input_schema={
            "type": "object",
            "properties": {"doc_id": {"type": "string"}, "space_id": {"type": "string"}},
            "required": ["doc_id"],
        },
    ))

    reg.register(Op(
        name="docs.assist",
        relation="propose",
        description=(
            "Ask the workspace's model to write or edit a doc. Send the doc as "
            "markdown and an instruction; get markdown back. With `selection` "
            "the answer replaces only that passage and the rest is context. "
            "Returns text and files nothing — applying it is an ordinary "
            "`docs.revise`, so an AI edit lands in the same history as a "
            "person's and is undone the same way."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "instruction": {"type": "string",
                                "description": "What to write or change, in plain language."},
                "markdown": {"type": "string",
                             "description": "The whole doc as markdown. May contain ⟦here⟧ "
                                            "where the author's cursor is, which is what "
                                            "'write it here' refers to."},
                "selection": {"type": "string",
                              "description": "The passage to rewrite, as markdown. When "
                                             "present only this comes back."},
                "title": {"type": "string"},
                "space_id": {"type": "string"},
            },
            "required": ["instruction"],
        },
    ))

    reg.register(Op(
        name="docs.search",
        relation="read",
        description=(
            "Find doc sections by words and by meaning — the runbook, spec or "
            "decision that explains something. Each hit is one section with "
            "the doc's key, title and heading path as its citation. Code Query "
            "(`code.ask`, `code.context`) searches these too, so an answer about "
            "the code can cite the doc that explains it."
        ),
        input_schema={
            "type": "object",
            "properties": {"q": {"type": "string"}, "limit": {"type": "integer"},
                           "space_id": {"type": "string"}},
            "required": ["q"],
        },
    ))

    _doc_only = {"type": "object",
                 "properties": {"doc_id": {"type": "string"}, "space_id": {"type": "string"}},
                 "required": ["doc_id"]}
    _doc_mutation = {"type": "object",
                     "properties": {"doc_id": {"type": "string"}, "space_id": {"type": "string"},
                                    "idempotencyKey": {"type": "string"}},
                     "required": ["doc_id", "idempotencyKey"]}

    reg.register(Op(
        name="docs.share",
        relation="propose",
        mutating=True,
        description=(
            "Make a link anyone can open, without an account, to read a doc as "
            "it is now — it always shows the latest version. Sharing again "
            "returns the same link; `docs.unshare` turns it off."
        ),
        input_schema=_doc_mutation,
    ))
    reg.register(Op(
        name="docs.unshare",
        relation="propose",
        mutating=True,
        description="Turn a doc's share link off. The old link then 404s for good.",
        input_schema=_doc_mutation,
    ))
    reg.register(Op(
        name="docs.sharing",
        relation="read",
        description="A doc's live share link, or null when it is not shared.",
        input_schema=_doc_only,
    ))
    reg.register(Op(
        name="docs.export",
        relation="read",
        description=(
            "A doc as one self-contained HTML page: no script, readable offline, "
            "ready to attach or host. The same page a share link serves. With "
            "for_page, HTML the page store accepts: no address anywhere in it."
        ),
        input_schema={**_doc_only, "properties": {**_doc_only["properties"],
                                                   "for_page": {"type": "boolean"}}},
    ))
