# Artifacts

An **artifact** is a piece of HTML that runs: a chart, a calculator, a styled
table, a small interactive demo. It is its own item (`types/artifact.json`), and a
doc embeds it by id.

## Why it is not HTML inside the doc

A doc's body is a block tree with no field markup fits in (`types/doc.json`), and
it stays that way. The embed block holds one thing, the artifact's id:

```json
{ "type": "embed", "attrs": { "ref": "artifact-9fc1be9f1de3" } }
```

In markdown, which is what the editor's AI reads and writes, the same block is one
line: `:::embed {ref="artifact-9fc1be9f1de3"} :::`.

The HTML lives on the artifact, so:

- **Sharing a doc does not share what it embeds.** A reader who can't open the
  artifact sees that something is embedded, not what it is. Share the artifact
  from its own page (`/artifacts/<id>`).
- **One artifact can sit in several docs.** It is changed in one place, and every
  doc shows the change.
- **Every save is a revision** with the whole artifact in it.

## Where it runs

- **In the app** it runs in an `<iframe sandbox="allow-scripts">`, without
  same-origin, so it has no cookies, no storage and no way into the app. A policy
  of `default-src 'none'` means no request leaves the frame. Scripts run inside it,
  which is the point.
- **On save**, the HTML is checked against the same list as video compositions
  (`videos.forbidden`): no URLs, no external scripts, no iframes, forms or links,
  no `fetch`, `XMLHttpRequest` or `WebSocket`, no navigation. A refused save says
  why.
- **On a shared doc page and in an HTML export** no script runs. Those pages show
  a snapshot instead: a PNG the gateway takes after each save, with an
  **Open live** link. The snapshot only appears for someone who may see the
  artifact:
  - in an export, the person downloading;
  - on a public link, the person who made the link, as of now.

## Snapshots

The gateway takes snapshots with headless Chrome. It uses the browser video renders
use: `COMMONINDEX_CHROME`, else Chromium or Chrome on PATH, else the macOS app. The page is drawn under the same
no-network policy, and Chrome is also pointed at a proxy that does not exist, so a
policy bug can't turn into a request. Without a browser, artifacts still work in
the app, and script-free pages say "No snapshot yet".

Snapshots are stored under `COMMONINDEX_MEDIA_DIR` (`.media/artifacts/`).

## Ops

| Op | What it does |
| --- | --- |
| `artifacts.propose` | Create one (`title`, `html`, optional `height`). The HTML is checked first. |
| `artifacts.save` | Change `html`, `title`, `description` or `height` (120–1600 px). Pass `if_rev` to refuse a stale save. Needs edit access. |
| `artifacts.draft` | Ask the workspace's model to write or change the HTML. Returns HTML that passed the check. Saves nothing. |
| `artifacts.get` / `artifacts.list` | Read. Private to its creator until shared. |
| `artifacts.snapshot` | The PNG. |
| `artifacts.delete` | Owners only. Docs that embed it then show it as gone. |

The same ops are available over HTTP, MCP and the CLI, so an agent can write an
artifact and embed it in a doc with `docs.revise`.
