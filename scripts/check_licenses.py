"""Fail the build when anything the platform uses is not permissively licensed.

The platform is sold to enterprises and may be installed on their own
machines, where a copyleft or source-available license — AGPL, GPL, SSPL,
BSL, the Elastic License, the Commons Clause, a non-commercial clause — is a
procurement blocker and an obligation nobody signed up for. So this is an
allow-list, not a deny-list: a license passes only if it is one of the
permissive ones below. A license nobody has looked at fails until somebody
has, because the dangerous case is the one no list anticipated.

Checked from what is installed, with no network:

* every Python distribution in the project environment (`uv run`), which
  must match uv.lock with every extra — a package missing or at another
  version fails, so a partial install cannot pass,
* every npm package under web/node_modules, dev tools included — what the
  team runs is as much the product's exposure as what it ships — and under
  render/node_modules, the video renderer the gateway runs, each at the
  version package-lock.json names,
* every container image the project runs as a service (docker-compose.yml,
  deploy/k8s, the Makefile's *_IMAGE defaults), against a reviewed list,
  because an image declares no license of its own.

A dependency that fails can be let through only by recording why in
REVIEWED below — a decision with a reason, not a silenced warning.

    make licenses        # or: uv run python scripts/check_licenses.py
"""

from __future__ import annotations

import importlib.metadata as md
import json
import re
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: Permissive licenses, by SPDX identifier. Adding one here is a policy change:
#: it must impose no copyleft, source-disclosure, field-of-use or commercial
#: restriction.
ALLOWED = {
    "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "ISC",
    "PostgreSQL", "PSF-2.0", "Python-2.0", "Unlicense", "CC0-1.0", "CC-BY-4.0",
    "BlueOak-1.0.0", "Zlib", "Public-Domain",
}

#: Copyleft and source-available families, named so a failure says what the
#: problem is. Anything else outside ALLOWED fails as "not reviewed".
DENIED = re.compile(
    r"^(AGPL|GPL|LGPL|SSPL|BUSL|BSL|Elastic|Commons-Clause|CC-BY-NC|CC-BY-SA|CC-BY-ND|"
    r"MPL|EPL|EUPL|CDDL|OSL|UNLICENSED)", re.IGNORECASE)

#: Old-style license names and Trove classifiers, to their SPDX identifiers.
ALIASES = {
    "mit license": "MIT", "mit": "MIT", "the mit license": "MIT", "mit no attribution license (mit-0)": "MIT-0",
    "apache software license": "Apache-2.0", "apache 2.0": "Apache-2.0", "apache-2": "Apache-2.0",
    "apache license 2.0": "Apache-2.0", "apache license, version 2.0": "Apache-2.0", "apache 2": "Apache-2.0",
    "bsd license": "BSD-3-Clause", "bsd": "BSD-3-Clause", "new bsd license": "BSD-3-Clause",
    "3-clause bsd license": "BSD-3-Clause", "bsd 3-clause": "BSD-3-Clause", "2-clause bsd license": "BSD-2-Clause",
    "isc license (iscl)": "ISC", "isc license": "ISC",
    "python software foundation license": "PSF-2.0", "psf": "PSF-2.0",
    "the unlicense (unlicense)": "Unlicense", "public domain": "Public-Domain",
    "mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
    "gnu general public license v2 (gplv2)": "GPL-2.0", "gnu general public license v3 (gplv3)": "GPL-3.0",
    "gnu general public license (gpl)": "GPL", "gnu affero general public license v3": "AGPL-3.0",
    "gnu lesser general public license v2 (lgplv2)": "LGPL-2.0",
    "gnu lesser general public license v3 (lgplv3)": "LGPL-3.0",
    "gnu library or lesser general public license (lgpl)": "LGPL",
}

#: Dependencies let through by a person who read the license, with why. Keyed
#: by (ecosystem, name); a key ending in "*" covers every name it begins
#: (one library's per-platform builds).
REVIEWED: dict[tuple[str, str], str] = {
    ("python", "certifi"): "MPL-2.0: Mozilla's CA certificate bundle, used unmodified, needed only by "
                           "the optional bigquery and snowflake extras; MPL obligations attach to its "
                           "own files, not to code that uses them",
}

