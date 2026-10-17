# CommonIndex — one image, two entrypoints.
#
# The gateway (default CMD) and the Code Query cron
# (`python -m commonindex.workers.codequery`, set as the k8s CronJob's command —
# see deploy/k8s/local/codequery-cronjob.yaml) run the same image. One image
# to build and load into a local cluster, not two kept in sync by hand.

FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /bin/
WORKDIR /app

# Dependencies first, from the lockfile alone, so this layer only rebuilds
# when pyproject.toml/uv.lock actually change — not on every source edit.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev --extra s3 --extra model

COPY commonindex/ commonindex/
COPY commonindex_enterprise/ commonindex_enterprise/
RUN uv sync --frozen --no-dev --extra s3 --extra model

FROM python:3.12-slim AS runtime
RUN useradd --create-home --uid 10001 commonindex
WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY commonindex/ commonindex/
COPY commonindex_enterprise/ commonindex_enterprise/
COPY migrations/ migrations/
COPY types/ types/
COPY scripts/migrate.py scripts/migrate.py

ENV PATH="/app/.venv/bin:$PATH"
# Where uploads and cloned repositories live; volumes mount over these, and a
# volume's first mount takes the directory's owner — the gateway's user, which
# could not write to a root-owned one.
RUN mkdir -p /media /code/clones && chown -R commonindex /media /code
USER commonindex

EXPOSE 8000
CMD ["uvicorn", "commonindex.gateway.app:app", "--host", "0.0.0.0", "--port", "8000"]

# The same image with git and the repo's scripts: one-time setup
# (scripts/docker_setup.py) and indexing a mounted checkout (index_repos.py)
# in docker-compose.full.yml. The gateway image above stays as it was.
FROM runtime AS tools
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/ scripts/
# The starter layouts and design systems scripts/seed_dev.py loads. Without
# them the seed finds nothing and the Designs tab has no templates.
COPY designs/ designs/
USER commonindex
# A checkout mounted from the host is owned by another uid; git refuses it
# without this.
RUN git config --global --add safe.directory '*'

# ── video rendering (optional) ──────────────────────────────────────────
# The gateway with what renders a video: our renderer (render/render.mjs) and
# its one dependency, playwright-core (Apache-2.0); Node to run it, with Node's
# licence beside it; and Chromium and ffmpeg from the OS package manager. This project
# never publishes this image. ffmpeg is LGPL or GPL depending on its build, so
# anyone who distributes an image built from this target takes on that build's
# licence obligations, which installing the package does not by itself meet:
# read "Licensing of the video tools" in docs/videos.md first.
#   docker compose -f docker-compose.prod.yml build --build-arg ... gateway
#   with GATEWAY_TARGET=video in .env
# Pinned, so the licence copied below is the one for this Node.
FROM node:22.23.3-slim AS render-deps
WORKDIR /app/render
COPY render/package.json render/package-lock.json render/render.mjs ./
RUN npm ci --no-audit --no-fund --loglevel=error

FROM tools AS video
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
COPY --from=render-deps /usr/local/bin/node /usr/local/bin/node
# Node's licence, with the notices of what it bundles: it is not in the node image.
COPY licenses/node-v22.23.3-LICENSE.txt /usr/local/share/doc/node/LICENSE
COPY --from=render-deps /app/render /app/render
# Video renders and snapshots of pages use this browser (videos.chrome_path).
ENV COMMONINDEX_CHROME=/usr/bin/chromium
# Chrome's sandbox needs privileges a container does not grant its user; the
# container isolates it instead, and snapshots run with no network.
ENV COMMONINDEX_CHROME_NO_SANDBOX=1
USER commonindex
