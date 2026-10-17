"""The platform from a terminal: every operation the gateway serves.

Nothing here names an operation. The list, each one's description and the
fields it takes come from the gateway's own `_ops` listing — the registry the
HTTP routes and the MCP tools are generated from — so a command line written
by hand cannot fall behind it. An operation added to the registry is a
command the moment the gateway serves it.

    commonindex login --url http://localhost:8000 --token <token>
    commonindex ops dashboards                 # what there is, filtered by words
    commonindex help search.query              # what one takes
    commonindex search.query q="refund rate" limit=5
    commonindex docs.create --json '{"title": "Runbook"}'

A field written `name=value` is read as JSON when it parses as JSON — a
number, true, a list — and as text otherwise. A mutating operation that wants
an idempotency key gets a fresh one unless one is given, the way the web app
sends one with every write. Standard library only: a command line is the last
thing that should need its own dependency tree.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

CONFIG = Path(os.environ.get("COMMONINDEX_CONFIG") or Path.home() / ".config" / "commonindex" / "cli.json")


class CliError(Exception):
    """Said to the person at the terminal, then exit 1."""


def _config() -> dict[str, str]:
    try:
        saved = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    except ValueError:
        raise CliError(f"{CONFIG} is not JSON — run `commonindex login` again") from None
    return {"url": (os.environ.get("COMMONINDEX_URL") or saved.get("url") or "http://localhost:8000").rstrip("/"),
            "token": os.environ.get("COMMONINDEX_TOKEN") or saved.get("token") or ""}


def _request(cfg: dict[str, str], method: str, path: str, body: dict | None = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{cfg['url']}{path}", data=data, method=method,
                                 headers={"content-type": "application/json",
                                          **({"authorization": f"Bearer {cfg['token']}"} if cfg["token"] else {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error") or {}
        except ValueError:
            err = {}
        field = f" ({err['field']})" if err.get("field") else ""
        raise CliError(f"{e.code} {err.get('code', 'error')}{field}: {err.get('message', e.reason)}") from None
    except urllib.error.URLError as e:
        raise CliError(f"could not reach the gateway at {cfg['url']}: {e.reason}") from None


def operations(cfg: dict[str, str]) -> list[dict[str, Any]]:
    return _request(cfg, "GET", "/api/v1/_ops")["operations"]


def _find(ops: list[dict[str, Any]], name: str) -> dict[str, Any]:
    for op in ops:
        if op["name"] == name:
            return op
    near = [o["name"] for o in ops if name.split(".")[0] in o["name"]][:6]
    raise CliError(f"no operation {name!r}" + (f" — did you mean {', '.join(near)}?" if near else
                                               ". `commonindex ops` lists them."))


def parse_fields(pairs: list[str]) -> dict[str, Any]:
    """`name=value` pairs: a value that parses as JSON is that JSON, else text."""
    body: dict[str, Any] = {}
    for pair in pairs:
        name, eq, raw = pair.partition("=")
        if not eq or not name:
            raise CliError(f"{pair!r} is not name=value")
        try:
            body[name] = json.loads(raw)
        except ValueError:
            body[name] = raw
    return body


def build_body(op: dict[str, Any], pairs: list[str], raw_json: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if raw_json:
        text = sys.stdin.read() if raw_json == "-" else raw_json
        try:
            body = json.loads(text)
        except ValueError as e:
            raise CliError(f"--json is not JSON: {e}") from None
        if not isinstance(body, dict):
            raise CliError("--json must be an object")
    body |= parse_fields(pairs)
    schema = op.get("input_schema") or {}
    if "idempotencyKey" in (schema.get("properties") or {}) and "idempotencyKey" not in body:
        body["idempotencyKey"] = f"cli-{uuid.uuid4()}"
    missing = [f for f in schema.get("required") or [] if f not in body]
    if missing:
        raise CliError(f"{op['name']} needs {', '.join(missing)} — `commonindex help {op['name']}` says what each is")
    return body


def describe(op: dict[str, Any]) -> str:
    schema = op.get("input_schema") or {}
    required = set(schema.get("required") or [])
    lines = [f"{op['name']}  ({op['relation']}{', writes' if op.get('mutating') else ''})", "",
             op.get("description") or "", ""]
    props = schema.get("properties") or {}
    if props:
        lines.append("Fields:")
        for name, spec in props.items():
            kind = spec.get("type") or ("one of " + ", ".join(map(str, spec["enum"])) if "enum" in spec else "")
            if isinstance(kind, list):
                kind = " or ".join(kind)
            note = (spec.get("description") or "").split("\n")[0]
            lines.append(f"  {name}{' (required)' if name in required else ''}  {kind}".rstrip()
                         + (f" — {note}" if note else ""))
    return "\n".join(lines).rstrip()


def _cmd_login(args: argparse.Namespace) -> int:
    cfg = {"url": args.url.rstrip("/"), "token": args.token}
    me = _request(cfg, "POST", "/api/v1/actors.me", {})
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    # A token is a credential: the file is never readable by anyone else, not
    # even for the moment between writing it and narrowing it.
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(cfg))
    who = me.get("actor") or me
    print(f"Signed in to {cfg['url']} as {who.get('display') or who.get('id') or 'you'}. Saved to {CONFIG}.")
    return 0


def _cmd_ops(args: argparse.Namespace) -> int:
    words = [w.lower() for w in args.words]
    for op in operations(_config()):
        text = f"{op['name']} {op.get('description') or ''}".lower()
        if all(w in text for w in words):
            first = (op.get("description") or "").split(". ")[0].strip()
            print(f"{op['name']:28} {'w' if op.get('mutating') else ' '} {first[:90]}")
    return 0


def _cmd_help(args: argparse.Namespace) -> int:
    print(describe(_find(operations(_config()), args.operation)))
    return 0


def _cmd_call(name: str, rest: list[str]) -> int:
    parser = argparse.ArgumentParser(prog=f"commonindex {name}", add_help=False)
    parser.add_argument("--json", dest="raw_json", help="the body as JSON, or - to read it from stdin")
    parser.add_argument("--space", help="the space to act in, where the token holds more than one")
    parser.add_argument("--compact", action="store_true", help="one line of JSON, for piping")
    parser.add_argument("-h", "--help", action="store_true")
    args, pairs = parser.parse_known_args(rest)
    cfg = _config()
    op = _find(operations(cfg), name)
    if args.help:
        print(describe(op))
        return 0
    body = build_body(op, pairs, args.raw_json)
    if args.space:
        body["space_id"] = args.space
    out = _request(cfg, "POST", f"/api/v1/{name}", body)
    print(json.dumps(out, default=str) if args.compact else json.dumps(out, indent=2, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if argv and "." in argv[0] and not argv[0].startswith("-"):
            return _cmd_call(argv[0], argv[1:])
        parser = argparse.ArgumentParser(
            prog="commonindex", description="The platform from a terminal: every operation the gateway serves. "
                                        "Call one as `commonindex <operation> name=value ...`.")
        sub = parser.add_subparsers(dest="command")
        login = sub.add_parser("login", help="save the gateway's address and your token")
        login.add_argument("--url", default="http://localhost:8000")
        login.add_argument("--token", required=True)
        login.set_defaults(run=_cmd_login)
        ops = sub.add_parser("ops", help="list operations, optionally filtered by words")
        ops.add_argument("words", nargs="*")
        ops.set_defaults(run=_cmd_ops)
        helps = sub.add_parser("help", help="what one operation does and the fields it takes")
        helps.add_argument("operation")
        helps.set_defaults(run=_cmd_help)
        args = parser.parse_args(argv)
        if not getattr(args, "run", None):
            parser.print_help()
            return 0
        return args.run(args)
    except CliError as e:
        print(f"commonindex: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
