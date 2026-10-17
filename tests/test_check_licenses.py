"""The license check: only permissive licenses in anything installed or run.

The platform is sold to enterprises, where a copyleft or source-available
dependency is a procurement blocker. What is defended: the rule is an
allow-list, so a license nobody reviewed fails; a choice (`OR`) passes when
any option is permissive and a combination (`AND`) only when all are; a
license is read the way each ecosystem declares it; a service image nobody
reviewed fails; a reviewed exception needs its reason; and the repository as
it stands passes.
"""

from __future__ import annotations

import email.message
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("check_licenses", ROOT / "scripts" / "check_licenses.py")
lic = importlib.util.module_from_spec(_spec)
sys.modules["check_licenses"] = lic   # its dataclass looks its module up by name
_spec.loader.exec_module(lic)


@pytest.mark.parametrize("expression", [
    "MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "MIT-0", "PSF-2.0", "0BSD", "CC0-1.0",
    "Apache-2.0 OR BSD-2-Clause", "MIT AND PSF-2.0", "(MIT OR GPL-3.0-only)",
    "Apache-2.0 WITH LLVM-exception", "mit",
])
def test_permissive_licenses_pass(expression):
    assert lic.verdict(expression) == (True, "")


@pytest.mark.parametrize("expression, family", [
    ("AGPL-3.0", "AGPL"), ("GPL-3.0-or-later", "GPL"), ("LGPL-2.1-only", "LGPL"),
    ("SSPL-1.0", "SSPL"), ("BUSL-1.1", "BUSL"), ("Elastic-2.0", "Elastic"),
    ("CC-BY-NC-4.0", "CC-BY-NC"), ("MPL-2.0", "MPL"), ("MIT AND GPL-3.0-only", "GPL"),
    ("UNLICENSED", "UNLICENSED"),
])
def test_copyleft_and_source_available_fail_saying_so(expression, family):
    ok, why = lic.verdict(expression)
    assert not ok and family in why and "not allowed" in why


@pytest.mark.parametrize("expression", ["Some-Custom-License", "", "UNKNOWN", "SEE LICENSE IN LICENSE.md"])
def test_anything_unreviewed_fails_until_somebody_reviews_it(expression):
    ok, why = lic.verdict(expression)
    assert not ok and "review" in why


def _meta(**headers):
    m = email.message.Message()
    for key, value in headers.items():
        for v in (value if isinstance(value, list) else [value]):
            m[key.replace("_", "-")] = v
    return m


def test_a_python_license_is_read_the_way_it_is_declared():
    assert lic.python_license(_meta(License_Expression="MIT OR Apache-2.0")) == "MIT OR Apache-2.0"
    assert lic.python_license(_meta(Classifier=["License :: OSI Approved :: BSD License"])) == "BSD-3-Clause"
    assert lic.python_license(_meta(Classifier=[
        "License :: OSI Approved :: MIT License",
        "License :: OSI Approved :: Apache Software License"])) == "MIT OR Apache-2.0"
    assert lic.python_license(_meta(License="Apache 2.0")) == "Apache-2.0"
    # A whole license text in the field is not a name to judge by.
    assert lic.python_license(_meta(License="Copyright (c) someone\n\nPermission is hereby granted...")) == "UNKNOWN"
    assert lic.python_license(_meta(Classifier=["License :: OSI Approved :: GNU General Public License v3 (GPLv3)"])) \
        == "GPL-3.0"


def test_npm_packages_are_all_checked_scoped_and_nested(tmp_path):
    def pkg(path, **fields):
        (tmp_path / path).mkdir(parents=True)
        (tmp_path / path / "package.json").write_text(json.dumps(fields))

    pkg("fine", name="fine", version="1.0.0", license="MIT")
    pkg("dual", name="dual", version="1.0.0", licenses=[{"type": "MIT"}, {"type": "GPL-2.0"}])
    pkg("@scope/closed", name="@scope/closed", version="2.0.0", license="AGPL-3.0")
    pkg("fine/node_modules/deep", name="deep", version="0.1.0", license={"type": "GPL-3.0"})
    pkg("custom", name="custom", version="3.0.0", license="SEE LICENSE IN LICENSE.txt")

    seen, found = lic.npm_findings(tmp_path)
    assert seen == 5
    assert {(f.name, f.license) for f in found} == {
        ("@scope/closed", "AGPL-3.0"), ("deep", "GPL-3.0"), ("custom", "SEE LICENSE IN LICENSE.txt")}