#: Files inside a dependency licensed differently from the package itself,
#: which package metadata cannot show. Read, and recorded so the summary names
#: them: (ecosystem, package, file) -> why.
COMPONENTS_REVIEWED: dict[tuple[str, str, str], str] = {
    ("python", "botocore", "botocore/cacert.pem"):
        "MPL-2.0: Mozilla's CA certificate bundle inside an Apache-2.0 package (the s3 extra), "
        "unmodified; MPL obligations attach to that file only",
}

#: Programs the platform runs but never ships, so never checked here: the
#: deployment installs them, and they are invoked as separate programs (a
#: command line, files in and out), which the GPL FAQ calls mere aggregation.
#: Listed so the decision is written down where the policy lives.
EXTERNAL_PROGRAMS = {
    "ffmpeg": "LGPL-2.1+/GPL-2.0+ by build; the renderer calls it as a separate program to encode "
              "video. Not bundled, not a dependency — docs/videos.md says how to install one. "
              "The Dockerfile's `video` target installs Debian's package into an image the "
              "deployer builds; it is never published.",
    "chromium": "BSD-3-Clause and others; the renderer drives it as a separate program. Installed "
                "from Debian by the `video` target, in an image the deployer builds.",
    "git": "GPL-2.0; cloning repositories for code search, run as a separate program. Installed "
           "from Debian by the `tools` target, in an image the deployer builds.",
}

#: Images the project runs, with the license of what is in them. Their base OS
#: layers carry the usual distribution packages, as every Linux image does.
IMAGES = {
    "pgvector/pgvector": "PostgreSQL",           # Postgres and pgvector, both PostgreSQL License
    # Base images the Dockerfiles build on. Each also carries its Linux
    # distribution's packages (some GPL, like any Linux system); an image
    # distributed to others carries those packages' notices and source offer.
    "python": "PSF-2.0",
    "node": "MIT",
    "nginx": "BSD-2-Clause",
    "ghcr.io/astral-sh/uv": "Apache-2.0 OR MIT",
    "sourcegraph/zoekt-webserver": "Apache-2.0",
    "sourcegraph/zoekt-indexserver": "Apache-2.0",
}
#: The platform's own images — ours, not a dependency.
OWN_IMAGES = ("commonindex",)


@dataclass(frozen=True, slots=True)
class Finding:
    ecosystem: str
    name: str
    version: str
    license: str
    why: str


# ── deciding one license expression ──────────────────────────────────────


def _tokens(expression: str) -> list[str]:
    return re.findall(r"\(|\)|[^\s()]+", expression)


