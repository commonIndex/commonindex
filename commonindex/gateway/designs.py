"""Generating a design spec from a brief.

Returns the spec and files nothing. Generating is cheap to redo and filing is a
proposal a person reviews, so they are separate acts — and a generator that
writes on its own would put an unreviewed object in the graph every time
somebody changed their mind about a sentence.

The model is handed the design type's OWN schema as its output contract, so the
role catalogue it composes within is the catalogue the platform enforces at the
door. There is exactly one definition of what a design is.
"""

from __future__ import annotations

import json
import logging
import secrets
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from commonindex.adapters.model import Blocked, Unconfigured, configured, generate
from commonindex.gateway.collections import _schema_violation, replayed
from commonindex.workers.indexer import index_object

router = APIRouter()

#: How many revisions of a design are kept. The same number `designs.history`
#: returns, so the history is not a window onto rows nobody can reach.
KEEP_REVISIONS = 100

#: Fields only the review operations write. Neither revise nor propose may set
#: them, because both need only `propose` and approving needs more.
GOVERNED = ("state", "review")

#: The frame a surface is drawn in. A model asked for "a screen" with no size
#: invents one, and a spec whose geometry does not match its device renders as a
#: design nobody can judge.
FRAME = {"mobile": (390, 844), "web": (1280, 860), "email": (600, 720)}


def _error(status: int, code: str, message: str, field: str | None = None):
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message,
                                           "field": field}})


def _structured(node: Any) -> Any:
    """Rewrite a JSON Schema into the subset structured outputs accepts.

    Two constructs are rejected outright: a union written as
    `{"type": ["string", "null"]}`, which must be `anyOf`, and
    `additionalProperties` set to a schema rather than `false`. The design type
    uses both, so handing its schema to a model UNCHANGED — which is what the
    first version did, and what its commit message boasted about — makes every
    call a 400.

    A translation, not a copy: this returns new objects, so nothing here can
    mutate the schema `propose` validates against. The earlier by-reference
    hand-off would also have let an SDK that annotates schemas in place corrupt
    the platform's own constraint.
    """
    if isinstance(node, list):
        return [_structured(x) for x in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for k, v in node.items():
        if k == "type" and isinstance(v, list):
            out["anyOf"] = [{"type": t} for t in v]
            continue
        if k == "additionalProperties" and isinstance(v, dict):
            continue
        out[k] = _structured(v)
    if out.get("type") == "object" and "additionalProperties" not in out:
        out["additionalProperties"] = False
    return out


def output_schema(design_type: Any) -> dict[str, Any]:
    """The contract the model answers under.

    Derived from the design type rather than written beside it, so the roles a
    model may compose with stay the roles `propose` accepts — but derived
    through `_structured`, because the two have genuinely different legal
    grammars and pretending otherwise is what broke the first version.

    `tokens` is dropped. An open map of arbitrary token paths has no
    structured-output equivalent, and a generated design should take its
    palette from the template it cites rather than inventing one — an invented
    palette is exactly what "off-system" is for.
    """
    spec = _structured(design_type.schema["properties"]["spec"])
    spec.get("properties", {}).pop("tokens", None)
    if isinstance(spec.get("required"), list):
        spec["required"] = [r for r in spec["required"] if r != "tokens"]
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "title": {"type": "string", "description": "Short, specific, no surface suffix."},
            "spec": spec,
            "rationale": {"type": "string",
                          "description": "One or two sentences on the layout decisions, "
                                         "for the person reviewing this."},
        },
        "required": ["title", "spec", "rationale"],
    }


SYSTEM = """You design interfaces as declarative specs, never as markup or code.

A screen is a frame of a fixed pixel size containing elements. Every element is
a ROLE from the catalogue, a box in device pixels, and optional text. You cannot
emit HTML, CSS or component code, and there is no field that would carry it.

Hold to these, because a spec that breaks them renders as something nobody can
judge:

- Stay inside the frame. Boxes do not overlap, and nothing is placed off-screen.
- Leave real margins. Content starts around 16px from the edge on mobile and
  around 80px on web.
- Write the real copy. "Track your order" and "3 items, $68.00" can be judged;
  "Button" and "Lorem ipsum" cannot. Show a populated state, not an empty one.
- Cite a token path on every element you can. An element citing nothing is
  off-system and is drawn as drift, which is the correct outcome when you have
  invented a value rather than used the system's.
- A citation records provenance; it does not set paint or typography. Set tone
  or color for paint. Link text size with textStyle (e.g. font.size.body), or
  use fontSize (1–240px) to override it. Optional fontWeight (100–900), lineHeight
  (0.8–3 multiplier), and textAlign (left, center, right) control typography.
  Leave these unset to preserve the role's defaults. Text can contain newlines.
- Standard paths the renderer resolves include color.bg, color.surface,
  color.text, color.muted, color.accent, color.onAccent, color.border,
  color.danger, radius.md, font.size.heading, font.size.body. Additional colour
  and font-size tokens can be linked by their exact paths in the supplied palette.
- Order elements top to bottom as they appear."""


