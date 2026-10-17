"""The production compose file: what a deployment gets without editing it.

Read as YAML, not run: these are settings that are wrong silently. Without the
gateway URL, single sign-on sent people back to http://localhost:8000 and set
its sign-in cookie without `secure`; without the model extra, choosing
Anthropic failed at the first request.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def _gateway_env() -> dict:
    compose = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
    return compose["services"]["gateway"]["environment"]


def test_single_sign_on_calls_back_to_the_public_address():
    env = _gateway_env()
    # The web server passes /auth/ to the gateway (web/nginx.conf), so browsers
    # reach it at the app's own address.
    assert env["COMMONINDEX_GATEWAY_URL"] == "${COMMONINDEX_PUBLIC_URL}"
    assert "location ~ ^/(api|auth|share)/" in (ROOT / "web" / "nginx.conf").read_text()


def test_the_image_installs_every_model_provider_it_offers():
    dockerfile = (ROOT / "Dockerfile").read_text()
    syncs = [line for line in dockerfile.splitlines() if line.startswith("RUN uv sync")]
    assert syncs and all("--extra model" in line for line in syncs), syncs