def verdict(expression: str | None) -> tuple[bool, str]:
    """Whether a license expression is allowed, and if not, why.

    SPDX: `A OR B` is allowed when either is (the licensee chooses), `A AND B`
    only when both are, and `A WITH exception` is judged as `A` — exceptions
    only ever grant more.
    """
    text = (expression or "").strip()
    if not text or text.upper() in ("UNKNOWN", "NONE", "NOASSERTION"):
        return False, "no license declared — review it"
    if text.upper().startswith("SEE LICENSE"):
        return False, "a custom license file — review it"
    tokens = _tokens(text)
    pos = 0

    def expr() -> tuple[bool, str]:
        nonlocal pos
        ok, why = term()
        while pos < len(tokens) and tokens[pos].upper() == "OR":
            pos += 1
            ok2, why2 = term()
            ok, why = (True, "") if (ok or ok2) else (False, why or why2)
        return ok, why

    def term() -> tuple[bool, str]:
        nonlocal pos
        ok, why = factor()
        while pos < len(tokens) and tokens[pos].upper() == "AND":
            pos += 1
            ok2, why2 = factor()
            ok, why = (ok and ok2), (why or why2)
        return ok, why

    def factor() -> tuple[bool, str]:
        nonlocal pos
        if pos < len(tokens) and tokens[pos] == "(":
            pos += 1
            out = expr()
            if pos >= len(tokens) or tokens[pos] != ")":
                raise ValueError("an unclosed parenthesis")
            pos += 1
            return out
        name = tokens[pos] if pos < len(tokens) else ""
        if not name or name.upper() in ("AND", "OR", "WITH") or name in ("(", ")"):
            raise ValueError(f"a license name expected, found {name or 'nothing'!r}")
        pos += 1
        if pos < len(tokens) and tokens[pos].upper() == "WITH":
            after = tokens[pos + 1] if pos + 1 < len(tokens) else ""
            # "MIT WITH OR" read OR as the exception and passed.
            if not after or after in ("(", ")") or after.upper() in ("AND", "OR", "WITH"):
                raise ValueError("WITH without an exception")
            pos += 2   # the exception adds permissions; the base license decides
        return _one(name)

    # Strict: the whole expression must parse. "MIT GPL-3.0" was read as MIT
    # and passed, with the GPL never looked at.
    if len(tokens) == 1:
        return _one(tokens[0])
    try:
        out = expr()
        if pos != len(tokens):
            raise ValueError(f"{' '.join(tokens[pos:])!r} left over")
        return out
    except ValueError as e:
        return False, f"not a valid license expression ({e}) — review it"


def _one(name: str) -> tuple[bool, str]:
    spdx = ALIASES.get(name.lower(), name).removesuffix("+")
    spdx = re.sub(r"-(only|or-later)$", "", spdx)
    if spdx in ALLOWED:
        return True, ""
    if DENIED.match(spdx):
        return False, f"{spdx} is copyleft or source-available — not allowed"
    return False, f"{spdx} has not been reviewed — allowed only if it is permissive"


# ── what is installed ────────────────────────────────────────────────────


def python_license(meta) -> str:
    """The license a distribution declares: its SPDX expression (PEP 639),
    else its Trove classifiers (several mean a choice), else its free-text
    License field when that is a name rather than a whole license text."""
    expression = (meta.get("License-Expression") or "").strip()
    if expression:
        return expression
    classifiers = [c.split("::")[-1].strip() for c in (meta.get_all("Classifier") or [])
                   if c.startswith("License ::") and "OSI Approved ::" in c or c.startswith("License :: Public Domain")]
    named = [ALIASES.get(c.lower(), c) for c in classifiers]
    if named:
        return " OR ".join(dict.fromkeys(named))
    raw = (meta.get("License") or "").strip()
    if raw and len(raw) <= 80 and "\n" not in raw:
        return ALIASES.get(raw.lower(), raw)
    return "UNKNOWN"


#: Recognisable opening words of a licence file, for a package whose metadata
#: declares none (google-crc32c ships Apache-2.0's text and no field).
LICENSE_TEXTS = (
    (re.compile(r"Apache License\s+Version 2\.0", re.IGNORECASE), "Apache-2.0"),
    (re.compile(r"Permission is hereby granted, free of charge", re.IGNORECASE), "MIT"),
    (re.compile(r"Redistribution and use in source and binary forms.*?Neither the name", re.IGNORECASE | re.DOTALL), "BSD-3-Clause"),
    (re.compile(r"Permission to use, copy, modify, and(/or)? distribute this software for any", re.IGNORECASE), "ISC"),
)


def license_from_files(dist) -> str:
    """The licence a distribution's own licence file shows, or UNKNOWN. Only
    one recognisable licence counts: a file naming two is left for a person."""
    found = set()
    for f in dist.files or []:
        if not re.search(r"(^|/)(LICEN[CS]E|COPYING)[^/]*$", str(f), re.IGNORECASE):
            continue
        try:
            text = dist.locate_file(f).read_text(errors="replace")[:20000]
        except OSError:
            continue
        found |= {spdx for pattern, spdx in LICENSE_TEXTS if pattern.search(text)}
    return found.pop() if len(found) == 1 else "UNKNOWN"


