# A local model with Ollama

The AI features — Ask AI in docs, artifact and video drafting, `workspace.ask`,
`code.ask` — call any OpenAI-compatible endpoint. Ollama runs one on your own
machine; nothing leaves it.

## Which model

On a 24 GB Apple Silicon Mac, **`qwen3.5:9b`** (Apache-2.0, 6.6 GB) is the fit:
it runs entirely on the GPU at about 17 tokens/s with room for a 32K context.
The 27B models (18 GB) only just fit and run at about 5 tokens/s. Embeddings
use **`nomic-embed-text`** (Apache-2.0), whose 768 dimensions are what
`chunks.embedding` holds.

## Set up

```sh
brew install ollama
launchctl setenv OLLAMA_CONTEXT_LENGTH 32768   # the default 4096 silently cuts long prompts
launchctl setenv OLLAMA_FLASH_ATTENTION 1
launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0
brew services start ollama
ollama pull qwen3.5:9b
ollama pull nomic-embed-text
```

`launchctl setenv` lasts until a restart; run those three lines again after one
(or set them in the service's plist).

Then put these lines in `.env.local` at the repo root (gitignored) — `make
dev-gateway` and `make mcp` read it:

```sh
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
```

(The two prefixes end in a space.) The `COMMONINDEX_LLM_*` lines serve docs,
artifacts, videos, [AI dashboard suggestions](ai-dashboards.md), `workspace.ask` and `code.ask`; the `COMMONINDEX_MODEL_*` lines
serve Designs, which asks for an object matching the design schema — sent as a
JSON-schema `response_format`, which Ollama honours.

## Why each line

- **`COMMONINDEX_LLM_REASONING_EFFORT=none`** — Qwen3.5 thinks before it answers.
  Over the OpenAI-compatible endpoint it spent a whole 400-token budget on
  hidden reasoning and returned an empty answer after 43 seconds; with `none`
  the same question took 2.4 seconds. (`think: false` is ignored on that
  endpoint.)
- **`COMMONINDEX_LLM_TIMEOUT_SECONDS=420`** — measured on an M4 Air: a doc rewrite
  takes about 3–10 seconds and an artifact block about a minute, but a whole
  HTML page is a few thousand tokens, which at ~17 tokens/s is 3–5 minutes.
- **`OLLAMA_CONTEXT_LENGTH`** — a doc, a search's excerpts or a page of code is
  well past 4,096 tokens, and Ollama drops what does not fit without saying so.

## Run everything: `make local`

```sh
make local
```

One terminal, everything on this machine: Ollama with the settings above
(pulling `qwen3.5:9b` and `nomic-embed-text` the first time), the gateway, the
web app at http://localhost:5173, and every agent kept for this machine. It
writes a `.env.local` with the lines above if there is none. Anything already
running is used, not restarted; Ctrl-C stops only what it started. Logs are in
`.local-logs/`.

## Agents

An agent is run by a process that holds its token — nothing in the platform
runs one. On this machine:

```sh
make agent-run AGENT=qwen-agent   # mints a token the first time, keeps it, runs it
make agents                       # every agent kept for this machine
```

Tokens are kept in `~/.config/commonindex/agents/<agent>.token` (folder
700, files 600), so nobody copies one and a restart does not lose it; a kept
token that has been revoked is replaced once, when the agent is run by name.
`make local` starts every kept agent. An agent's page in the app says whether
it is running — its token was used in the last minute — and, if not, the
command to start it. Its answers end with the model that wrote them.

An agent sees only what is shared with it: share a doc with the workspace
before asking it about one.
