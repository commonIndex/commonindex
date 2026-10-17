# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue, pull
request or discussion.

Use GitHub's private reporting: on this repository's **Security** tab, choose
**Report a vulnerability**. Only the maintainers can see the report.

Please include:

- what the problem is and what an attacker could do with it;
- the steps to reproduce it, or a proof of concept;
- the version or commit you tested.

We will acknowledge your report within five working days and keep you updated
until it is resolved. Please give us a reasonable time to release a fix before
you disclose the problem publicly. We are glad to credit you in the release
notes, if you want that.

## Supported versions

Security fixes go into the latest release. Please update to it before
reporting, if you can.

## Running CommonIndex safely

- `docker-compose.full.yml` is a **local demo**. It signs in anyone who can
  load the page as the admin. Never expose it to a network.
- For a real deployment, use `docker-compose.prod.yml` behind TLS and follow
  [docs/deploy.md](docs/deploy.md).
- Keep `COMMONINDEX_SECRET_KEY` secret and backed up: it encrypts stored
  connection credentials.