def locked_python(lock: Path | None = None) -> dict[str, str]:
    """Every package uv.lock installs for the project with all its extras and
    no dev tools, for this machine: name -> version. An optional connector's
    dependencies are what a customer installs, so they are checked too."""
    from packaging.markers import Marker

    data = tomllib.loads((lock or ROOT / "uv.lock").read_text())
    own = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["name"]
    by_name: dict[str, list[dict]] = {}
    for pkg in data.get("package", []):
        by_name.setdefault(pkg["name"], []).append(pkg)

    def applies(dep: dict) -> bool:
        marker = dep.get("marker")
        return not marker or Marker(marker).evaluate({"extra": ""})

    def pick(dep: dict) -> dict | None:
        options = by_name.get(dep["name"], [])
        if "version" in dep:
            options = [o for o in options if o["version"] == dep["version"]] or options
        live = [o for o in options if all(Marker(m).evaluate({"extra": ""})
                                         for m in o.get("resolution-markers", [])[:1])] or options
        return live[0] if live else None

    root = by_name[own][0]
    todo = [d for d in root.get("dependencies", []) if applies(d)]
    for deps in (root.get("optional-dependencies") or {}).values():
        todo += [d for d in deps if applies(d)]
    out: dict[str, str] = {}
    while todo:
        dep = todo.pop()
        pkg = pick(dep)
        if pkg is None or pkg["name"] in out:
            continue
        out[pkg["name"]] = pkg["version"]
        todo += [d for d in pkg.get("dependencies", []) if applies(d)]
        for extra in dep.get("extra", []):
            todo += [d for d in (pkg.get("optional-dependencies") or {}).get(extra, []) if applies(d)]
    return out


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def python_findings() -> tuple[int, list[Finding]]:
    own = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["name"]
    seen, out, installed = 0, [], {}
    for dist in md.distributions():
        name = dist.metadata.get("Name") or ""
        if not name or _norm(name) == _norm(own):
            continue
        seen += 1
        installed[_norm(name)] = dist.version
        lic = python_license(dist.metadata)
        if lic == "UNKNOWN":
            lic = license_from_files(dist)
        ok, why = verdict(lic)
        if not ok and not reviewed("python", name.lower()):
            out.append(Finding("python", name, dist.version, lic, why))
        for (eco, pkg, path), why_ok in COMPONENTS_REVIEWED.items():
            if eco == "python" and _norm(pkg) == _norm(name) and any(str(f) == path for f in dist.files or []):
                LET_THROUGH.append(f"{path} ({why_ok})")
    # What is installed must be what uv.lock says, with every extra: a partial
    # install (no extras, a missing package) passed while checking part of it.
    for name, version in sorted(locked_python().items()):
        have = installed.get(_norm(name))
        if have is None:
            out.append(Finding("python", name, version, "NOT INSTALLED",
                               "in uv.lock but not installed, so not checked — run with every extra "
                               "(`make licenses`)"))
        elif have != version:
            out.append(Finding("python", name, have, "VERSION",
                               f"uv.lock has {version}, so what was checked is not what is locked — `uv sync`"))
    return seen, out


def npm_license(pkg: dict) -> str:
    lic = pkg.get("license")
    if isinstance(lic, dict):
        lic = lic.get("type")
    if not lic and isinstance(pkg.get("licenses"), list):
        lic = " OR ".join(str(x.get("type") if isinstance(x, dict) else x) for x in pkg["licenses"])
    return str(lic or "UNKNOWN")


#: The reviewed exceptions a run let through, so the summary names them
#: rather than counting them as permissive.
LET_THROUGH: list[str] = []


def reviewed(ecosystem: str, name: str) -> bool:
    for (eco, key), why in REVIEWED.items():
        if eco == ecosystem and (key == name or (key.endswith("*") and name.startswith(key[:-1]))):
            LET_THROUGH.append(f"{name} ({why})")
            return True
    return False


NPM_ROOTS = (ROOT / "web" / "node_modules", ROOT / "render" / "node_modules")

