"""A mermaid flowchart drawn as inline SVG, for the shared page and the export.

The page runs no script, so the diagram cannot be drawn in the reader's
browser the way the editor draws it. This is the same subset the web client's
`data/mermaid.ts` parses — flowchart/graph, TD or LR, the node shapes, labelled
and dashed edges, chains — and the same layering layout as `MermaidFlow`, so a
doc's diagram looks the same shared as it does in the editor.

Labels are written by people and by models, and become SVG <text> with every
character escaped: there is no markup path, so the strongest thing a label can
do is be long. A block this cannot read returns None and is shown as code,
which is honest about there being a diagram it could not draw.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html import escape

W, H = 176, 58
GAP_ACROSS, GAP_ALONG, PAD = 26, 54, 14
CHARS = (W - 22) * 2 // 13          # ≈ 6.5px a character at 12.5px
MAX_NODES = 60                      # past this a flowchart is not a picture

HEADER = re.compile(r"^\s*(?:flowchart|graph)(?:\s+(TB|TD|BT|LR|RL))?\s*;?\s*$", re.IGNORECASE)
IGNORED = re.compile(r"^\s*(%%|subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b)", re.IGNORECASE)
SHAPES = [("([", "])", "stadium"), ("[(", ")]", "store"), ("[[", "]]", "external"),
          ("[/", "/]", "queue"), ("[\\", "\\]", "queue"), ("{{", "}}", "decision"),
          ("((", "))", "round"), ("[", "]", "box"), ("(", ")", "round"), ("{", "}", "decision")]
ARROW = re.compile(r"(-{2,}>|-\.-+>|={2,}>|-{3,}|-\.-)(?:\s*\|([^|]*)\|)?")
ID = re.compile(r"^[\w.-]+$")


@dataclass
class Node:
    id: str
    label: str
    shape: str = "box"
    x: float = 0
    y: float = 0
    lines: list[str] = field(default_factory=list)


@dataclass
class Edge:
    src: str
    dst: str
    label: str = ""
    dashed: bool = False


def _decode(label: str) -> str:
    label = re.sub(r"<br\s*/?>", " ", label, flags=re.IGNORECASE).replace("#quot;", '"')
    label = re.sub(r"#(\d{1,5});", lambda m: chr(int(m.group(1))), label)
    return re.sub(r"\s+", " ", label).strip()


def _unquote(label: str) -> str:
    t = label.strip()
    return t[1:-1] if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'" else t


def _declaration(raw: str) -> Node | None:
    text = raw.strip().rstrip(";").strip()
    if not text:
        return None
    for open_, close, shape in SHAPES:
        start = text.find(open_)
        if start <= 0 or not text.endswith(close):
            continue
        nid = text[:start].strip()
        if not ID.match(nid):
            return None
        return Node(nid, _decode(_unquote(text[start + len(open_):len(text) - len(close)])), shape)
    return Node(text, _decode(text)) if ID.match(text) else None


def _edge_labels(line: str) -> str:
    """`A -- label --> B` as `A -->|label| B`, so one arrow form is enough."""
    return re.sub(r"\s(--|==|-\.)\s+([^->|][^>]*?)\s+(-->|==>|-\.->)\s",
                  lambda m: f" {m.group(3)}|{m.group(2)}| ", line)


def parse(src: str) -> tuple[str, list[Node], list[Edge]] | None:
    lines = (src or "").replace("\r\n", "\n").split("\n")
    first = next((i for i, line in enumerate(lines) if line.strip()), None)
    if first is None or not HEADER.match(lines[first]):
        return None
    direction = "LR" if re.search(r"\b(LR|RL)\b", lines[first], re.IGNORECASE) else "TD"
    nodes: dict[str, Node] = {}
    edges: list[Edge] = []
    read = unread = 0

    def remember(n: Node | None) -> str | None:
        if n is None:
            return None
        old = nodes.get(n.id)
        if old is None or (n.label != n.id and old.label == old.id):
            nodes[n.id] = n
        return n.id

    for raw in lines[first + 1:]:
        line = raw.strip()
        if not line or IGNORED.match(line):
            continue
        norm = _edge_labels(f" {line} ")
        arrows = list(ARROW.finditer(norm))
        if not arrows:
            if remember(_declaration(line)):
                read += 1
            else:
                unread += 1
            continue
        ok, cursor, prev, pending = True, 0, None, None
        for a in arrows:
            nid = remember(_declaration(norm[cursor:a.start()]))
            ok = ok and nid is not None
            if prev and nid and pending:
                edges.append(Edge(prev, nid, _decode(_unquote(pending.group(2) or "")),
                                  "." in pending.group(1)))
            prev, pending, cursor = nid, a, a.end()
        last = remember(_declaration(norm[cursor:]))
        ok = ok and last is not None
        if prev and last and pending:
            edges.append(Edge(prev, last, _decode(_unquote(pending.group(2) or "")),
                              "." in pending.group(1)))
        read, unread = (read + 1, unread) if ok else (read, unread + 1)

    if not nodes or unread > read or len(nodes) > MAX_NODES:
        return None
    return direction, list(nodes.values()), edges


def _wrap(label: str, most: int = 3) -> list[str]:
    lines: list[str] = []
    for word in label.split():
        if lines and len(lines[-1]) + 1 + len(word) <= CHARS:
            lines[-1] += " " + word
        elif len(word) <= CHARS:
            lines.append(word)
        else:
            lines += [word[i:i + CHARS] for i in range(0, len(word), CHARS)][: most + 1]
    if not lines:
        return ["?"]
    return lines if len(lines) <= most else [*lines[: most - 1], lines[most - 1][: CHARS - 1] + "…"]


def _layout(direction: str, nodes: list[Node], edges: list[Edge]) -> tuple[float, float]:
    depth = {n.id: 0 for n in nodes}
    for _ in nodes:                       # one pass per node, so a cycle settles
        moved = False
        for e in edges:
            if e.src in depth and e.dst in depth and depth[e.src] + 1 > depth[e.dst]:
                depth[e.dst] = depth[e.src] + 1
                moved = True
        if not moved:
            break
    rows: dict[int, list[Node]] = {}
    for n in nodes:
        rows.setdefault(depth[n.id], []).append(n)
    filled = [rows[k] for k in sorted(rows)]
    widest = max(len(r) for r in filled)
    across = widest * W + (widest - 1) * GAP_ACROSS
    along = len(filled) * H + (len(filled) - 1) * GAP_ALONG
    for ri, row in enumerate(filled):
        offset = (across - (len(row) * W + (len(row) - 1) * GAP_ACROSS)) / 2
        for ci, n in enumerate(row):
            a, b = PAD + offset + ci * (W + GAP_ACROSS), PAD + ri * (H + GAP_ALONG)
            n.x, n.y = (b, a) if direction == "LR" else (a, b)
            n.lines = _wrap(n.label)
    lr = direction == "LR"
    return (along if lr else across) + PAD * 2, (across if lr else along) + PAD * 2


def _shape(n: Node) -> str:
    x, y = n.x, n.y
    if n.shape == "queue":
        return f'<polygon class="s" points="{x + 13},{y} {x + W},{y} {x + W - 13},{y + H} {x},{y + H}"/>'
    if n.shape == "decision":
        return (f'<polygon class="s" points="{x + 15},{y} {x + W - 15},{y} {x + W},{y + H / 2} '
                f'{x + W - 15},{y + H} {x + 15},{y + H} {x},{y + H / 2}"/>')
    r = {"round": 18, "stadium": H / 2, "store": 7, "external": 7}.get(n.shape, 9)
    out = f'<rect class="s" x="{x}" y="{y}" width="{W}" height="{H}" rx="{r}"/>'
    if n.shape == "store":
        out += f'<line class="r" x1="{x}" y1="{y + 13}" x2="{x + W}" y2="{y + 13}"/>'
    return out


def _path(a: Node, b: Node, direction: str) -> tuple[str, float, float]:
    if direction == "TD":
        if b.y > a.y:
            sx, sy, ex, ey = a.x + W / 2, a.y + H, b.x + W / 2, b.y
            return f"M {sx} {sy} C {sx} {(sy + ey) / 2}, {ex} {(sy + ey) / 2}, {ex} {ey}", (sx + ex) / 2, (sy + ey) / 2
        sx, sy, ex, ey = a.x + W, a.y + H / 2, b.x + W, b.y + H / 2
        return f"M {sx} {sy} C {sx + 34} {sy}, {ex + 34} {ey}, {ex} {ey}", max(sx, ex) + 21, (sy + ey) / 2
    if b.x > a.x:
        sx, sy, ex, ey = a.x + W, a.y + H / 2, b.x, b.y + H / 2
        return f"M {sx} {sy} C {(sx + ex) / 2} {sy}, {(sx + ex) / 2} {ey}, {ex} {ey}", (sx + ex) / 2, (sy + ey) / 2
    sx, sy, ex, ey = a.x + W / 2, a.y + H, b.x + W / 2, b.y + H
    return f"M {sx} {sy} C {sx} {sy + 34}, {ex} {ey + 34}, {ex} {ey}", (sx + ex) / 2, max(sy, ey) + 21


def render_svg(src: str) -> str | None:
    """The diagram as an <svg> element, or None when `src` is not one."""
    parsed = parse(src)
    if parsed is None:
        return None
    direction, nodes, edges = parsed
    width, height = _layout(direction, nodes, edges)
    by_id = {n.id: n for n in nodes}
    head = (f'<svg class="flow" viewBox="0 0 {width:g} {height:g}" width="{width:g}" '
            f'role="img" aria-label="Flow diagram" xmlns="http://www.w3.org/2000/svg">'
            '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
            'markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="h"/>'
            "</marker></defs>")
    parts = [head]
    for e in edges:
        a, b = by_id.get(e.src), by_id.get(e.dst)
        if not a or not b or a is b:
            continue
        d, mx, my = _path(a, b, direction)
        parts.append(f'<path class="e{" d" if e.dashed else ""}" d="{d}" marker-end="url(#ah)"/>')
        if e.label:
            label = escape(e.label[:40])
            parts.append(f'<text class="el" x="{mx}" y="{my - 4}" text-anchor="middle">{label}</text>')
    for n in nodes:
        parts.append(_shape(n))
        top = n.y + H / 2 - (len(n.lines) - 1) * 7.5 + 4
        for i, line in enumerate(n.lines):
            parts.append(f'<text class="t" x="{n.x + W / 2}" y="{top + i * 15}" '
                         f'text-anchor="middle">{escape(line)}</text>')
    parts.append("</svg>")
    return "".join(parts)