def test_a_service_image_nobody_reviewed_fails(tmp_path, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text(
        "services:\n  db:\n    image: pgvector/pgvector:pg17\n  files:\n    image: minio/minio:latest\n"
        "  app:\n    image: commonindex:local\n")
    monkeypatch.setattr(lic, "ROOT", tmp_path)
    seen, found = lic.image_findings()
    assert seen == 2   # the platform's own image is not a dependency
    assert [(f.name, f.license) for f in found] == [("minio/minio", "UNKNOWN")]


def test_a_reviewed_exception_lets_one_through(tmp_path, monkeypatch):
    (tmp_path / "odd").mkdir()
    (tmp_path / "odd" / "package.json").write_text(json.dumps({"name": "odd", "version": "1", "license": "Odd-1.0"}))
    assert lic.npm_findings(tmp_path)[1]
    monkeypatch.setitem(lic.REVIEWED, ("npm", "odd"), "read it: permissive, attribution only")
    assert lic.npm_findings(tmp_path)[1] == []


def test_the_repository_as_it_stands_passes(capsys, monkeypatch):
    # Licences only: the test run adds pytest and leaves the optional extras
    # out, so it is not the install `make licenses` compares with uv.lock.
    # That comparison has its own tests below.
    monkeypatch.setattr(lic, "locked_python", dict)
    assert lic.main() == 0, capsys.readouterr().err


def test_a_lockfile_with_nothing_installed_fails_rather_than_passing(tmp_path):
    # The scan used to report "0 npm — all permissive" when node_modules was
    # missing: it passed while checking nothing.
    (tmp_path / "package-lock.json").write_text('{"packages": {"node_modules/react": {"version": "19.0.0"}}}')
    _, found = lic.npm_findings(tmp_path / "node_modules")
    assert found and found[0].license == "NOT AS LOCKED"


def test_dockerfile_base_images_are_checked():
    used = lic.images_in_use()
    assert {"python", "node", "nginx", "ghcr.io/astral-sh/uv"} <= used
    assert "runtime" not in used and "tools" not in used   # build stages, not images


def test_an_empty_or_partial_install_fails(tmp_path):
    # An existing node_modules with a package missing used to pass: the scan
    # only checked that the folder existed.
    import json

    (tmp_path / "package-lock.json").write_text(json.dumps({"packages": {
        "": {}, "node_modules/left-pad": {"version": "1.3.0"},
        "node_modules/@img/sharp-linux-x64": {"version": "1", "optional": True}}}))
    (tmp_path / "node_modules").mkdir()
    _, found = lic.npm_findings(tmp_path / "node_modules")
    assert found and found[0].license == "NOT AS LOCKED" and "left-pad" in found[0].why
    (tmp_path / "node_modules" / "left-pad").mkdir()
    (tmp_path / "node_modules" / "left-pad" / "package.json").write_text(
        '{"name": "left-pad", "version": "1.3.0", "license": "MIT"}')
    assert lic.npm_findings(tmp_path / "node_modules")[1] == []   # the optional one may be absent


def test_an_npm_package_installed_at_another_version_fails(tmp_path):
    # Installed 1.2.0 where the lockfile says 1.3.0 passed: the licence that
    # was checked was not the locked one's.
    (tmp_path / "package-lock.json").write_text(json.dumps({"packages": {
        "": {}, "node_modules/left-pad": {"version": "1.3.0"}}}))
    (tmp_path / "node_modules" / "left-pad").mkdir(parents=True)
    (tmp_path / "node_modules" / "left-pad" / "package.json").write_text(
        '{"name": "left-pad", "version": "1.2.0", "license": "MIT"}')
    _, found = lic.npm_findings(tmp_path / "node_modules")
    assert found and "1.2.0 installed, 1.3.0 locked" in found[0].why


def test_a_partial_python_install_fails(monkeypatch):
    # A Python environment missing a locked package (an extra not installed)
    # passed: only what happened to be installed was checked.
    import importlib.metadata as md

    pytest_version = md.version("pytest")
    monkeypatch.setattr(lic, "locked_python", lambda: {"not-installed-anywhere": "1.0", "pytest": "0.0.1"})
    _, found = lic.python_findings()
    by_name = {f.name: f for f in found}
    assert by_name["not-installed-anywhere"].license == "NOT INSTALLED"
    assert by_name["pytest"].license == "VERSION" and by_name["pytest"].version == pytest_version


def test_the_lockfile_inventory_includes_every_extra():
    locked = lic.locked_python()
    assert {"fastapi", "boto3", "anthropic", "snowflake-sqlalchemy"} <= set(locked)
    assert "pytest" not in locked and "ruff" not in locked     # dev tools are not shipped


def test_a_license_is_read_from_its_file_when_metadata_names_none(tmp_path):
    # google-crc32c declares nothing and ships Apache-2.0's text.
    (tmp_path / "LICENSE").write_text("                Apache License\n          Version 2.0, January 2004\n")

    class Dist:
        files = ("LICENSE", "pkg/__init__.py")

        def locate_file(self, f):
            return tmp_path / f

    assert lic.license_from_files(Dist()) == "Apache-2.0"
    (tmp_path / "LICENSE").write_text("All rights reserved.")
    assert lic.license_from_files(Dist()) == "UNKNOWN"


@pytest.mark.parametrize("expression, why", [
    ("MIT GPL-3.0", "left over"),                 # two names, no operator: was read as MIT
    ("(MIT OR Apache-2.0", "unclosed"),
    ("MIT OR", "license name expected"),
    ("AND MIT", "license name expected"),
    ("GPL-2.0 WITH", "WITH without an exception"),
    ("MIT WITH OR", "WITH without an exception"),  # an operator is not an exception
    ("MIT WITH AND GPL-3.0", "WITH without an exception"),
])
def test_a_malformed_expression_fails_instead_of_passing_on_its_first_name(expression, why):
    ok, reason = lic.verdict(expression)
    assert not ok and why in reason


def test_a_well_formed_compound_expression_still_passes():
    assert lic.verdict("MIT AND (Apache-2.0 OR BSD-3-Clause)") == (True, "")
    assert lic.verdict("Apache-2.0 WITH LLVM-exception")[0]


def _package(root, name, files, dev=False):
    folder = root / "node_modules" / name
    folder.mkdir(parents=True)
    (folder / "package.json").write_text(json.dumps({"name": name, "version": "1.0.0", "license": "Apache-2.0"}))
    for path, text in files.items():
        (folder / path).parent.mkdir(parents=True, exist_ok=True)
        (folder / path).write_text(text)
    return {f"node_modules/{name}": {"version": "1.0.0", **({"dev": True} if dev else {})}}


def test_a_restricted_library_bundled_inside_a_permissive_package_is_found(tmp_path):
    """Metadata names a package's own licence, not what it carries: a renderer
    declared Apache-2.0 while shipping GSAP in a bundle."""
    packages = {"": {}}
    packages |= _package(tmp_path, "renderer", {"dist/studio.js": "/*! GSAP 3.15.0 https://gsap.com  @license Copyright GreenSock */"})
    packages |= _package(tmp_path, "clean", {"index.js": "module.exports = 1"})
    packages |= _package(tmp_path, "build-tool", {"x.js": "GNU General Public License"}, dev=True)   # never shipped
    (tmp_path / "package-lock.json").write_text(json.dumps({"packages": packages}))

    scanned, found = lic.bundled_findings(tmp_path / "node_modules")

    assert scanned == 2
    assert [(f.name, f.license) for f in found] == [("renderer", "greensock")]


def test_checking_nothing_is_not_a_pass(monkeypatch, capsys):
    """An empty environment reported "all permissive" — of nothing."""
    monkeypatch.setattr(lic, "python_findings", lambda: (0, []))
    assert lic.main() == 1
    assert "no python found to check" in capsys.readouterr().err