def _find_element(spec: dict[str, Any] | None, element_id: str | None) -> dict[str, Any] | None:
    """The element with this id, anywhere in the spec — children included."""
    def walk(items: list[Any]) -> dict[str, Any] | None:
        for e in items or []:
            if not isinstance(e, dict):
                continue
            if e.get("id") == element_id:
                return e
            if found := walk(e.get("children") or []):
                return found
        return None

    for screen in (spec or {}).get("screens") or []:
        if found := walk(screen.get("elements") or []):
            return found
    return None


def _replace_element(spec: dict[str, Any], element_id: str, new: dict[str, Any]) -> dict[str, Any]:
    """A copy of the spec with one element swapped for `new`; the rest is the
    same objects, so the diff a reviewer reads is that element and nothing else."""
    import copy

    out = copy.deepcopy(spec)

    def swap(items: list[Any]) -> bool:
        for i, e in enumerate(items or []):
            if isinstance(e, dict) and e.get("id") == element_id:
                items[i] = new
                return True
            if isinstance(e, dict) and swap(e.get("children") or []):
                return True
        return False

    for screen in out.get("screens") or []:
        if swap(screen.get("elements") or []):
            break
    return out


def _is_nested(spec: dict[str, Any] | None, element_id: str | None) -> bool:
    """Whether the element sits inside another's children rather than on a screen."""
    for screen in (spec or {}).get("screens") or []:
        for e in screen.get("elements") or []:
            if isinstance(e, dict) and e.get("id") == element_id:
                return False
    return _find_element(spec, element_id) is not None


def element_schema(full: dict[str, Any], *, nested: bool = False) -> dict[str, Any]:
    """The answer to a one-element edit: that element, under the same
    contract as in a whole spec, and why.

    A nested element answers under the child contract, which has no
    `children`: offered the top-level one, a model editing a button in a list
    returned it with `children: []`, and the type refused the whole edit."""
    el = full["properties"]["spec"]["properties"]["screens"]["items"]["properties"]["elements"]["items"]
    if nested:
        el = el["properties"]["children"]["items"]
    return {"type": "object", "additionalProperties": False,
            "properties": {"element": el,
                           "rationale": {"type": "string",
                                         "description": "One sentence on what changed, for the reviewer."}},
            "required": ["element", "rationale"]}


def _element_prompt(brief: str, surface: str, base: dict[str, Any], target: dict[str, Any],
                    tokens: dict[str, Any] | None, source_title: str | None, refs: list[str]) -> str:
    import json as _json

    screen = next((sc for sc in base.get("screens") or []
                   if _find_element({"screens": [sc]}, target.get("id")) is not None), {})
    lines = [
        (f"This element is on the {screen.get('name') or 'screen'} screen "
         f"({screen.get('w')}x{screen.get('h')} px) of a {surface} design:"),
        _json.dumps(target, separators=(",", ":")),
        "",
        f"Change it: {brief}",
        "",
        ("Return ONLY this element, changed. Keep its id, role and geometry unless "
         "the change is about them, and keep any children it has. Nothing else in "
         "the design is yours to change, so it is not shown."),
    ]
    if refs:
        lines += ["", "Do not contradict:", *[f"- {r}" for r in refs]]
    paths = ", ".join(sorted(tokens)[:40]) if tokens else (
        "color.bg, color.surface, color.text, color.muted, color.accent, color.onAccent, "
        "color.border, color.danger, radius.md, font.size.heading, font.size.body")
    lines += ["", f"Token paths you may cite{f' (from {source_title})' if source_title else ''}: {paths}"]
    return "\n".join(lines)


