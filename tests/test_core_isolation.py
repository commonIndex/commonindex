"""The import rule, as a test rather than a grep.

The Go skeleton enforced this with `! grep -rn ...`, which the review showed was
trivially defeated: plurals passed, case passed, string concatenation passed, and
— worst — with no core directory at all, grep exited 2 and `!` inverted that to
success. A rename disabled the guard silently.

This version fixes each of those. It reads collection names from types/*.json
rather than a hardcoded list, so it stays correct as collections are added, which
is the actual failure mode: the leak will be a collection nobody thought to list.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "commonindex" / "core"
TYPES = ROOT / "types"


def collection_names() -> set[str]:
    names: set[str] = set()
    for f in sorted(TYPES.glob("*.json")):
        t = json.loads(f.read_text())
        names.add(t["id"].lower())
        names.add(t["plural"].lower())
        names.add(t["label"].lower())
    return names


def docstring_nodes(tree: ast.AST) -> set[int]:
    """Docstrings are Constants too, and they legitimately name collections when
    explaining the rule. Comments never reach the AST at all, which removes the
    false-positive class the grep version suffered from."""
    out: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                out.add(id(body[0].value))
    return out


def _fold(node: ast.AST) -> str | None:
    """Return the value of a string expression built by ``+``, or None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _fold(node.left), _fold(node.right)
        if left is not None and right is not None:
            return left + right
    return None


def test_core_has_no_directory_named_after_a_collection():
    """The blind spot in every check above.

    They walk `CORE.rglob("*.py")` and inspect string literals and `match`
    subjects — so `commonindex/core/experiments/` passed while being a directory
    named after a collection, which is the plainest possible way for the engine
    to know which collection it serves.

    Directories only. A FILE name is more ambiguous: `warehouse/metrics.py`
    holds the warehouse's own notion of a metric definition, which shares a word
    with the collection without being it. A directory implies a subsystem, and a
    subsystem named for a collection is the leak this guard exists to catch.
    """
    banned = collection_names()
    offences = [
        str(d.relative_to(ROOT))
        for d in CORE.rglob("*")
        if d.is_dir() and d.name != "__pycache__"
        and any(d.name.lower() in (b, b + "s") for b in banned)
    ]
    assert not offences, (
        "commonindex/core has a directory named after a collection:\n  "
        + "\n  ".join(offences)
        + "\nName it for what it does, not for what it happens to serve."
    )


def test_types_directory_is_readable():
    """Guards the guard. If this fails, every assertion below is vacuous — which
    is exactly how the grep version silently stopped working."""
    assert TYPES.is_dir(), "types/ is missing; the name list would be empty"
    assert collection_names(), "types/ yielded no collection names"


def test_core_package_exists():
    """The other half of guarding the guard: a renamed or moved core directory
    must fail loudly rather than pass by vacuity."""
    assert CORE.is_dir(), "commonindex/core is missing — the isolation check has nothing to check"
    assert list(CORE.rglob("*.py")), "commonindex/core contains no modules"


def test_core_names_no_collection():
    """No string literal under commonindex.core may be a collection name.

    Case-folded, and covering both the singular id and the plural, because
    'experiments' passing while 'experiment' failed was one of the holes.
    """
    names = collection_names()
    offences: list[str] = []

    for path in sorted(CORE.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        skip = docstring_nodes(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if id(node) in skip:
                continue
            if node.value.strip().lower() in names:
                offences.append(f"{path.relative_to(ROOT)}:{node.lineno} → {node.value!r}")

        # Constant-fold adjacent string concatenation. "exper" + "iment" is a
        # BinOp, not a Constant, and it slipped past the grep version too.
        for node in ast.walk(tree):
            folded = _fold(node)
            if folded and folded.strip().lower() in names:
                offences.append(f"{path.relative_to(ROOT)}:{node.lineno} → folded {folded!r}")

    assert not offences, (
        "commonindex/core names a collection; the abstraction has leaked and the next "
        "collection will cost what the last one did:\n  " + "\n  ".join(offences)
    )


def test_core_does_not_branch_on_type():
    """Ban the SHAPE, not just the spelling.

    A match or switch on ``.type`` is per-collection behaviour even when it never
    spells a name — the leak that concatenation or an alias would otherwise hide.
    """
    offences: list[str] = []
    for path in sorted(CORE.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if (isinstance(node, ast.Match)
                    and isinstance(node.subject, ast.Attribute)
                    and node.subject.attr == "type"):
                offences.append(f"{path.relative_to(ROOT)}:{node.lineno} → match on .type")
    assert not offences, "commonindex/core branches on object type:\n  " + "\n  ".join(offences)


def test_adapters_do_not_branch_on_collection_type():
    """Adapters exist to hold strings that collide with our vocabulary.

    A first attempt at this test banned collection NAMES here too, and it failed
    immediately on ``"metrics"`` — which is dbt's own response key.
    That is the point of the package: a vendor is entitled to name their field
    whatever they like, and pretending otherwise would just push the mapping
    somewhere less honest.

    What still does not belong is per-collection BEHAVIOUR. A vendor field named
    "metrics" is data; a branch on ``.type`` is logic, and logic that varies by
    collection belongs nowhere outside a registry entry.
    """
    adapters = ROOT / "commonindex" / "adapters"
    assert adapters.is_dir(), "commonindex/adapters is missing"
    offences: list[str] = []
    for path in sorted(adapters.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Match) and isinstance(node.subject, ast.Attribute) \
                    and node.subject.attr == "type":
                offences.append(f"{path.relative_to(ROOT)}:{node.lineno} → match on .type")
    assert not offences, "an adapter branches on collection type:\n  " + "\n  ".join(offences)


def test_core_does_not_import_outward():
    """core is the engine; it may not reach into the surfaces built on it."""
    banned = ("commonindex.gateway", "commonindex.workers", "commonindex.runner",
              "commonindex.adapters", "commonindex_enterprise")
    offences: list[str] = []
    for path in sorted(CORE.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            mods: list[str] = []
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                mods = [node.module]
            for m in mods:
                if any(m == b or m.startswith(b + ".") for b in banned):
                    offences.append(f"{path.relative_to(ROOT)}:{node.lineno} → {m}")
    assert not offences, "commonindex/core imports outward:\n  " + "\n  ".join(offences)


def test_open_substrate_does_not_import_paid():
    """P1 · the direction of dependency IS the open/paid boundary.

    commonindex_enterprise may import commonindex. The reverse would make the open half
    unusable without the paid half, which is the whole thing P1 was decided early
    to prevent.
    """
    offences: list[str] = []
    for path in sorted((ROOT / "commonindex").rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            mods: list[str] = []
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                mods = [node.module]
            for m in mods:
                if m == "commonindex_enterprise" or m.startswith("commonindex_enterprise."):
                    offences.append(f"{path.relative_to(ROOT)}:{node.lineno} → {m}")
    assert not offences, "the open substrate imports the paid half:\n  " + "\n  ".join(offences)
