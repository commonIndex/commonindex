# Chat link previews

Paste a workspace item URL in a channel, reply, or comment to show a compact
card with its title, type, summary, and available status/details. Posted cards
use a wider 760px layout with larger type and up to four lines of summary;
narrow threads and draft previews adapt to the space available. The composer
previews the link before sending; it still sends the original message text.
Existing messages get cards too. Opening a card uses a new tab so a chat draft
is not lost.

Document cards show the opening body blocks behind a readable gradient: headings,
paragraphs, lists, quotes, and tables, not just the document title. The body sketch
is capped at 12 blocks and 4,800 text characters. Embedded-page documents use an
existing saved PNG when it is ready. The reader must have access to both the doc
and the embedded artifact; the image endpoint checks that permission again.
No embedded HTML or scripts execute in chat, and no new screenshot render is
started. Missing or inaccessible embedded previews show a neutral fallback.
Image URLs stay in memory only and are revoked when the preview changes or closes.

Supported references: docs (including editor URLs), dashboards, experiments,
designs, videos, artifacts, tasks (`/board?task=…`), channels, agents, code files
(`/code?file=…`), and the generated warehouse-context skill. Frontend-only sample
items have no server metadata and show an unavailable card.

Only absolute URLs on the current app origin and recognized root-relative
paths are treated as workspace references. Other HTTP(S) links remain clickable
without a preview request. Bare links and `[label](url)` are supported; message
HTML is never executed. Duplicate references collapse to one card and at most
three cards appear per message (all links remain in the message).

`items.previews` is a read-only API/MCP operation accepting up to 24 `{id, type}`
references. It scopes object reads to the authorized workspace and the current
reader's ACL keys. Unknown, inaccessible, deleted, and wrong-type references
return the same unavailable shape. Agent metadata requires an active grant in
the current workspace. No preview is written into the shared message.

Cards load near the viewport, batch/deduplicate requests within a conversation,
and recheck access when the conversation refreshes or the window regains focus.
No preview data is persisted in browser storage. A failed lookup shows a retry
without preventing messages from being sent. Previews do not fetch external
URLs, execute warehouse queries, render HTML/video, or infer certification from
stored dashboard props. Dashboard cards show a real panel count, not live values.

Tests: `web/src/components/__tests__/MessageLinks.test.tsx` and
`tests/test_link_previews.py`. The Postgres permission test uses connection-local
temporary tables and does not reset or seed the local platform database.