#: Licence banners of restricted code, looked for inside the files of every
#: production dependency. A package's metadata names its own licence, not what
#: it bundles: a video renderer declared Apache-2.0 while shipping GSAP, whose
#: licence restricts no-code animation tools.
BUNDLED = re.compile(
    r"GreenSock|gsap\.com/(standard-license|licensing)|GNU Affero General Public License"
    r"|Server Side Public License|Business Source License|Commons Clause|GNU General Public License",
    re.IGNORECASE)
SCANNED = (".js", ".mjs", ".cjs")
#: Bundled findings read and judged acceptable: (package, banner) -> why.
BUNDLED_REVIEWED: dict[tuple[str, str], str] = {}


def bundled_findings(roots: tuple[Path, ...] | Path = NPM_ROOTS) -> tuple[int, list[Finding]]:
    """Restricted licence banners inside production dependencies' code."""
    out, scanned = [], 0
    for root in (roots,) if isinstance(roots, Path) else roots:
        lock = root.parent / "package-lock.json"
        if not lock.is_file() or not root.is_dir():
            continue
        packages = json.loads(lock.read_text()).get("packages") or {}
        for path, info in packages.items():
            if not path or info.get("dev") or info.get("devOptional"):
                continue
            folder = root.parent / path
            if not folder.is_dir():
                continue
            name = path.rsplit("node_modules/", 1)[-1]
            hits: set[str] = set()
            for f in folder.rglob("*"):
                if f.suffix not in SCANNED or "node_modules" in f.relative_to(folder).parts or not f.is_file():
                    continue
                scanned += 1
                try:
                    text = f.read_text(errors="replace")
                except OSError:
                    continue
                hits.update(m.group(0).lower() for m in BUNDLED.finditer(text))
            for hit in sorted(hits):
                if (name, hit) not in BUNDLED_REVIEWED:
                    out.append(Finding("bundled", name, info.get("version") or "?", hit,
                                       "its code carries this licence banner — read what it bundles before allowing it"))
    return scanned, out


def not_installed(root: Path, lock: Path) -> list[str]:
    """The packages package-lock.json requires that are not installed under
    `root`'s project. Optional ones (another platform's build of a native
    library) may be absent and are skipped."""
    try:
        packages = json.loads(lock.read_text()).get("packages") or {}
    except (ValueError, OSError):
        return ["package-lock.json (unreadable)"]
    missing = []
    for at, meta in packages.items():
        if not at.startswith("node_modules/") or meta.get("optional") or meta.get("devOptional") or meta.get("link"):
            continue
        manifest = root.parent / at / "package.json"
        if not manifest.is_file():
            missing.append(at.split("node_modules/")[-1])
            continue
        # A different version installed is not the one the lockfile names, and
        # not the one whose licence the lockfile review saw.
        try:
            have = json.loads(manifest.read_text()).get("version")
        except (ValueError, OSError):
            have = None
        if meta.get("version") and have != meta["version"]:
            missing.append(f"{at.split('node_modules/')[-1]} ({have or '?'} installed, {meta['version']} locked)")
    return sorted(missing)


def npm_findings(roots: tuple[Path, ...] | Path = NPM_ROOTS) -> tuple[int, list[Finding]]:
    seen: dict[tuple[str, str], str] = {}

    def walk(folder: Path) -> None:
        if not folder.is_dir():
            return
        for entry in folder.iterdir():
            if entry.name.startswith("."):
                continue
            if entry.name.startswith("@"):
                walk(entry)
                continue
            manifest = entry / "package.json"
            if manifest.is_file():
                try:
                    pkg = json.loads(manifest.read_text())
                    seen[(pkg.get("name") or entry.name, pkg.get("version") or "?")] = npm_license(pkg)
                except (ValueError, OSError):
                    seen[(entry.name, "?")] = "UNKNOWN"
            walk(entry / "node_modules")

    out = []
    for root in (roots,) if isinstance(roots, Path) else roots:
        # What is installed must be what the lockfile says, or the scan passes
        # while checking a part of it: nothing installed, an empty folder, or
        # a partial install all read as "no findings" otherwise.
        lock = root.parent / "package-lock.json"
        if lock.is_file():
            missing = not_installed(root, lock)
            if missing:
                where = root.parent.relative_to(ROOT) if root.parent.is_relative_to(ROOT) else root.parent
                out.append(Finding("npm", str(where), "", "NOT AS LOCKED",
                                   f"{len(missing)} package(s) in package-lock.json are not installed as locked "
                                   f"({', '.join(missing[:3])}{', …' if len(missing) > 3 else ''}), so not "
                                   "checked — run `npm ci` there first"))
        walk(root)
    for (name, version), lic in sorted(seen.items()):
        ok, why = verdict(lic)
        if not ok and not reviewed("npm", name):
            out.append(Finding("npm", name, version, lic, why))
    return len(seen), out