def _prompt(brief: str, surface: str, n: int, tokens: dict[str, Any] | None,
            source_title: str | None, base: dict[str, Any] | None = None,
            element: str | None = None, refs: list[str] | None = None) -> str:
    import json as _json

    w, h = FRAME[surface]
    if base and element:
        lines = [
            "Here is the current design spec:",
            _json.dumps(base, separators=(",", ":")),
            "",
            f"Change ONLY the element whose id is {element!r}: {brief}",
            "",
            ("Return the complete spec with every other element byte-identical — "
             "same ids, same geometry, same text. An edit a reviewer can read as "
             "an edit is one where the diff contains the change and nothing "
             "else."),
        ]
    elif base:
        lines = [
            "Here is the current design spec:",
            _json.dumps(base, separators=(",", ":")),
            "",
            f"Apply this change: {brief}",
            "",
            ("Return the COMPLETE updated spec, not a patch and not only the "
             "part you changed. Keep every element the change does not touch "
             "exactly as it is — including its id, so the diff a reviewer reads "
             "is the change and nothing else."),
        ]
    else:
        lines = [
            f"Design a {surface} interface. Brief: {brief}",
            "",
            f"Draw {n} screen{'s' if n != 1 else ''}, each {w}x{h} device pixels.",
        ]
    if refs:
        lines += [
            "",
            ("This is being designed against work already in the workspace. "
             "Design for what these say, and do not contradict them:"),
            *[f"- {r}" for r in refs],
        ]
    if tokens:
        paths = ", ".join(sorted(tokens)[:40])
        lines += [
            "",
            (f"Build on the approved system"
             f"{f' from {source_title}' if source_title else ''}."
             " Cite these token paths and invent no others:"),
            paths,
        ]
    else:
        lines += [
            "",
            ("There is no approved token set to build on, so cite the token paths "
             "you would want to exist (color.accent, color.text, radius.md and the "
             "like). They will read as off-system until somebody approves them, "
             "which is the honest state for a design that invented its own palette."),
        ]
    return "\n".join(lines)


@router.post("/api/v1/designs.generate")
async def designs_generate(req: Request):
    from commonindex.gateway.app import TYPES
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)

    brief = (body.get("brief") or "").strip()
    surface = (body.get("surface") or "").strip()
    if not brief:
        return _error(422, "no_brief", "say what to design", "brief")
    if surface not in FRAME:
        return _error(422, "bad_surface",
                      f"surface is one of {', '.join(FRAME)}", "surface")
    n = max(1, min(int(body.get("screens") or 1), 6))

    design_type = next((t for t in TYPES if t.id == "design"), None)
    if design_type is None:  # pragma: no cover - the type ships with the repo
        return _error(500, "no_design_type", "the design type is not loaded")

    # Ground the brief in the cited template's tokens, so what comes back is
    # on-system by construction rather than by review.
    tokens: dict[str, Any] | None = None
    source_title: str | None = None
    cites = (body.get("cites") or "").strip()
    if cites:
        from commonindex.gateway.sharing import guard

        # Built on a design the caller cannot see would leak its tokens.
        if refused := await guard(req, cites, space, "view", "cites"):
            return refused
        row = await state["pool"].fetchrow(
            "select title, props from objects where id = $1 and space_id = $2"
            "   and type = 'design' and deleted_at is null", cites, space)
        if row is None:
            return _error(404, "unknown_design", f"no design {cites!r}", "cites")
        import json as _json

        props = _json.loads(row["props"]) if isinstance(row["props"], str) else row["props"]
        tokens = (props.get("spec") or {}).get("tokens") or None
        source_title = row["title"]

    # A base spec arrives from the caller, so it is checked like anything else
    # a caller sends. Feeding an invalid spec back to the model would launder
    # it: whatever came out would be built on something `propose` refuses.
    base = body.get("base") or None
    if base is not None:
        if not isinstance(base, dict):
            return _error(422, "bad_base", "base is the spec object being refined", "base")
        bad = _schema_violation(design_type,
                                {"title": "x", "surface": surface, "spec": base})
        if bad:
            return _error(422, "bad_base",
                          f"the spec being refined is not a valid one — {bad[0]}", "base")

    # Reference titles, resolved from the graph. A design tool outside this
    # platform can be told "design for the refunds decision"; only one inside it
    # can read the decision.
    refs: list[str] = []
    wanted = [str(x) for x in (body.get("sources") or []) if x]
    if wanted:
        from commonindex.gateway import sharing

        # Only what the caller can see: a private title is not theirs to put
        # in a prompt.
        rows = await state["pool"].fetch(
            "select type, key, title from objects where id = any($1::text[])"
            "   and space_id = $2 and deleted_at is null and acl_keys && $3",
            wanted, space, await sharing.keys(req, state["pool"]))
        refs = [f"{r['type']} {r['key']}: {r['title']}" for r in rows]

    schema = output_schema(design_type)
    element = (body.get("element") or "").strip() or None
    target = _find_element(base, element) if base and element else None
    if base and element and target is None:
        return _error(422, "unknown_element", f"no element {element!r} in the spec being edited", "element")
    if target is not None:
        # One element changes, so one element is asked for — and put back in
        # place here. Asking for the whole spec "with everything else
        # byte-identical" was a 28 KB copy job: a 9B model returned 1 screen
        # of 10 and dropped the element it was asked to change. A model cannot
        # damage what it is never handed back.
        prompt = _element_prompt(brief, surface, base, target, tokens, source_title, refs)
        schema = element_schema(schema, nested=_is_nested(base, element))
    else:
        prompt = _prompt(brief, surface, n, tokens, source_title, base, None, refs)
    gen = state.get("generate") or _default_generate
    try:
        obj, usage = await gen(system=SYSTEM, prompt=prompt, schema=schema)
    except Unconfigured as e:
        return _error(503, "model_unconfigured", str(e))
    except Blocked as e:
        return _error(503, "model_blocked", str(e))
    except Exception as e:  # noqa: BLE001 - provider failures are not ours to classify
        # Logged with the detail, returned without it. A provider's error body
        # is its own: a 400 echoes the request back, a 401 turns this endpoint
        # into an oracle for whether the org's key is still valid, and a
        # customer-run proxy's error page is whatever it feels like.
        ref = secrets.token_hex(4)
        logging.getLogger(__name__).warning("designs.generate failed [%s]: %r", ref, e)
        return _error(502, "model_failed",
                      f"the model call failed (ref {ref}) — the detail is in the "
                      "gateway log rather than here, because a provider's error "
                      "body is not ours to forward.")

    if target is not None:
        changed = obj.get("element")
        if not isinstance(changed, dict):
            return _error(502, "model_output_invalid", "the model did not return the element")
        # Laid over the element as it was, so what the model leaves out stays:
        # a 9B model asked to recolour a button returned it without its size,
        # its link to the next screen and its citation. A change is what the
        # model says; an omission is not a deletion.
        changed = {**target, **changed, "id": element}
        # Not every provider holds to the schema it is sent. An empty list is
        # no change, and on a nested element it is the one key the type refuses.
        if changed.get("children") == [] and _is_nested(base, element):
            del changed["children"]
        obj = {"title": obj.get("title"), "spec": _replace_element(base, element, changed),
               "rationale": obj.get("rationale")}

    # Structured output makes the answer CONFORM; it does not make it true, and
    # a generator is not a place to keep a constraint. Check it here, against
    # the same schema `propose` will check it against on the way in.
    candidate = {"title": obj.get("title") or brief[:60],
                 "surface": surface, "spec": obj.get("spec")}
    violation = _schema_violation(design_type, candidate)
    if violation:
        why, field = violation
        return _error(502, "model_output_invalid",
                      f"the model returned something that is not a design — {why}", field)

    return {
        "title": candidate["title"],
        "surface": surface,
        "spec": candidate["spec"],
        "cites": [cites] if cites else [],
        "sources": wanted,
        "grounded_in": source_title,
        "rationale": obj.get("rationale") or "",
        # Carried back so whatever files this records what made it.
        "generated_by": usage.get("model"),
        "usage": usage,
        "note": "nothing was filed. Review it, then propose it.",
    }


