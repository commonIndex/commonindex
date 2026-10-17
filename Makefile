# Nothing here may name a path that only exists on one developer's laptop. The
# previous defaults were Homebrew's, so every target failed on Linux and on any
# Mac that installed uv anywhere else — including the EC2 host this is meant to
# run on. Discovered from PATH, still overridable: `make test UV=/opt/uv/bin/uv`.
UV ?= $(shell command -v uv 2>/dev/null || echo uv)
PY ?= 3.13

# This machine's own settings — a local model, keys — as KEY=value lines in
# .env.local (gitignored). Every variable it names reaches the gateway, so
# `make dev-gateway` and `make mcp` pick up a local model without anyone
# exporting it by hand. docs/local-model.md has the lines for Ollama.
-include .env.local
export $(shell sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env.local 2>/dev/null)

# Postgres client binaries, by bare name so PATH resolves them. Override PG_BIN
# with a trailing slash to pin an install: `make db-up PG_BIN=/usr/pgsql-17/bin/`
PG_BIN     ?=
PSQL       ?= $(PG_BIN)psql
CREATEDB   ?= $(PG_BIN)createdb
DROPDB     ?= $(PG_BIN)dropdb
PG_ISREADY ?= $(PG_BIN)pg_isready

TEST := $(UV) run --python $(PY) --with pytest --with pytest-asyncio --with asyncpg \
          --with sqlalchemy --with greenlet --with duckdb-engine --with aiosqlite

.PHONY: check test test-unit test-integration lint licenses fmt db-up db-down db-reset migrate-print dev-db dev-gateway agent-run agents local index-backfill secret-key skill skill-zip zoekt-up code-index github-index k8s-build k8s-up k8s-migrate k8s-run-now k8s-logs k8s-down

# The isolation rule, the P1 boundary and the parity contract are all tests, so
# `make check` is the whole guard rather than a grep that passes when the
# directory it greps has been renamed.
check: lint licenses test

# Integration tests skip themselves when no database is reachable, so this is
# safe to run anywhere.
test:
	$(TEST) pytest -q

test-unit:
	$(TEST) pytest -q -m "not integration"

test-integration:
	$(TEST) pytest -q -m integration

lint:
	$(UV) run --python $(PY) --with ruff ruff check commonindex commonindex_enterprise tests scripts

# Only permissive licenses in anything installed or run: every Python package,
# every npm package and every service image. An allow-list — a license nobody
# has reviewed fails until somebody has. See scripts/check_licenses.py.
# With every extra — the image ships s3, and a customer may install any
# connector — and the check fails if the install does not match uv.lock.
licenses:
	$(UV) run --python $(PY) --all-extras python scripts/check_licenses.py

fmt:
	$(UV) run --python $(PY) --with ruff ruff format commonindex commonindex_enterprise tests

# ── a database to test against ─────────────────────────────────────────
# Either a local Postgres or the pinned compose service, which uses port 5433
# so it never collides with a local install.
#
# Published ports bind to BIND_ADDR, which defaults to loopback. On a laptop
# that changes nothing; on an EC2 host with a permissive security group it is
# the difference between a private database and one reachable from the
# internet. Set BIND_ADDR=0.0.0.0 deliberately, never by default.
BIND_ADDR   ?= 127.0.0.1
COMPOSE_DSN ?= postgresql://commonindex:commonindex@$(BIND_ADDR):5433/commonindex_test

# Uses a local Postgres when one is already running, and the compose service
# otherwise. `brew services start` used to be the fallback, which made this
# target macOS-only; falling back to Docker works on a laptop and on a bare
# EC2 host, and needs pgvector present either way.
db-up:
	@if command -v $(PG_ISREADY) >/dev/null 2>&1 && $(PG_ISREADY) -q 2>/dev/null; then \
	  $(CREATEDB) commonindex_test 2>/dev/null || true; \
	  $(PSQL) -q -d commonindex_test -c "create extension if not exists vector;"; \
	  echo "commonindex_test ready on the local Postgres — migrations come from the test fixture"; \
	else \
	  echo "no local Postgres; using the compose service"; \
	  $(MAKE) --no-print-directory db-docker; \
	fi

