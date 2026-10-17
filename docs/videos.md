# Videos

A video is a **composition written as code**, rendered to a file. An agent,
over MCP or using the gateway's model, writes the composition from the
video's brief. The gateway renders it to an MP4 or WebM, and the video's page
plays it.

## How it works

1. **Create a video** under **Videos**, with a title, a brief and a format
   (16:9, 9:16 or 1:1).
2. **Write the composition.** Ask an agent connected over MCP: *"Write the
   composition for video VID-1 from its brief, save it with `videos.save`,
   then `videos.render`."* You can also paste or edit the HTML on the video's
   page.
3. **Render.** `videos.render` runs in the background, and `videos.get` reports
   when the render is ready or has failed, and why. The page refreshes itself
   while it renders.

The composition is one HTML document:

- a root `data-composition-id` element, with `data-width`, `data-height` and
  `data-duration`;
- timed scenes marked `class="clip"`, with `data-start` and `data-duration`;
- animation with CSS `@keyframes` or the Web Animations API.

## Editing in the browser

The editor keeps a compact scene list separate from the selected scene's
properties. Pick a scene in either the list or timeline to pause its live
preview a moment into the scene. The preview fits the available canvas area;
playback controls and the timeline stay below it.

The preview header names the selected scene and offers **Show selected
scene**. Focusing a scene field, editing it, or undoing a scene edit pauses
and seeks back to that scene, even if playback has moved on. Styled headings
expose both their plain text and inline spans as editable parts, retaining
the original styling and structure.

Title, brief, text, timing, and code changes share one **Save** action
(`Cmd/Ctrl+S`). **Undo** and **Redo** cover those edits during the current
editor session; they are not a persisted revision history. Rendering saves
pending changes first and temporarily locks editing until the job finishes.
The rendered file is separate from the live draft: save and render again to
update it.

### Describe a change

**Edit with AI** stays at the top of the inspector. Describe a change or ask
a question; the current unsaved composition, title, brief, and optionally the
selected scene's context are sent to the workspace's configured model.
`Cmd/Ctrl+Enter` submits; Enter makes a new line. The context selector focuses
the request, not an enforced scene-only boundary: review all affected scenes.

**LLM preview** calls `videos.assist`. The gateway checks item edit access,
applies exact, unambiguous find/replace suggestions, and checks composition
safety plus numeric timing. Nothing is saved or rendered. **Before / After**
compares the original draft with the suggestion. **Accept changes** adds one
undoable local edit; **Discard suggestion** keeps the draft intact. Save and
render remain explicit actions. Editing is locked during generation/review to
avoid overwriting edits made while a request is in flight. A rejected or
truncated answer leaves the draft and prompt untouched.

It reuses the Docs model (`COMMONINDEX_LLM_BASE_URL`, `COMMONINDEX_LLM_MODEL`, and
`COMMONINDEX_LLM_API_KEY` where required). Without that, it uses the Designs model
adapter (`COMMONINDEX_MODEL_PROVIDER=anthropic`, `COMMONINDEX_MODEL_API_KEY`, optional
`COMMONINDEX_MODEL_ID` / `COMMONINDEX_MODEL_BASE_URL`; install the `model` extra).
No credentials are sent to the browser. Generated HTML is untrusted and is
previewed inside the existing network-disabled sandbox; structural validation
is not a claim that the visual layout has been verified.

**Ask an agent** uses `agents.ask` to add a request to the selected agent's
inbox, linked to this video. It does not start a runtime or promise an immediate
answer. Save/discard local edits first: the external agent reads the saved
video and needs access to it. Agent responses are not streamed into this box;
the immediate Before/After workflow is for LLM suggestions.

Scene controls are intended for sequential, numerically timed scenes with
class-based CSS animations. Timing edits lay these scenes end to end. Use
the Code editor for overlapping tracks, relative timing references, or
custom script animation: scene controls do not rewrite script selectors or
retime script logic. Duplicated element IDs are made unique and local
label/SVG references are updated; ID-specific CSS or script targets may
need adjusting in Code. Head styles and scripts are retained by edits.

