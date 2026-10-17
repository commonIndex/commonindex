# Deploying CommonIndex

`docker-compose.prod.yml` runs the whole platform on one machine with Docker:
Postgres (with pgvector), the gateway, a worker for background jobs, the web
app behind nginx, and — when you want them — code search (Zoekt) and video
rendering.

`docker-compose.full.yml` is a different thing: a **local demo** with sample
data and a built-in sign-in token. Never expose it; it binds to 127.0.0.1 by
default for that reason.

## What you need

* Docker with Compose v2, 4 GB of memory (8 GB with video rendering).
* A domain name and TLS in front of the machine — a cloud load balancer,
  Caddy or Traefik. The stack listens on plain HTTP on one port.
* An SMTP server for invitations and sign-in emails (or single sign-on).
* Optionally, an OpenAI-compatible model endpoint for the AI features.

## First start

```sh
cp deploy/prod.env.example .env
# fill in: COMMONINDEX_PUBLIC_URL, COMMONINDEX_ADMIN_EMAIL, POSTGRES_PASSWORD,
#          COMMONINDEX_SECRET_KEY, and SMTP (or SSO)
docker compose -f docker-compose.prod.yml up -d --build
```

On first start the gateway creates the workspace and makes
`COMMONINDEX_ADMIN_EMAIL` its admin. Open `COMMONINDEX_PUBLIC_URL`, enter that email,
and use the code or link that arrives. With neither email nor SSO configured,
the gateway's log prints a one-time sign-in link instead:

```sh
docker compose -f docker-compose.prod.yml logs gateway | grep "sign in as"
```

From there the admin invites people (Members) and chooses how they sign in
(Sign-in settings): single sign-on, email codes, or links the admin sends.

## TLS

Point your proxy at `HTTP_PORT` (8080 by default) and set `COMMONINDEX_PUBLIC_URL`
to the https address. Pass `X-Forwarded-Proto` and `X-Forwarded-For`; the
gateway trusts them. A minimal Caddyfile:

```
commonindex.example.com {
    reverse_proxy localhost:8080
}
```

If the proxy runs on the same machine, set `BIND_ADDR=127.0.0.1` so the plain
HTTP port is not reachable from outside.

Turn on HSTS at the proxy once https works, so browsers never fall back to
plain HTTP (Caddy: `header Strict-Transport-Security "max-age=31536000"`).
The web server already sends the other security headers: `nosniff`, a
referrer policy, no framing by other sites, and a permissions policy
(`web/security-headers.conf`).

## Optional parts

**Code search.** Start with `--profile code` and set
`COMMONINDEX_ZOEKT_URL=http://zoekt:6070`. Admins add repositories from the Code
query page (any https git URL; a token for a private one is kept encrypted
with `COMMONINDEX_SECRET_KEY` so it can be re-indexed). The worker indexes them
into Postgres at once and again every `COMMONINDEX_CODE_REFRESH_SECONDS` (3600);
the Zoekt sidecar rebuilds their search index every `ZOEKT_EVERY_SECONDS`
(1800, 30 minutes). Set either in `.env` to change it. Until a new repository's
index is built, search skips it and lists it under `unindexed_repos`.

**Video rendering.** Set `GATEWAY_TARGET=video` and rebuild the gateway. This
installs Chromium and ffmpeg from Debian into your image — see
[videos.md](videos.md) for why ffmpeg is installed by you rather than shipped.
The image is about 2 GB.

**AI.** Any OpenAI-compatible endpoint: `COMMONINDEX_LLM_*` for answers and
summaries, `COMMONINDEX_EMBED_*` for meaning-based search, `COMMONINDEX_MODEL_*` for
generation. See [local-model.md](local-model.md) for a model on your own
hardware. Nothing is sent anywhere unless these are set.

## Running it

* **Upgrades:** `git pull`, then
  `docker compose -f docker-compose.prod.yml up -d --build`. The `migrate`
  service applies any new database migrations before the gateway starts.
* **Backups:** the database holds everything but media files and cloned
  repositories. Back up Postgres
  (`docker compose -f docker-compose.prod.yml exec db pg_dump -U commonindex commonindex > backup.sql`)
  and the `media` volume — or, with media in a bucket, turn on the bucket's
  versioning or backups instead. Keep `COMMONINDEX_SECRET_KEY` with them: without it the
  stored warehouse credentials cannot be decrypted.
* **Logs:** `docker compose -f docker-compose.prod.yml logs -f gateway`.
* **Health:** the gateway answers `GET /api/v1/_ops`; Compose restarts any
  service that stops.

## Media storage

Rendered videos, their posters and page snapshots are files. By default they
are kept in the `media` volume on this machine. To keep them in a bucket
instead — needed to run more than one gateway or worker machine, and simpler
to back up — set `COMMONINDEX_MEDIA_STORE=s3` and the bucket's details in `.env`.
Any S3-compatible store works:

| Store | `COMMONINDEX_MEDIA_ENDPOINT` | `COMMONINDEX_MEDIA_REGION` | Credentials |
|---|---|---|---|
| AWS S3 | leave empty | the bucket's region | an instance role, or an access key |
| Google Cloud Storage | `https://storage.googleapis.com` | `auto` | an HMAC key (Cloud Storage → Settings → Interoperability) |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | an R2 API token's access key |
| MinIO and others | the server's address | as configured | an access key |

Put the key in `COMMONINDEX_MEDIA_ACCESS_KEY_ID` and
`COMMONINDEX_MEDIA_SECRET_ACCESS_KEY`, or leave them empty to use the standard
AWS chain (an instance or workload role, or `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`). `COMMONINDEX_MEDIA_PREFIX` keeps the files under one
folder, so one bucket can serve several deployments.

The key needs to read, write and delete objects under the prefix, and to
**list the bucket**: without list permission a missing file reads as "access
denied" rather than "not there". On AWS that is `s3:GetObject`,
`s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::your-bucket/prefix/*`
plus `s3:ListBucket` on `arn:aws:s3:::your-bucket`.

Keep the bucket **private**. Files are still read through the gateway, which
checks that the reader may see the item before streaming it out of the
bucket, so the bucket needs no public access and no CORS rules.

Switching stores does not move files already kept: render a video again, or
save an artifact again, to put it in the new store.

## Background work and scaling

Video renders, page snapshots and code indexing are jobs in a Postgres queue,
run by the `worker` service rather than the web server
(`commonindex/workers/jobs.py`). A job is claimed by exactly one worker; one left
running when its worker died is put back in the queue; its progress is a row
any gateway can read. More workers run more jobs at once:

```sh
docker compose -f docker-compose.prod.yml up -d --scale worker=3
```

Changes to conversations reach open pages at once over a stream (`/events`,
fed by Postgres `LISTEN/NOTIFY`), so several gateways behind a load balancer
all push; pages fall back to polling if the stream is unavailable. Threads
load a page of conversations at a time and then only what changed.

## Security notes

* The web app is built without any token; everyone signs in.
* Sign-in codes are rate-limited per address.
* Set `COMMONINDEX_SIGN_IN=required` (the default in this file). `local` signs in
  anyone on the gateway's machine and is for a laptop only.
* Warehouse credentials are encrypted with `COMMONINDEX_SECRET_KEY`, and so is a
  token for indexing a private repository while its job waits — wiped when the
  job ends.
* Pushed changes say only which conversation changed, and only to people who
  may read it; the content is fetched through the usual access checks.