db-docker:
	docker compose up -d db
	@echo 'run: COMMONINDEX_TEST_DSN=$(COMPOSE_DSN) make test-integration'

db-down:
	@docker compose down 2>/dev/null || true

db-reset:
	@$(DROPDB) --if-exists commonindex_test && $(CREATEDB) commonindex_test
	@$(PSQL) -q -d commonindex_test -c "create extension if not exists vector;"

migrate-print:
	@cat migrations/*.sql

# ── code search ─────────────────────────────────────────────────────────
# Postgres and Zoekt are indexed by ONE target on purpose. They answer the same
# question from two stores, and a shard describing a revision Postgres no longer
# holds is exactly the drift that produces a citation pointing at a line that
# has moved. Indexing them separately makes that the default state.
#
# REPOS defaults to this repository. Pass clones to index several — automatic
# repo routing is what a multi-repo corpus exercises, and repos that all say the
# same thing cannot show that routing chose correctly.
REPOS ?= .
# docker-compose.yml pins `name: commonindex`, so the volume is this on
# every machine. Without that pin Compose names the project after whatever the
# checkout directory happens to be called, and the volume moves with it.
ZOEKT_VOLUME ?= commonindex_zoekt-index
ZOEKT_IMAGE  ?= sourcegraph/zoekt-indexserver:latest
ZOEKT_URL    ?= http://$(BIND_ADDR):6070

zoekt-up:
	docker compose up -d zoekt
	@echo "zoekt on $(ZOEKT_URL) — export COMMONINDEX_ZOEKT_URL=$(ZOEKT_URL)"

# Index a GitHub repository nobody has cloned. The connector reads it through
# the API into Postgres; zoekt-archive-index reads the same tarball into a
# shard. Unlike zoekt-git-index this takes -name, so the shard carries our own
# `org/repo` and needs no reconciliation to map results back.
#
#   make github-index GH_REPO=pallets/click
GH_REPO   ?=
GH_BRANCH ?= main

github-index: zoekt-up
	@test -n "$(GH_REPO)" || { echo "pass GH_REPO=org/repo"; exit 1; }
	COMMONINDEX_DSN=$${COMMONINDEX_DSN:-$(DEV_DSN)} CODEQUERY_REPOS='[{"org":"$(firstword $(subst /, ,$(GH_REPO)))","repo":"$(lastword $(subst /, ,$(GH_REPO)))","branch":"$(GH_BRANCH)"}]' \
	  $(UV) run --python $(PY) --with asyncpg python -m commonindex.workers.codequery
	@sha=$$(curl -fsSL "https://api.github.com/repos/$(GH_REPO)/commits/$(GH_BRANCH)" \
	          $${CODEQUERY_GITHUB_TOKEN:+-H "authorization: Bearer $$CODEQUERY_GITHUB_TOKEN"} \
	        | $(UV) run --python $(PY) python -c "import json,sys;print(json.load(sys.stdin)['sha'])"); \
	  docker run --rm --platform linux/amd64 -v $(ZOEKT_VOLUME):/data \
	    --entrypoint zoekt-archive-index $(ZOEKT_IMAGE) \
	    -index /data -name "$(GH_REPO)" -branch "$(GH_BRANCH)" -commit "$$sha" \
	    "https://github.com/$(GH_REPO)/archive/$$sha" >/dev/null
	@docker compose restart zoekt >/dev/null
	@echo "indexed $(GH_REPO)@$(GH_BRANCH) into Postgres and Zoekt"

# --platform is native on an amd64 host (an ordinary EC2 instance) and emulated
# on Apple silicon, which is the only architecture Zoekt publishes images for.
# Indexing is a background pass, not the query path.
code-index: zoekt-up
	@for repo in $(REPOS); do \
	  echo "→ $$repo"; \
	  COMMONINDEX_DSN=$${COMMONINDEX_DSN:-$(DEV_DSN)} \
	    $(UV) run --python $(PY) --with asyncpg python scripts/index_repos.py "$$repo" || exit 1; \
	  docker run --rm --platform linux/amd64 \
	    -v "$$(cd $$repo && pwd)":/repo:ro -v $(ZOEKT_VOLUME):/data \
	    --entrypoint zoekt-git-index $(ZOEKT_IMAGE) \
	    -index /data -branches "$$(git -C $$repo rev-parse --abbrev-ref HEAD)" /repo \
	    >/dev/null || exit 1; \
	done
	@docker compose restart zoekt >/dev/null
	@echo "indexed into Postgres and Zoekt: $(REPOS)"

# ── the development stack ────────────────────────────────────────────────
# A DIFFERENT database from the one the tests use. tests/db.py opens every
# integration run with `drop schema public cascade`, which is correct and which
# also destroys whatever a running gateway was serving. Keeping them apart is
# the fix; remembering not to run the tests is not.
DEV_DSN ?= postgresql://localhost/commonindex_dev

dev-db:
	$(CREATEDB) commonindex_dev 2>/dev/null || true
	COMMONINDEX_DEV_DSN=$(DEV_DSN) $(UV) run python scripts/seed_dev.py

# COMMONINDEX_SECRET_KEY encrypts warehouse credentials at rest. Generated per run here
# so a dev machine never has a default key baked into the source — which is how
# a convenience becomes a CVE. Set it yourself to keep connections across
# restarts:  export COMMONINDEX_SECRET_KEY=$$(make secret-key)
secret-key:
	@$(UV) run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# Write the generated data-context skill where Claude Code reads skills from.
# The bundle is a snapshot: re-run it after ratifying a definition or building a
# dashboard, because the registry moves and a copy on disk does not.
skill:
	$(UV) run python scripts/install_skill.py

skill-zip:
	$(UV) run python scripts/install_skill.py --zip warehouse-context.zip

# `--reload-include '*.json'` because the object types ARE json and are read
# once at import. Without it, adding a field to a type leaves the running dev
# gateway refusing every write that carries it — the feature looks broken and
# the code looks fine, which cost a reviewer an afternoon.
dev-gateway:
	COMMONINDEX_MAIL_LOG=$${COMMONINDEX_MAIL_LOG:-1} \
	COMMONINDEX_SECRET_KEY=$${COMMONINDEX_SECRET_KEY:-$$($(UV) run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")} \
	COMMONINDEX_DSN=$(DEV_DSN) COMMONINDEX_ZOEKT_URL=$${COMMONINDEX_ZOEKT_URL:-$(ZOEKT_URL)} \
	COMMONINDEX_CODE_ROOTS=$${COMMONINDEX_CODE_ROOTS:-$(abspath $(CURDIR)/..)} \
	$(UV) run uvicorn commonindex.gateway.app:app --host $(BIND_ADDR) --port 8000 --reload \
	  --reload-dir commonindex --reload-dir types --reload-include '*.py' --reload-include '*.json'

# Rebuild the search index for everything but code: sweep until every item's
# chunks match what it says now. Safe to re-run; the gateway keeps it current
# after that. `make index-backfill COMMONINDEX_DSN=…` for another database.
index-backfill:
	COMMONINDEX_DSN=$${COMMONINDEX_DSN:-$(DEV_DSN)} $(UV) run --python $(PY) python -m commonindex.workers.indexer

# The reference agent (commonindex/reference_agent.py): reads the agent's inbox, answers
# mentions in their threads, files handed tasks for review, and says how each
# went. Nothing in the platform runs agents, so until one of these (or any
# other agent) connects, every ask waits. Writes with the same model settings
# the gateway uses (COMMONINDEX_LLM_*, from .env.local — a local Qwen or a provider).
#   make agent-run AGENT=scribe    # mints a token the first time, keeps it in
#                                  # ~/.config/commonindex/agents, reuses it
#   make agents                    # every agent with a token kept there
#   make agent-run TOKEN=ci_...    # a token from somewhere else
# Recipes are silent (@) so a token never lands in a terminal or a log.
AGENT ?=
agent-run:
	@if [ -n "$(AGENT)" ]; then \
	  $(UV) run python -m commonindex.reference_agent --agent "$(AGENT)" --gateway http://localhost:8000; \
	elif [ -n "$(TOKEN)" ]; then \
	  COMMONINDEX_AGENT_TOKEN="$(TOKEN)" $(UV) run python -m commonindex.reference_agent --gateway http://localhost:8000; \
	else echo "which agent? make agent-run AGENT=<agent id>   (or TOKEN=ci_...)"; exit 2; fi

agents:
	@$(UV) run python -m commonindex.reference_agent --all --gateway http://localhost:8000

# Everything on this machine, in one terminal: Ollama with the settings
# docs/local-model.md gives (pulling the models if missing), the gateway, the
# web app, and every agent kept for this machine. Ctrl-C stops what it started.
local:
	@bash scripts/local.sh

# ── Code Query, local Kubernetes ─────────────────────────────────────────
# Needs a local cluster (`kind create cluster --name
# commonindex-local` or Docker Desktop's Kubernetes) and deploy/k8s/local/secret.yaml
# (copy secret.yaml.example, fill in real values — never commit it).
KIND_CLUSTER ?= commonindex-local

k8s-build:
	docker build -t commonindex:local .
	@if command -v kind >/dev/null && kind get clusters | grep -q '^$(KIND_CLUSTER)$$'; then \
		kind load docker-image commonindex:local --name $(KIND_CLUSTER); \
	fi

k8s-up: k8s-build
	kubectl apply -f deploy/k8s/local/00-namespace.yaml
	kubectl apply -f deploy/k8s/local/01-configmap.yaml
	kubectl apply -f deploy/k8s/local/secret.yaml
	kubectl apply -f deploy/k8s/local/02-postgres.yaml
	kubectl -n commonindex-local wait --for=condition=ready pod -l app=postgres --timeout=120s
	kubectl apply -f deploy/k8s/local/03-migrate-job.yaml
	kubectl -n commonindex-local wait --for=condition=complete job/migrate --timeout=60s
	kubectl apply -f deploy/k8s/local/04-codequery-cronjob.yaml
	kubectl apply -f deploy/k8s/local/05-gateway-deployment.yaml

# Force one Code Query pass now, rather than waiting for the hourly schedule.
k8s-run-now:
	kubectl -n commonindex-local create job --from=cronjob/codequery codequery-manual-$$(date +%s)

k8s-logs:
	kubectl -n commonindex-local logs -l app=gateway --tail=100 -f

k8s-down:
	kubectl delete namespace commonindex-local --ignore-not-found

# The MCP transport over stdio. An agent launches this as its own process, so it
# runs the gateway's lifespan itself rather than talking to `dev-gateway`.
mcp:
	COMMONINDEX_SECRET_KEY=$${COMMONINDEX_SECRET_KEY:-$$($(UV) run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")} \
	COMMONINDEX_DSN=$(DEV_DSN) COMMONINDEX_ZOEKT_URL=$${COMMONINDEX_ZOEKT_URL:-$(ZOEKT_URL)} COMMONINDEX_TOKEN=$${COMMONINDEX_TOKEN:?mint one with: $(UV) run python scripts/mint_token.py <actor>} \
	$(UV) run python -m commonindex.gateway.mcp_server

# What to paste into an MCP client's config to reach it.
mcp-config:
	@printf '%s\n' \
	  '{' \
	  '  "mcpServers": {' \
	  '    "commonindex": {' \
	  '      "command": "$(UV)",' \
	  '      "args": ["run", "--project", "$(CURDIR)", "python", "-m", "commonindex.gateway.mcp_server"],' \
	  '      "env": {' \
	  '        "COMMONINDEX_DSN": "$(DEV_DSN)",' \
	  '        "COMMONINDEX_ZOEKT_URL": "$(ZOEKT_URL)",' \
	  '        "COMMONINDEX_SECRET_KEY": "<the key that encrypted your connections>",' \
	  '        "COMMONINDEX_TOKEN": "<$(UV) run python scripts/mint_token.py <actor>>"' \
	  '      }' \
	  '    }' \
	  '  }' \
	  '}'