The live preview is a network-disabled, sandboxed CSS/animation preview, and
the renderer (`render/render.mjs`) steps the composition the same way, frame by
frame, so the file matches what the preview showed.
Preview initialization errors and file-loading errors appear in the editor
with retry controls instead of silently leaving a blank canvas.

## What a composition may contain

The renderer runs a composition in a headless browser on the gateway's
machine, so a composition counts as untrusted code. `videos.save` and
`videos.render` refuse any composition containing:

- a URL with a scheme, or a protocol-relative URL;
- an external script, an iframe, an object, a `<link>` or a form;
- CSS `@import`;
- `fetch`, XHR, WebSocket, EventSource, workers or `import()`;
- navigation from script;
- audio or video (`<audio>`, `<video>`, `<source>`, `<track>`, or a `data:audio/`
  or `data:video/` URI). The renderer passes any media in a composition to
  ffmpeg to decode, and a crafted media file is a known way to attack a
  decoder, so compositions carry none.

Inline SVG and `data:` images are allowed.

These checks are a deny-list, not a sandbox. Renders also:

- run with an empty environment: no keys, no database settings, no tokens;
- run one at a time;
- stop after 10 minutes.

If you render compositions you don't trust, run the renderer in a container
of its own, without network access and without the worker's keys or database
settings: Chromium runs there with its sandbox off, and the container is the
boundary.

**No GSAP.** The popular animation library is free, but not open source,
and its license forbids using it in tools that let people build animations
without code. Compositions use the browser's own CSS and Web Animations
instead, `videos.save` refuses GSAP, and the renderer carries no animation
library: it opens the composition in Chromium, offline, pauses its animations,
steps them frame by frame as the preview does, and hands the frames to ffmpeg.

## Setting it up

| Needs | What | Notes |
|---|---|---|
| The renderer | `cd render && npm ci`, and Node | `render/render.mjs` with one dependency, playwright-core (Apache-2.0), pinned in `render/package.json`. `make licenses` checks it. |
| Chromium or Chrome | Installed by you, or set `COMMONINDEX_CHROME` | It draws each frame. Found on PATH (`chromium`, `google-chrome`…) or as the macOS app. |
| **ffmpeg** | **Installed by you**: `brew install ffmpeg`, `apt install ffmpeg`… | It encodes the video. |

`videos.tools`, and a notice on the video's page, say what is missing.

**Licensing of the video tools.** This is a summary, not legal advice. Your
obligations depend on how you use them, so check with your own counsel before
distributing anything.

- **ffmpeg is not part of this project.** It is licensed under the LGPL or the
  GPL depending on how a given build was configured, and the renderer runs it
  as a separate program (files in and out); it is never linked into this code.
  This repository does not include or distribute ffmpeg.
- **Running it yourself** (installing your operating system's ffmpeg package on
  your own servers) is the case the docs describe. Your package manager
  supplies the package's licence and source.
- **Distributing an image or bundle that contains ffmpeg** (for example a
  `video` image you publish or give to customers) makes you the distributor:
  you must meet the licence of that specific build, which for a GPL build
  includes offering its corresponding source. See
  [FFmpeg's licence and legal guidance](https://ffmpeg.org/legal.html). Don't
  use an `--enable-nonfree` build, which may not be redistributed at all.
- **Codecs and patents.** WebM (VP9 and Opus) is designed to be royalty-free.
  MP4 (H.264 and AAC) is covered by patent licensing programmes, and whether
  those affect you depends on what you distribute and where. Prefer WebM if
  that is a concern, and get advice before shipping H.264 encoders or decoders.
- **Node.js**, which runs the renderer, is MIT-licensed and bundles other
  components; the `video` image copies its licence, with their notices, to
  `/usr/local/share/doc/node/LICENSE`. Include it if you distribute the image.

Rendered files are kept in the media store: the `COMMONINDEX_MEDIA_DIR` folder
(default `.media/`), or an S3-compatible bucket with `COMMONINDEX_MEDIA_STORE=s3`
(docs/deploy.md, Media storage). They are served by `videos.file` only to
people who can see the video.
