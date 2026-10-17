# Contributing to CommonIndex

Thank you for helping. This page covers what we need from every contribution
and how to get a change ready.

## Before you start

- **Agree to the [Contributor License Agreement](CLA.md).** Every pull request
  needs it, because CommonIndex is offered under more than one license (see the
  README). You agree by ticking the box in the pull request template. Without
  it, we can't merge the change.
- **For anything large, open an issue first.** Describe the problem and the
  change you have in mind, so we can agree on the approach before you spend
  time on it.
- **Security problems are not issues.** Report them privately, as
  [SECURITY.md](SECURITY.md) explains.

## Setting up

[docs/development.md](docs/development.md) covers the code layout and running
from source. The short version:

```sh
make dev-db                              # Postgres with sample data
make dev-gateway                         # the API, on :8000
cd web && npm install && npm run dev     # the web app, on :5173
```

## Before you open a pull request

Run the checks. They must all pass:

```sh
make check            # lint, license check and the backend tests
cd web && npx vitest run && npx tsc -b
```

- **Add a test** for a fix or a feature. A bug fix's test should fail without
  the fix.
- **Keep dependencies permissive.** `make licenses` accepts only licenses on its
  allow-list (MIT, BSD, Apache-2.0 and similar). Don't add copyleft (GPL, AGPL),
  source-available or non-commercial dependencies.
- **Only contribute code you wrote**, or code whose license allows it. Don't
  paste code from other projects. If you include third-party material, add it
  to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with its license.
- **Match the code around you**: its naming, comment style and structure.
- **Keep each pull request to one change**, with a description of what changed
  and why.

## Code of Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