async def _default_generate(*, system: str, prompt: str, schema: dict[str, Any],
                            max_tokens: int = 8000):
    return await generate(configured(), system=system, prompt=prompt,
                          schema=schema, max_tokens=max_tokens)


@router.post("/api/v1/designs.revise")
async def designs_revise(req: Request):
    """Replace a design's spec, keeping what it replaced.

    `revisions` has been in the schema since 0001 with exactly the right shape
    and, until now, one writer — inside a worker that never runs. So a draft
    lived in a browser tab: navigating away lost it, and there was no way back
    to yesterday's version of anything.

    The row stores a SNAPSHOT rather than a diff. `delta` is the column's name
    and a diff is the column's intent, but a snapshot is what makes restoring
    one line instead of a patch-application routine that has to agree with
    whatever wrote it — and a design spec is small enough that the honesty is
    worth more than the bytes.
    """
    from commonindex.gateway.app import TYPES
    from commonindex.gateway.auth import actor_of, space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    design_id = (body.get("design_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, design_id, space, "edit", "design_id"):
        return refused
    if not body.get("idempotencyKey"):
        return _error(422, "missing_idempotency_key",
                      "a mutation needs an idempotency key", "idempotencyKey")

    design_type = next((t for t in TYPES if t.id == "design"), None)
    actor = actor_of(req)

    async with state["pool"].acquire() as conn:
        row = await conn.fetchrow(
            "select title, props, current_rev from objects where id = $1"
            "   and space_id = $2 and type = 'design' and deleted_at is null",
            design_id, space)
        if row is None:
            return _error(404, "unknown_design", f"no design {design_id!r}", "design_id")
        # A retry of a save that already landed: that revision, not a second one.
        if done := await replayed(conn, design_id, body["idempotencyKey"]):
            current = json.loads(row["props"]) if isinstance(row["props"], str) else dict(row["props"])
            return {"design_id": design_id, "rev": done, "state": current.get("state") or "draft",
                    "replayed": True, "note": "already saved — this retry wrote nothing."}

        # State is not an edit. `state` was one more field revise copied in,
        # under `propose` — so anyone who could change a design could also call
        # it approved, their own included, and the review states meant nothing.
        # It moves only through the review operations, which check who is asking.
        for f in GOVERNED:
            if body.get(f) is not None:
                return _error(422, "governed_field",
                              f"`{f}` is not set by revising — use designs.request_review,"
                              " designs.approve or designs.request_changes", f)

        props = json.loads(row["props"]) if isinstance(row["props"], str) else dict(row["props"])
        edits = body.get("spec") is not None or (
            body.get("title") is not None and body["title"] != props.get("title"))
        if body.get("spec") is not None:
            props["spec"] = body["spec"]
        for f in ("title", "generated_by", "sources"):
            if body.get(f) is not None:
                props[f] = body[f]
        # An approval covers the revision somebody read. Change the design and
        # it is a different design, so it goes back to draft — the way new
        # commits dismiss a pull request's approval — rather than keeping a
        # badge for a version nobody approved.
        reopened = edits and props.get("state") in ("review", "approved")
        was = props.get("state")
        if reopened:
            props["state"] = "draft"
            props["review"] = {**(props.get("review") or {}), "reopened_from": was}

        violation = _schema_violation(design_type, props)
        if violation:
            why, field = violation
            return _error(422, "invalid_props",
                          f"this does not match the design type — {why}", field)

        # Optimistic concurrency. The spec posted here was built from a copy
        # this caller read earlier, and the whole object is replaced — so two
        # people editing one design, or one person with it open twice, wrote
        # over each other in silence: the second save carried the first's
        # element back to how it had been before that save happened.
        #
        # `if_rev` is what the caller last read. Absent, the write proceeds
        # unconditionally, because a caller that never read a revision cannot
        # be asked to have noticed one change.
        at = int(row["current_rev"] or 1)
        want = body.get("if_rev")
        if want is not None and int(want) != at:
            return _error(409, "stale_revision",
                          f"this design is at rev {at} and you last read rev {want}"
                          " — somebody else changed it. Re-read it and apply your"
                          " change to what is there now.", "if_rev")

        rev = at + 1
        async with conn.transaction():
            # The snapshot is written first and the object second, so a failure
            # between them leaves a history entry nothing points at rather than
            # a design whose previous state was never recorded.
            await conn.execute(
                "insert into revisions (object_id, rev, author_id, delta)"
                " values ($1,$2,$3,$4::jsonb)",
                design_id, rev, actor,
                json.dumps({"props": props, "note": (body.get("note") or "").strip(),
                            "key": body["idempotencyKey"]}))
            await conn.execute(
                "update objects set props = $2::jsonb, title = $3, current_rev = $4,"
                "       updated_at = now() where id = $1",
                design_id, json.dumps(props), str(props.get("title") or row["title"]), rev)
            await index_object(conn, design_id)
            # And drop what falls off the end. Every row holds a FULL snapshot
            # — deliberately, because restoring one is then a single statement
            # rather than a patch-application routine that has to agree with
            # whatever wrote it — and direct manipulation writes one per
            # gesture. A morning of dragging boxes put 77 revisions on one
            # design; nothing bounded that.
            #
            # Inside the same transaction as the insert, so the history is
            # never briefly longer than it is allowed to be, and the cap is
            # `designs.history`'s own page size: what is kept is exactly what
            # can be read, rather than a tail nothing has ever shown.
            await conn.execute(
                "delete from revisions where object_id = $1 and rev < ("
                "  select rev from revisions where object_id = $1"
                "   order by rev desc offset $2 limit 1)",
                design_id, KEEP_REVISIONS - 1)

    out = {"design_id": design_id, "rev": rev, "state": props.get("state") or "draft",
           "note": "the previous spec is in the history, not overwritten."}
    if reopened:
        out["reopened_from"] = was
        out["note"] += f" It was {was}; changing it returned it to draft."
    return out


@router.post("/api/v1/designs.history")
async def designs_history(req: Request):
    """What this design has been, newest first."""
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    design_id = (body.get("design_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, design_id, space, "view", "design_id"):
        return refused

    owner = await state["pool"].fetchval(
        "select 1 from objects where id = $1 and space_id = $2 and type = 'design'"
        "   and deleted_at is null", design_id, space)
    if owner is None:
        return _error(404, "unknown_design", f"no design {design_id!r}", "design_id")

    # The list is what the history panel draws: who, when, why. Every
    # revision's whole spec came with it — 400KB for a design edited a few
    # times — though one is needed only to restore it, so it is asked for by
    # `rev` then (or all of them with `with_spec`).
    one = body.get("rev")
    want_spec = bool(body.get("with_spec")) or one is not None
    rows = await state["pool"].fetch(
        "select r.rev, r.author_id, r.ts, r.delta, a.display"
        "  from revisions r left join actors a on a.id = r.author_id"
        " where r.object_id = $1 and ($3::int is null or r.rev = $3)"
        " order by r.rev desc limit $2", design_id, KEEP_REVISIONS,
        int(one) if isinstance(one, int | str) and str(one).isdigit() else None)

    out = []
    for r in rows:
        d = json.loads(r["delta"]) if isinstance(r["delta"], str) else r["delta"]
        props = (d or {}).get("props") or {}
        spec = props.get("spec")
        row = {
            "rev": r["rev"], "at": r["ts"],
            "by": r["display"] or r["author_id"],
            "note": (d or {}).get("note") or "",
            "title": props.get("title"),
            "screens": len((spec or {}).get("screens") or []),
            "has_spec": spec is not None,
        }
        if want_spec:
            row["spec"] = spec
        out.append(row)
    return {"design_id": design_id, "revisions": out}


@router.post("/api/v1/designs.references")
async def designs_references(req: Request):
    """What this design was drawn from, and whether any of it has moved.

    `sources` was declared on the type, rendered on the detail page ("a design
    with no sources cannot go stale") and written by nothing. It is the part of
    this feature no other design tool can have: the references are objects in
    the same graph — the decision a screen implements, the task that asked for
    it — so provenance is a join rather than a pasted link that rots.

    Stale means a source has been revised since this design last was. Not "old":
    a design is not wrong because time passed, it is wrong because what it was
    drawn from changed and nobody looked again.
    """
    from commonindex.gateway.auth import space_of

    state = req.app.state.commonindex
    body = await req.json()
    space = space_of(req, body)
    design_id = (body.get("design_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, design_id, space, "view", "design_id"):
        return refused

    row = await state["pool"].fetchrow(
        "select props, updated_at from objects where id = $1 and space_id = $2"
        "   and type = 'design' and deleted_at is null", design_id, space)
    if row is None:
        return _error(404, "unknown_design", f"no design {design_id!r}", "design_id")

    props = json.loads(row["props"]) if isinstance(row["props"], str) else row["props"]
    ids = [str(x) for x in (props.get("sources") or []) if x]
    if not ids:
        return {"design_id": design_id, "references": [], "stale": False,
                "note": "cites nothing, so nothing upstream can change under it."}

    from commonindex.gateway import sharing

    # A source the caller cannot see is reported unresolved, title and all
    # withheld — the same answer as one that was deleted.
    found = await state["pool"].fetch(
        "select id, type, key, title, updated_at from objects"
        " where id = any($1::text[]) and space_id = $2 and deleted_at is null and acl_keys && $3",
        ids, space, await sharing.keys(req, state["pool"]))
    by_id = {r["id"]: r for r in found}

    refs = []
    for i in ids:
        r = by_id.get(i)
        if r is None:
            # Named but unreadable is not the same as not named, and reporting it
            # as "no references" would put a falsehood where provenance goes.
            refs.append({"id": i, "type": None, "title": None, "unresolved": True,
                         "changed_since": False})
            continue
        changed = bool(r["updated_at"] and row["updated_at"]
                       and r["updated_at"] > row["updated_at"])
        refs.append({"id": i, "type": r["type"], "key": r["key"], "title": r["title"],
                     "updated_at": r["updated_at"], "unresolved": False,
                     "changed_since": changed})

    return {"design_id": design_id, "references": refs,
            "stale": any(r["changed_since"] for r in refs),
            "unresolved": [r["id"] for r in refs if r["unresolved"]]}


# ── review: draft → review → approved ─────────────────────────────────────
#
# The states were declared on the type from the start and nothing moved a
# design between them, so every design was a draft forever and none could
# become a starter, which lists only approved ones. The rule these enforce:
#
#   * asking for review needs `propose`, like editing;
#   * approving needs `merge`, like merging a pull request;
#   * nobody approves changes they made. "Made" is the creator plus anyone who
#     edited it since it was last approved — you cannot approve your own work,
#     and you cannot launder it by having someone else touch it last;
#   * an admin may approve their own anyway, but only by saying so and why. That
#     is recorded on the design and in a decision object, so it is an exception
#     people can see rather than a rule that quietly does not apply to some.


async def _design(conn, design_id: str, space: str):
    return await conn.fetchrow(
        "select id, title, props, current_rev, created_by from objects where id = $1"
        "   and space_id = $2 and type = 'design' and deleted_at is null",
        design_id, space)


def _props(row) -> dict[str, Any]:
    return json.loads(row["props"]) if isinstance(row["props"], str) else dict(row["props"])


async def _contributors(conn, row, props: dict[str, Any]) -> list[str]:
    """Who changed what is up for approval: the creator, and every author of an
    edit since the last approval. Review steps are not edits."""
    since = int((props.get("review") or {}).get("approved_rev") or 0)
    rows = await conn.fetch(
        "select distinct author_id from revisions where object_id = $1 and rev > $2"
        "   and coalesce(delta->>'kind', 'edit') = 'edit'", row["id"], since)
    # The creator made all of it until it was first approved; after that what
    # is up for approval is only what changed since, so only its authors count.
    seen = ([] if since else [row["created_by"]]) + [r["author_id"] for r in rows]
    return list(dict.fromkeys(a for a in seen if a))


async def _holds(req: Request, conn, actor: str, relation: str, space: str) -> bool:
    from commonindex.core.authz import Denied
    from commonindex.core.authz.store import PgChecker

    # The gateway's own checker when there is one — the same answer the
    # middleware gave — and otherwise one over this connection.
    checker = req.app.state.commonindex.get("checker") or PgChecker(conn)
    try:
        await checker.require(actor, relation, f"space:{space}")
        return True
    except Denied:
        return False


async def _step(conn, row, props: dict[str, Any], actor: str, kind: str, note: str) -> int:
    """Write a review step as a revision, so the history reads as one story —
    edited, sent for review, sent back, approved — rather than the review
    living somewhere the history cannot show."""
    rev = int(row["current_rev"] or 1) + 1
    await conn.execute(
        "insert into revisions (object_id, rev, author_id, delta) values ($1,$2,$3,$4::jsonb)",
        row["id"], rev, actor, json.dumps({"props": props, "note": note, "kind": kind}))
    await conn.execute(
        "update objects set props = $2::jsonb, current_rev = $3, updated_at = now()"
        " where id = $1", row["id"], json.dumps(props), rev)
    await index_object(conn, row["id"])
    await conn.execute(
        "delete from revisions where object_id = $1 and rev < ("
        "  select rev from revisions where object_id = $1"
        "   order by rev desc offset $2 limit 1)", row["id"], KEEP_REVISIONS - 1)
    return rev


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(tz=UTC).isoformat()


async def _review_request(req: Request):
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    if not body.get("idempotencyKey"):
        return None, None, None, _error(422, "missing_idempotency_key",
                                        "a mutation needs an idempotency key", "idempotencyKey")
    return body, space_of(req, body), actor_of(req), None


def _moved(row, body) -> JSONResponse | None:
    at = int(row["current_rev"] or 1)
    want = body.get("if_rev")
    if want is not None and int(want) != at:
        return _error(409, "stale_revision",
                      f"this design is at rev {at} and you last read rev {want}"
                      " — it changed. Re-read it first.", "if_rev")
    return None


@router.post("/api/v1/designs.request_review")
async def designs_request_review(req: Request):
    """Ask for this design to be approved."""
    body, space, actor, bad = await _review_request(req)
    if bad:
        return bad
    design_id = (body.get("design_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, design_id, space, "edit", "design_id"):
        return refused
    note = (body.get("note") or "").strip()
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _design(conn, design_id, space)
        if row is None:
            return _error(404, "unknown_design", f"no design {design_id!r}", "design_id")
        props = _props(row)
        now = props.get("state") or "draft"
        if now == "review":
            return {"design_id": design_id, "state": "review", "rev": row["current_rev"],
                    "already": True}
        if now != "draft":
            return _error(409, "not_a_draft",
                          f"this design is {now}; only a draft can be sent for review", "design_id")
        if moved := _moved(row, body):
            return moved
        props["state"] = "review"
        last = (props.get("review") or {}).get("approved_rev")
        props["review"] = {"requested_by": actor, "requested_at": _now(), "note": note or None,
                           **({"approved_rev": last} if last else {})}
        async with conn.transaction():
            rev = await _step(conn, row, props, actor, "review",
                              f"Asked for review{': ' + note if note else ''}")
    return {"design_id": design_id, "state": "review", "rev": rev, "already": False}


@router.post("/api/v1/designs.approve")
async def designs_approve(req: Request):
    """Approve the revision the reviewer read."""
    body, space, actor, bad = await _review_request(req)
    if bad:
        return bad
    design_id = (body.get("design_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, design_id, space, "view", "design_id"):
        return refused
    note = (body.get("note") or "").strip()
    if body.get("if_rev") is None:
        # Not optional here, unlike revise. An approval is for what somebody
        # read; without the revision they read it could land on one they did not.
        return _error(422, "missing_if_rev",
                      "say which revision you are approving — an approval is for the "
                      "version you read, not whatever is there when it lands", "if_rev")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _design(conn, design_id, space)
        if row is None:
            return _error(404, "unknown_design", f"no design {design_id!r}", "design_id")
        props = _props(row)
        now = props.get("state") or "draft"
        if now != "review":
            return _error(409, "not_in_review",
                          f"this design is {now}; ask for review before approving it", "design_id")
        if moved := _moved(row, body):
            return moved
        made = await _contributors(conn, row, props)
        own = actor in made
        if own:
            if not body.get("self_approve"):
                return _error(403, "own_work",
                              "you made or changed this design, so someone else must approve"
                              " it. An admin may approve their own work by saying why.",
                              "design_id")
            if not await _holds(req, conn, actor, "admin", space):
                return _error(403, "own_work",
                              "only an admin may approve their own work", "self_approve")
            if not note:
                return _error(422, "reason_required",
                              "approving your own work needs a reason, which is recorded"
                              " on the design", "note")
        review = dict(props.get("review") or {})
        async with conn.transaction():
            rev = int(row["current_rev"] or 1) + 1
            review.update({"decision": "approved", "decided_by": actor, "decided_at": _now(),
                           "decision_note": note or None, "approved_rev": rev,
                           "self_approved": own, "reopened_from": None})
            props["state"] = "approved"
            props["review"] = review
            # The same record a ratified metric leaves: an object in the graph,
            # so an approval can be found, cited and questioned like any other.
            decision_id = f"dec-{design_id}-r{rev}"
            await conn.execute(
                "insert into objects (id, space_id, type, title, props, created_by)"
                " values ($1,$2,'decision',$3,$4::jsonb,$5) on conflict (id) do nothing",
                decision_id, space, f"Approve {row['title']}",
                json.dumps({"design_id": design_id, "rev": rev, "self_approved": own,
                            "why": note or None}), actor)
            await _step(conn, row, props, actor, "approve",
                        ("Self-approved" if own else "Approved") + (f": {note}" if note else ""))
    return {"design_id": design_id, "state": "approved", "rev": rev,
            "decision_id": decision_id, "self_approved": own}


@router.post("/api/v1/designs.request_changes")
async def designs_request_changes(req: Request):
    """Send a design in review back to its author, saying what to change."""
    body, space, actor, bad = await _review_request(req)
    if bad:
        return bad
    design_id = (body.get("design_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, design_id, space, "view", "design_id"):
        return refused
    note = (body.get("note") or "").strip()
    if not note:
        return _error(422, "reason_required",
                      "say what should change — a design sent back without a reason"
                      " is a design nobody knows how to fix", "note")
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _design(conn, design_id, space)
        if row is None:
            return _error(404, "unknown_design", f"no design {design_id!r}", "design_id")
        props = _props(row)
        now = props.get("state") or "draft"
        if now != "review":
            return _error(409, "not_in_review",
                          f"this design is {now}; only one in review can be sent back", "design_id")
        if moved := _moved(row, body):
            return moved
        props["state"] = "draft"
        props["review"] = {**(props.get("review") or {}), "decision": "changes_requested",
                           "decided_by": actor, "decided_at": _now(), "decision_note": note}
        async with conn.transaction():
            rev = await _step(conn, row, props, actor, "changes", f"Changes requested: {note}")
    return {"design_id": design_id, "state": "draft", "rev": rev}


@router.post("/api/v1/designs.review")
async def designs_review(req: Request):
    """Where this design is in review, and what the caller may do about it —
    so a page offers Approve only to someone the gateway would let approve."""
    from commonindex.gateway.auth import actor_of, space_of

    body = await req.json()
    space, actor = space_of(req, body), actor_of(req)
    design_id = (body.get("design_id") or "").strip()
    from commonindex.gateway.sharing import guard

    if refused := await guard(req, design_id, space, "view", "design_id"):
        return refused
    async with req.app.state.commonindex["pool"].acquire() as conn:
        row = await _design(conn, design_id, space)
        if row is None:
            return _error(404, "unknown_design", f"no design {design_id!r}", "design_id")
        props = _props(row)
        made = await _contributors(conn, row, props)
        names = {r["id"]: r["display"] for r in await conn.fetch(
            "select id, display from actors where id = any($1::text[])",
            list({*made, *[v for k, v in (props.get("review") or {}).items()
                            if k in ("requested_by", "decided_by") and v]}))}
        may_propose = await _holds(req, conn, actor, "propose", space)
        may_merge = await _holds(req, conn, actor, "merge", space)
        is_admin = await _holds(req, conn, actor, "admin", space)
    state = props.get("state") or "draft"
    own = actor in made
    return {
        "design_id": design_id, "state": state, "rev": row["current_rev"],
        "review": props.get("review") or None,
        "contributors": [{"id": a, "name": names.get(a) or a} for a in made],
        "names": names,
        "you": {
            "id": actor,
            "made_this": own,
            "may_request": state == "draft" and may_propose,
            "may_approve": state == "review" and may_merge and not own,
            "may_self_approve": state == "review" and own and is_admin,
            "may_request_changes": state == "review" and may_merge,
        },
    }