def images_in_use() -> set[str]:
    """Every image named where the project runs services, without its tag."""
    names: set[str] = set()
    sources = [*sorted(ROOT.glob("docker-compose*.yml")), *sorted((ROOT / "deploy").rglob("*.y*ml")), ROOT / "Makefile"]
    for path in sources:
        if not path.is_file():
            continue
        for match in re.finditer(r"(?:^\s*image:\s*|_IMAGE\s*\?=\s*)([^\s#]+)", path.read_text(), re.MULTILINE):
            names.add(re.sub(r"[:@].*$", "", match.group(1).strip("\"'")))
    # Base images, and images copied from, in every Dockerfile — but not a
    # build stage the same file names (`FROM runtime AS tools`).
    for path in [ROOT / "Dockerfile", *sorted(ROOT.glob("*/Dockerfile"))]:
        if not path.is_file():
            continue
        text = path.read_text()
        stages = set(re.findall(r"^FROM\s+\S+\s+AS\s+(\S+)", text, re.MULTILINE | re.IGNORECASE))
        for ref in re.findall(r"^FROM\s+(\S+)", text, re.MULTILINE) + re.findall(r"COPY\s+--from=(\S+)", text):
            if ref not in stages:
                names.add(re.sub(r"[:@].*$", "", ref))
    return {n for n in names if n and "$" not in n and not n.startswith(OWN_IMAGES)}


def image_findings() -> tuple[int, list[Finding]]:
    used = images_in_use()
    out = []
    for image in sorted(used):
        lic = IMAGES.get(image)
        if lic is None:
            out.append(Finding("image", image, "", "UNKNOWN",
                               "not in the reviewed images — add it to IMAGES with its license"))
            continue
        ok, why = verdict(lic)
        if not ok:
            out.append(Finding("image", image, "", lic, why))
    return len(used), out


def main() -> int:
    counts, findings = {}, []
    for label, check in (("python", python_findings), ("npm", npm_findings), ("images", image_findings),
                         ("files scanned", bundled_findings)):
        seen, found = check()
        counts[label] = seen
        findings += found
        # Nothing found to check is not a pass: an empty environment, or a
        # folder that was never installed, reported "all permissive" before.
        if seen == 0:
            findings.append(Finding(label, "(nothing)", "", "EMPTY",
                                    f"no {label} found to check — install the dependencies first"))
    summary = " · ".join(f"{n} {label}" for label, n in counts.items())
    if not findings:
        if LET_THROUGH:
            print(f"licenses: {summary} — all permissive, except {len(set(LET_THROUGH))} reviewed exception(s): "
                  + "; ".join(sorted(set(LET_THROUGH))))
        else:
            print(f"licenses: {summary} — all permissive")
        return 0
    print(f"License check failed — {len(findings)} of {summary} need attention:\n", file=sys.stderr)
    for f in findings:
        what = f"{f.name}@{f.version}" if f.version else f.name
        print(f"  {f.ecosystem:<7}{what:<44}{f.license:<22}{f.why}", file=sys.stderr)
    print("\nAllowed: " + ", ".join(sorted(ALLOWED)) + ".\nTo let one through after reading "
          "its license, record why in REVIEWED in scripts/check_licenses.py.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
