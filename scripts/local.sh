#!/usr/bin/env bash
# Everything on this machine, in one terminal: `make local`.
#
#   1. Ollama, with the context and cache settings docs/local-model.md gives,
#      and the models .env.local names — pulled the first time.
#   2. The gateway (make dev-gateway) and the web app (vite).
#   3. Every agent with a token kept in ~/.config/commonindex/agents
#      (make agent-run AGENT=<id> keeps one).
#
# Anything already running is used, not restarted, and left running on exit;
# Ctrl-C stops only what this script started. Logs: .local-logs/ (gitignored).
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
LOGS="$ROOT/.local-logs"
mkdir -p "$LOGS"
PIDS=()

say()  { printf '\033[1m%s\033[0m %s\n' "▸" "$*"; }
warn() { printf '\033[33m%s\033[0m %s\n' "!" "$*"; }
up()   { curl -s -m 2 -o /dev/null "$1"; }
wait_for() {  # url, seconds, what
  local n=0; until up "$1"; do sleep 1; n=$((n+1)); [ "$n" -ge "$2" ] && { warn "$3 did not come up — see $LOGS"; return 1; }; done
}
stop() {
  echo; say "stopping what this started"
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  wait 2>/dev/null; exit 0
}
trap stop INT TERM

# ── settings ─────────────────────────────────────────────────────────────
if [ ! -f .env.local ]; then
  say "no .env.local — writing one for the local Qwen (docs/local-model.md)"
  cat > .env.local <<'EOF'
COMMONINDEX_LLM_BASE_URL=http://localhost:11434/v1
COMMONINDEX_LLM_MODEL=qwen3.5:9b
COMMONINDEX_LLM_REASONING_EFFORT=none
COMMONINDEX_LLM_TIMEOUT_SECONDS=420
COMMONINDEX_EMBED_BASE_URL=http://localhost:11434/v1
COMMONINDEX_EMBED_MODEL=nomic-embed-text
COMMONINDEX_EMBED_DOC_PREFIX=search_document:
COMMONINDEX_EMBED_QUERY_PREFIX=search_query:
COMMONINDEX_MODEL_PROVIDER=local
COMMONINDEX_MODEL_ID=qwen3.5:9b
COMMONINDEX_MODEL_BASE_URL=http://localhost:11434/v1
COMMONINDEX_MODEL_REASONING_EFFORT=none
COMMONINDEX_MODEL_TIMEOUT_SECONDS=600
EOF
fi
setting() { sed -n "s/^$1=//p" .env.local | head -1; }
LLM_URL=$(setting COMMONINDEX_LLM_BASE_URL)
LLM_MODEL=$(setting COMMONINDEX_LLM_MODEL)
EMBED_MODEL=$(setting COMMONINDEX_EMBED_MODEL)

# ── the model ────────────────────────────────────────────────────────────
if [[ "$LLM_URL" == *"localhost:11434"* ]]; then
  if ! command -v ollama >/dev/null; then
    warn "Ollama is not installed: brew install ollama — then make local again"; exit 1
  fi
  if ! up http://localhost:11434/api/version; then
    say "starting Ollama (32K context, flash attention, q8 cache)"
    if [ "$(uname)" = Darwin ] && command -v brew >/dev/null; then
      # launchctl so the service brew starts sees them; they last until a restart.
      launchctl setenv OLLAMA_CONTEXT_LENGTH 32768
      launchctl setenv OLLAMA_FLASH_ATTENTION 1
      launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0
      brew services start ollama >/dev/null
    else
      OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 \
        ollama serve > "$LOGS/ollama.log" 2>&1 & PIDS+=($!)
    fi
    wait_for http://localhost:11434/api/version 30 "Ollama" || exit 1
  else
    say "Ollama is already running"
    if [ "$(uname)" = Darwin ] && [ -z "$(launchctl getenv OLLAMA_CONTEXT_LENGTH)" ]; then
      warn "it was started without the 32K context — long docs get cut. Restart it: brew services stop ollama, then make local"
    fi
  fi
  for m in "$LLM_MODEL" "$EMBED_MODEL"; do
    [ -z "$m" ] && continue
    if ! ollama list | awk 'NR>1{print $1}' | grep -qx "$m\(:latest\)\{0,1\}"; then
      say "pulling $m (first time only)"; ollama pull "$m" || { warn "could not pull $m"; exit 1; }
    fi
  done
  say "model: $LLM_MODEL"
else
  say "model: $LLM_MODEL at $LLM_URL (not a local Ollama — left as it is)"
fi

# ── the platform ─────────────────────────────────────────────────────────
pg_isready -q 2>/dev/null || { warn "Postgres is not accepting connections — start it, then make local again"; exit 1; }

if up http://localhost:8000/; then say "gateway already running on :8000"
else
  say "starting the gateway → $LOGS/gateway.log"
  make -s dev-gateway > "$LOGS/gateway.log" 2>&1 & PIDS+=($!)
fi
if up http://localhost:5173/; then say "web app already running on :5173"
else
  say "starting the web app → $LOGS/web.log"
  (cd web && npx vite --host localhost --port 5173 --strictPort) > "$LOGS/web.log" 2>&1 & PIDS+=($!)
fi
wait_for http://localhost:8000/ 90 "the gateway" || { stop; }
wait_for http://localhost:5173/ 60 "the web app" || { stop; }

# ── the agents ───────────────────────────────────────────────────────────
TOKENS="${COMMONINDEX_AGENT_TOKENS:-$HOME/.config/commonindex/agents}"
if ls "$TOKENS"/*.token >/dev/null 2>&1; then
  if pgrep -f "commonindex.reference_agent" >/dev/null; then
    say "agents already running"
  else
    say "starting agents: $(ls "$TOKENS"/*.token | xargs -n1 basename | sed 's/\.token$//' | paste -sd' ' -) → $LOGS/agents.log"
    make -s agents > "$LOGS/agents.log" 2>&1 & PIDS+=($!)
  fi
else
  say "no agents kept for this machine yet — make agent-run AGENT=<id> runs one and keeps its token"
fi

echo
say "ready: http://localhost:5173"
if [ ${#PIDS[@]} -eq 0 ]; then
  say "everything was already running; nothing for this to stop"; exit 0
fi
say "Ctrl-C stops what this started. Following the agents' log:"
touch "$LOGS/agents.log"
tail -n 0 -f "$LOGS/agents.log" &
TAIL=$!
PIDS+=("$TAIL")
wait
