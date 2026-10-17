# Third-party notices

Everything in this repository is original to this project except what is
listed here. Dependencies are not vendored. They are installed from their
registries, and `make licenses` checks every one of them against a list of
permissive licenses (see `scripts/check_licenses.py`).

## Included in this repository

| File | What it is | Source | License |
|---|---|---|---|
| `tests/fixtures_osi_schema.json` | The Apache Ossie (incubating) core metadata JSON Schema, specification version `0.2.0.dev0` (its `$id`: `https://github.com/apache/ossie/core-spec/osi-schema.json`), unmodified, used only by `tests/test_semantic_context.py` to validate the semantic export | <https://github.com/apache/ossie> | Apache License 2.0, copy in [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt). Its NOTICE, "Copyright 2026 The Apache Software Foundation", is in [`licenses/apache-ossie-NOTICE.txt`](licenses/apache-ossie-NOTICE.txt). |
| `web/src/data/seed.ts` (the `mulberry32` function) | mulberry32, a small seeded random number generator by Tommy Ettinger, for stable demo data | Published by its author into the public domain | Public domain |
| `web/public/brand/google/signin-light*.png` | Google's "Sign in with Google" button (light theme, with text), unmodified, at 1x, 2x and 3x | Google's sign-in branding assets (<https://developers.google.com/identity/branding-guidelines>, the downloadable asset bundle) | Google's assets and trademarks, used for that button as Google's [Sign in with Google branding guidelines](https://developers.google.com/identity/branding-guidelines) permit. Not covered by this project's licenses. |

## Used, not included

| What | Where | License |
|---|---|---|
| Geist and Geist Mono fonts, loaded from Google Fonts at runtime, not bundled | `web/index.html` | SIL Open Font License 1.1 |
| The incomplete beta function's continued fraction | `commonindex/core/inference/stats.py` | Mathematics from the NIST Digital Library of Mathematical Functions (DLMF 8.17.22), implemented here |
| Mozilla's CA certificate bundle, as `cacert.pem` inside botocore (an Apache-2.0 package installed with the `s3` extra) | Installed from PyPI, unmodified | MPL-2.0, for that file only. Its notice is in botocore's own licence files |
| certifi, Mozilla's CA certificate bundle as a package, needed only by the optional `bigquery` and `snowflake` extras | Installed from PyPI, unmodified | MPL-2.0. MPL obligations attach to its own files: whoever distributes it, unmodified, says where its source is (PyPI) |

`make licenses` names both as reviewed exceptions rather than counting them as
permissive.

## Used by the video renderer (`render/`)

| What | License | How it is used |
|---|---|---|
| playwright-core (the video renderer's one dependency) | Apache-2.0 (checked by `make licenses`) | Installed from npm, never vendored |
| Node.js (in the optional `video` image only, to run the renderer) | MIT, with the notices of what it bundles | Its licence, [`licenses/node-v22.23.3-LICENSE.txt`](licenses/node-v22.23.3-LICENSE.txt), is copied into the image beside the binary |
| ffmpeg | LGPL-2.1+ or GPL-2.0+, by build | **Not included.** The deployment installs it, and the renderer runs it as a separate program (`docs/videos.md`) |

## Distributing builds

A built web app or container image contains dependencies' code, and most
permissive licenses (MIT, BSD and Apache-2.0) ask that their notices travel
with it.

- **The web app:** every build writes `THIRD_PARTY_NOTICES.txt` beside
  `index.html`, with the licence text of each package it bundles
  (`web/notices.ts`). The web image serves it at `/THIRD_PARTY_NOTICES.txt`.
- **Python packages:** each installed package keeps its licence files in its
  `*.dist-info` folder, which the images carry.
- **Base images and operating-system packages:** an image you distribute also
  carries its base image's and distribution's packages, some under the GPL;
  their licences and source come from that distribution.
- **ffmpeg** is not included in this repository or in the default images. See
  [docs/videos.md](docs/videos.md) before distributing an image that contains it.
