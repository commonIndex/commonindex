"""Code search with automatic repository routing.

The question "explain the order placement flow" names no repository, and the
caller is not expected to know which of an enterprise's repositories to look in.
So routing is the server's job — but the *hops* are not. An MCP client's own LLM
drives those by calling these operations repeatedly; nothing here calls a model.

That split is forced rather than chosen. A connected LLM cannot route: it does
not know which repositories exist, what is in them, or — the part that matters —
which ones this caller is allowed to see. Handing it the corpus so it could
choose would be handing it the thing the ACL exists to withhold.

Routing is close to free because of how Zoekt works. Rather than guessing at
likely repositories and searching those, it searches every repository the caller
may read, in one query, and lets the hit distribution say which ones mattered.
A guess that picks wrong is invisible to the caller; a ranking over everything
readable is reportable, which is why the response carries `selected_repos`,
`searched_repos` and a rationale instead of only results.

Authorization is applied three times on different mechanisms, because each one
alone has a failure mode the others cover:

  1. The repository set is built from the caller's own grants.
  2. Zoekt is queried with a filter naming exactly that set.
  3. Every hit is re-joined to `code_file` in Postgres with the ACL predicate on
     the same statement before any body is returned.

Step 3 is not redundant with step 2. Zoekt's index is a snapshot: a repository's
grants can be revoked between indexing and searching, and the shard would answer
anyway. Postgres is the authority; Zoekt only proposes candidates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from commonindex.adapters.zoekt import Zoekt, ZoektBadQuery, ZoektUnavailable

#: Hard ceilings. A caller may ask for less, never more — an MCP client is a
#: program with a bug budget of its own, and "the model asked for 10000" must
#: not be a way to pull a corpus into a context window.
MAX_LIMIT = 100
MAX_SNIPPET_CHARS = 4_000

#: Words carrying no retrieval signal in a question about code. Dropped only
#: when relaxing an over-strict query, never from the query as asked.
_STOPWORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "done",
    "for", "from", "get", "how", "i", "in", "is", "it", "its", "of", "on",
    "or", "the", "this", "to", "use", "used", "using", "was", "what", "when",
    "where", "which", "who", "why", "with",
})

#: Anything that means the caller wrote a deliberate Zoekt query rather than a
#: question. Relaxing one of these would change what they actually asked for.
_OPERATORS = re.compile(r"(^|\s)-|\b(sym|file|lang|repo|content|case|archived):|"
                        r"[(){}\[\]|\\^$*+?]|\bor\b")

#: Sentence punctuation, stripped before asking whether a query is prose.
#: `?` is both how people end questions and a regex quantifier, and treating a
#: trailing one as regex meant "how does X work?" was classified as a crafted
#: query and never relaxed — which is to say relaxation never fired for a
#: question typed the way people actually type questions.
_SENTENCE_END = re.compile(r"[?.!]+\s*$")


#: A Zoekt field — `file:`, `lang:`, `repo:`… — which keeps its meaning when the
#: rest of a query is taken literally.
_FIELD = re.compile(r"^-?(sym|file|f|lang|repo|r|content|c|case|archived|branch|b):\S")
#: What RE2, Zoekt's regex engine, gives a meaning to.
_REGEX_META = re.compile(r"([\\.^$|?*+()\[\]{}])")
#: Characters that make a valid pattern mean something other than the text.
_PATTERNISH = re.compile(r"[(){}\[\]|\\^$*+?.]")


def literal(q: str) -> str | None:
    """The query as text to find exactly, for Zoekt: field filters kept, the
    rest one quoted phrase with every regex character escaped. None when there
    is nothing to make literal.

    Zoekt reads each term as a regular expression, so pasted code — a method
    signature, `foo()`, a pointer type — is either refused outright or quietly
    searches for something else. Measured on temporalio/temporal:
    `func (e *matchingEngineImpl) AddWorkflowTask` was a 400 ("missing argument
    to repetition operator"), and quoted it matched nothing, because the
    parentheses still made a group.
    """
    fields, words = [], []
    for term in q.split():
        (fields if _FIELD.match(term) else words).append(term)
    if not words:
        return None
    # Two layers: the regex escape (`\(`), then Zoekt's quoted-string parser,
    # which takes one backslash off before the regex sees it — so a phrase
    # carries `\\(`. Measured: `"func \(e \*matchingEngineImpl\) …"` matched
    # nothing; `"func \\(e \\*matchingEngineImpl\\) …"` found the method.
    pattern = _REGEX_META.sub(r"\\\1", " ".join(words))
    phrase = pattern.replace("\\", "\\\\").replace('"', '\\"')
    return " ".join([*fields, f'"{phrase}"'])


def normalize(q: str) -> str:
    return _SENTENCE_END.sub("", q).strip()


def is_prose(q: str) -> bool:
    """A natural-language question rather than a crafted query.

    Zoekt ANDs every term, which is right for `place_order submit` and wrong for
    "http connection pooling and retries" — that requires one file containing
    all five words, and on a real corpus it returns nothing while the code
    plainly exists. Measured on psf/requests: the strict form matched 1 file,
    an OR over its content words matched 18.
    """
    stripped = normalize(q)
    return len(stripped.split()) > 2 and not _OPERATORS.search(stripped)


def singular(word: str) -> list[str]:
    """What to search for a word a question may have in the plural.

    Zoekt matches substrings, so `refund` finds `refunds` but `refunds` never
    finds `refund_invoice` — and a question says "refunds" while the code says
    `refund`. A plural whose singular is its prefix needs only the singular;
    `-ies` needs both, as `policy` is not inside `policies`. Code is not
    English, so this only ever widens: a word that merely ends in s is still
    found by the shorter form.
    """
    lower = word.lower()
    if len(word) < 5 or lower.endswith(("ss", "us", "is")):
        return [word]
    if lower.endswith("ies"):
        return [word, word[:-3] + "y"]
    if lower.endswith(("sses", "xes", "ches", "shes")):
        return [word[:-2]]
    if lower.endswith("s"):
        return [word[:-1]]
    return [word]


def relax(q: str) -> str | None:
    """The same question as an OR over its content words, or None if there is
    nothing left once the filler is removed."""
    words = [w for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", q)
             if w.lower() not in _STOPWORDS]
    if len(words) < 2:
        return None
    return "(" + " or ".join(dict.fromkeys(f for w in words for f in singular(w))) + ")"


#: A word written as code: CamelCase inside, or snake_case, or dotted.
_CODEY = re.compile(r"\b(?:[A-Za-z]+[a-z0-9][A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*)\b")


def code_words(q: str) -> list[str]:
    """The identifiers a question writes out as code: `AddWorkflowTask`, `place_order`."""
    return list(dict.fromkeys(_CODEY.findall(q)))


def identifiers(q: str) -> list[str]:
    """Zoekt queries for the identifiers a question names, best first: any it
    writes out as code, exactly; then three or four neighbouring content words
    joined (case-insensitive, so `addworkflowtask` finds `AddWorkflowTask` and
    `add_workflow_task`); then two."""
    named = code_words(q)
    words = [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9]*", q)
             if w.lower() not in _STOPWORDS and w not in named]
    out: list[str] = ["(" + " or ".join(named) + ")"] if named else []
    # Each run joined as written and with its words singular: a question asks
    # about "refunds for invoices", the code names `refund_invoice`.
    runs = [words, [singular(w)[-1] for w in words]]
    for sizes in ((4, 3), (2,)):
        grams = [("".join(ws[i:i + n]), "_".join(ws[i:i + n]))
                 for ws in runs for n in sizes for i in range(len(ws) - n + 1)]
        alts = list(dict.fromkeys(a for pair in grams for a in pair if len(a) >= 8))
        if alts:
            out.append("(" + " or ".join(alts) + ")")
    return out


def _is_phrase(q: str) -> bool:
    """Two to four plain words — typed as they would appear in a file."""
    words = q.split()
    return 2 <= len(words) <= 4 and not _OPERATORS.search(q) and not _PATTERNISH.search(q) \
        and all(re.fullmatch(r"[\w.-]+", w) for w in words)


@dataclass(frozen=True, slots=True)
class Readable:
    """One repository this caller may read."""

    repo_id: str
    title: str                  # "example/storefront"
    org: str
    repo: str
    branch: str
    provider: str
    last_indexed_at: str | None
    health: str
    #: The commit Postgres last indexed. A Zoekt shard at another commit is
    #: the stale one — not a file whose content simply did not change since.
    sha: str | None = None

    @property
    def slug(self) -> str:
        """`org/repo` — how Zoekt's own name ends, and how a caller names a
        repository when narrowing a search."""
        return f"{self.org}/{self.repo}"


async def readable_repos(pool, space: str, acl_keys: list[str]) -> list[Readable]:
    """Every repository the caller may read, newest-indexed first.

    The ACL predicate is on this statement rather than applied to its results:
    a repository the caller cannot read must not be enumerable at all, because
    the existence of `example/project-atlas` is itself worth withholding.
    """
    if not acl_keys:
        return []
    rows = await pool.fetch(
        "select id, title, props->>'org' as org, props->>'repo' as repo,"
        "       props->>'default_branch' as branch, props->>'provider' as provider,"
        "       props->>'last_indexed_at' as last_indexed_at,"
        "       coalesce(props->>'health','unknown') as health,"
        "       props->>'last_indexed_sha' as sha"
        "  from objects"
        " where type = 'code_repo' and space_id = $1 and deleted_at is null"
        "   and acl_keys && $2"
        " order by props->>'last_indexed_at' desc nulls last, id", space, acl_keys)
    # One repository, one row: a copy left by an older naming of the same
    # org/repo/branch (newest indexed wins, as ordered above) would answer every
    # search twice and be reported as "not indexed" beside its own results.
    seen: set[tuple[str, str, str]] = set()
    out: list[Readable] = []
    for r in rows:
        ident = ((r["org"] or "").lower(), (r["repo"] or "").lower(), (r["branch"] or "").lower())
        if ident in seen and ident[0]:
            continue
        seen.add(ident)
        out.append(Readable(repo_id=r["id"], title=r["title"] or "", org=r["org"] or "",
                            repo=r["repo"] or "", branch=r["branch"] or "",
                            provider=r["provider"] or "", health=r["health"],
                            last_indexed_at=r["last_indexed_at"], sha=r["sha"]))
    return out


def narrow(repos: list[Readable], wanted: list[str] | None) -> tuple[list[Readable], list[str]]:
    """Apply a caller's optional repository filter.

    Matches on `org/repo`, on the bare repo name, or on the full repo id, since
    a caller who has seen any of those should be able to use it. Names that
    matched nothing come back separately: silently ignoring one turns a typo
    into "that code does not exist", which is the most expensive wrong answer
    this system can give.
    """
    if not wanted:
        return repos, []
    by_key: dict[str, Readable] = {}
    for repo in repos:
        by_key.setdefault(repo.slug.lower(), repo)
        by_key.setdefault(repo.repo.lower(), repo)
        by_key.setdefault(repo.repo_id.lower(), repo)
    chosen, unknown = [], []
    for name in wanted:
        match = by_key.get(name.strip().lower())
        if match is None:
            unknown.append(name)
        elif match not in chosen:
            chosen.append(match)
    return chosen, unknown


def zoekt_names(listed: list[str], repos: list[Readable]) -> dict[str, Readable]:
    """Map Zoekt's repository names onto ours.

    `zoekt-git-index` has no flag to set a repository's name — it derives one
    from the clone's remote, giving `github.com/example/storefront`. Rather than
    re-implementing that derivation and hoping the two stay in step, the names
    are read back from the service and matched on their trailing `org/repo`.

    A repository we know about that Zoekt has never indexed simply does not
    appear here, and the caller is told the lexical index is missing for it
    rather than being shown an empty result that looks like an answer.
    """
    by_slug = {r.slug.lower(): r for r in repos}
    out: dict[str, Readable] = {}
    for name in listed:
        parts = [p for p in name.split("/") if p]
        if len(parts) >= 2:
            match = by_slug.get("/".join(parts[-2:]).lower())
            if match is not None:
                out[name] = match
    return out


def rank_repos(hits: list[dict]) -> list[dict]:
    """Which repositories actually answered, best first.

    Summed score rather than hit count: twenty incidental mentions of a common
    word should not outrank two strong matches on the identifier being traced.
    """
    totals: dict[str, dict[str, Any]] = {}
    for hit in hits:
        entry = totals.setdefault(hit["repo_id"], {
            "repo_id": hit["repo_id"], "repo": hit["repo"], "files": 0, "score": 0.0})
        entry["files"] += 1
        entry["score"] += hit["score"]
    return sorted(totals.values(), key=lambda e: (-e["score"], e["repo_id"]))


async def authorize(pool, space: str, acl_keys: list[str],
                    candidates: list[tuple[Readable, str]]) -> dict[tuple[str, str], dict]:
    """Re-check every candidate against Postgres and fetch what it really says.

    Zoekt's shard is a snapshot. A grant revoked after indexing leaves a shard
    that will still answer, so a hit is only a claim that something matched —
    never that the caller may see it. This is the statement that decides, and
    the ACL predicate is a clause on it rather than a filter over its results.
    """
    if not candidates:
        return {}
    repo_ids = list({repo.repo_id for repo, _ in candidates})
    paths = list({path for _, path in candidates})
    rows = await pool.fetch(
        "select id, title as path, props->>'repo_id' as repo_id,"
        "       props->>'sha' as sha, props->>'language' as language,"
        "       props->>'body' as body"
        "  from objects"
        " where type = 'code_file' and space_id = $1 and deleted_at is null"
        "   and acl_keys && $2 and props->>'repo_id' = any($3) and title = any($4)",
        space, acl_keys, repo_ids, paths)
    return {(r["repo_id"], r["path"]): dict(r) for r in rows}


def _lines(body: str, start: int, end: int) -> str:
    text = body.splitlines(keepends=True)[max(0, start - 1):end]
    return "".join(text)[:MAX_SNIPPET_CHARS]


def citation(repo: str, path: str, start: int | None, end: int | None) -> str:
    if start is None or end is None:
        return f"{repo}/{path}"
    return f"{repo}/{path}:L{start}-L{end}"


async def search(pool, zoekt: Zoekt | None, *, q: str, space: str, acl_keys: list[str],
                 repos: list[str] | None = None, path_glob: str | None = None,
                 language: str | None = None, limit: int = 20) -> dict:
    """Search, routing automatically when no repository is named.

    Returns the evidence plus how it was reached: which repositories were
    searched, which actually answered, what was withheld, and whether the
    lexical index was available. A caller that cannot see those cannot tell a
    thin answer from a complete one, and will present the first as the second.
    """
    limit = max(1, min(limit, MAX_LIMIT))
    all_readable = await readable_repos(pool, space, acl_keys)
    scoped, unknown = narrow(all_readable, repos)
    # `withheld_repos` below is READABLE repositories the caller's own `repos`
    # filter excluded — `all_readable` is already filtered by grant, so it can
    # only ever be non-zero when the caller narrowed. It is not a count of
    # repositories they may not see; those are never enumerated at all, which is
    # the point of `list_repos` omitting rather than redacting them.

    if not scoped:
        return {"query": q, "hits": [], "engine": "none",
                "searched_repos": [], "selected_repos": [],
                "unknown_repos": unknown, "withheld_repos": len(all_readable),
                "routing": "no readable repositories matched"
                           if all_readable else "caller has no readable repositories",
                "degraded": None}

    if zoekt is not None:
        try:
            return await _zoekt_search(pool, zoekt, q=q, space=space, acl_keys=acl_keys,
                                       scoped=scoped, all_readable=all_readable,
                                       unknown=unknown, narrowed=repos is not None,
                                       path_glob=path_glob,
                                       language=language, limit=limit)
        except ZoektUnavailable as error:
            # Degrade to the Postgres leg rather than failing: a worse answer
            # that says it is worse beats no answer. The reason is reported, so
            # "why did recall drop" is answerable without reading logs.
            degraded = f"zoekt unavailable, using postgres full-text: {error}"
    else:
        degraded = "zoekt not configured, using postgres full-text"

    result = await _postgres_search(pool, q=q, space=space, acl_keys=acl_keys,
                                    scoped=scoped, narrowed=repos is not None,
                                    path_glob=path_glob, language=language, limit=limit)
    result["degraded"] = degraded
    result["unknown_repos"] = unknown
    result["withheld_repos"] = len(all_readable) - len(scoped)
    return result


async def _zoekt_search(pool, zoekt: Zoekt, *, q: str, space: str, acl_keys: list[str],
                        scoped: list[Readable], all_readable: list[Readable],
                        unknown: list[str], narrowed: bool, path_glob: str | None,
                        language: str | None, limit: int) -> dict:
    indexed = zoekt_names([r.name for r in await zoekt.repos()], scoped)
    have = {r.slug.lower() for r in indexed.values()}
    missing = [r.slug for r in scoped if r.slug.lower() not in have]
    if not indexed:
        raise ZoektUnavailable("no readable repository has a search index yet")

    # A trailing "?" is a regex quantifier to Zoekt, so "cadence?" silently
    # searches for "cadenc" with an optional "e". Harmless here, wrong in
    # principle, and free to remove once the query is known to be prose.
    query = normalize(q) if is_prose(q) else q
    # Plain words choose the excerpt; a pattern's own match is Zoekt's first chunk.
    terms = [] if _PATTERNISH.search(q) else _terms(q)
    if language:
        query = f"lang:{language} {query}"
    if path_glob:
        # Zoekt's file: is a regex, not a glob. Translating the two wildcards a
        # caller actually uses is honest; passing a glob through as a regex
        # would silently match something else.
        query = f"file:{path_glob.replace('.', chr(92) + '.').replace('*', '.*').replace('?', '.')} {query}"

    # Pasted code reads as a regex to Zoekt. Refused, or valid and finding
    # nothing, it is asked again as the literal text — what someone pasting a
    # signature meant. A deliberate pattern that matches is left alone.
    as_literal = None
    # A question names code in words: "how does the matching engine add a
    # workflow task" is `AddWorkflowTask` on `matchingEngine`. Neighbouring
    # words joined are tried first — before every word ANDed, which on a large
    # real repository was satisfied by one huge file of imports that mentions all of them.
    if is_prose(q):
        for joined in identifiers(q):
            named, named_dropped = await _authorized_hits(
                pool, space, acl_keys, await zoekt.search(joined, repo_names=list(indexed), max_files=limit),
                indexed, terms)
            if named:
                return _zoekt_result(q, named, named_dropped, indexed, scoped, all_readable, unknown,
                                     missing, narrowed, limit, truncated=False, as_identifiers=joined)
    try:
        found = await zoekt.search(query, repo_names=list(indexed), max_files=limit)
    except ZoektBadQuery:
        as_literal = literal(query)
        if as_literal is None:
            raise
        found = await zoekt.search(as_literal, repo_names=list(indexed), max_files=limit)

    hits, dropped = await _authorized_hits(pool, space, acl_keys, found, indexed, terms)

    # A few words typed as they appear ("make bins") are a phrase first: files
    # holding it go ahead of files that merely hold each word somewhere.
    if hits and as_literal is None and _is_phrase(q) and (exact := literal(query)):
        phrased, _ = await _authorized_hits(
            pool, space, acl_keys, await zoekt.search(exact, repo_names=list(indexed), max_files=limit),
            indexed, terms)
        if phrased:
            first = {(h["repo_id"], h["path"]) for h in phrased}
            hits = phrased + [h for h in hits if (h["repo_id"], h["path"]) not in first]

    if not hits and as_literal is None and _PATTERNISH.search(q) and (exact := literal(query)):
        found_exact = await zoekt.search(exact, repo_names=list(indexed), max_files=limit)
        exact_hits, exact_dropped = await _authorized_hits(pool, space, acl_keys, found_exact, indexed, terms)
        if exact_hits:
            found, hits, dropped, as_literal = found_exact, exact_hits, exact_dropped, exact

    # Every term ANDed is right for an identifier pair and wrong for a question.
    # The retry keys off AUTHORIZED emptiness, not raw hits: a shard match that
    # is then dropped — a file type Zoekt indexes and this pipeline does not —
    # left the caller with nothing while suppressing the relaxation that would
    # have found something. Observed on psf/requests, where the strict phrase
    # matched one .rst file and nothing else.
    relaxed_to = None
    if not hits and is_prose(q) and as_literal is None:
        loosened = relax(q)
        if loosened:
            found = await zoekt.search(loosened, repo_names=list(indexed),
                                       max_files=limit)
            retried, retried_dropped = await _authorized_hits(
                pool, space, acl_keys, found, indexed, terms)
            if retried:
                hits, dropped, relaxed_to = retried, retried_dropped, loosened

    return _zoekt_result(q, hits, dropped, indexed, scoped, all_readable, unknown, missing,
                         narrowed, limit, truncated=found.truncated, relaxed_to=relaxed_to,
                         as_literal=as_literal)


def _zoekt_result(q, hits, dropped, indexed, scoped, all_readable, unknown, missing, narrowed,
                  limit, *, truncated, relaxed_to=None, as_literal=None, as_identifiers=None) -> dict:
    selected = rank_repos(hits)
    return {
        "query": q, "engine": "zoekt", "hits": hits[:limit],
        "searched_repos": sorted(r.slug for r in indexed.values()),
        "selected_repos": selected,
        "unknown_repos": unknown,
        "withheld_repos": len(all_readable) - len(scoped),
        "unindexed_repos": sorted(missing),
        "truncated": truncated,
        # Matched the search index but had no authorized row here. Usually a
        # file type the indexer accepts and the ingest allowlist does not.
        "dropped_unindexed": dropped,
        # Set when the question as asked matched nothing and a looser form did.
        "relaxed_to": relaxed_to,
        # Set when the text was searched for literally because, as a regex, it
        # was refused or found nothing.
        "as_literal": as_literal,
        # Set when a question was searched as the identifiers its words name.
        "as_identifiers": as_identifiers,
        # `narrowed` is whether the CALLER named repositories, which is what the
        # rationale claims. It used to be passed `bool(unknown)` — so a caller who
        # narrowed to a repository that exists was told "no repository was named
        # by the caller", in the one sentence that explains the search.
        "routing": _rationale(selected, len(indexed), narrowed, dropped, relaxed_to, as_identifiers),
        "degraded": None,
    }


def _terms(q: str) -> list[tuple[str, int]]:
    """The words of a query and what each weighs, for choosing which matched
    lines to show: a word written as code (`AddWorkflowTask`, `place_order`)
    weighs ten plain ones."""
    codey = {w.lower() for w in code_words(q)}
    return [(w.lower(), 10 if w.lower() in codey or "_" in w else 1)
            for w in re.findall(r"[A-Za-z0-9_.]{2,}", q) if w.lower() not in _STOPWORDS]


def _best_chunk(chunks, terms: list[tuple[str, int]]):
    """The excerpt that shows the most of what was asked. Zoekt returns one
    chunk per matched run in file order, and the first may hold one word of
    three: `make bins` cited lines with "make" while the phrase was further down.
    A word written as code outweighs any number of plain ones: asked where
    `AddWorkflowTask` is, a struct header saying "matching" and "service" is not
    the answer."""
    if not chunks:
        return None
    if not terms:
        return chunks[0]
    phrase = " ".join(t for t, _ in terms)

    def weight(c):
        body = c.body.lower()
        return (phrase in body, sum(w for t, w in terms if t in body), -c.start_line)

    return max(chunks, key=weight)


async def _authorized_hits(pool, space: str, acl_keys: list[str], found,
                           indexed: dict[str, Readable],
                           terms: list[tuple[str, int]] = ()) -> tuple[list[dict], int]:
    """Turn Zoekt candidates into hits Postgres agrees the caller may read.

    Returns the hits and how many candidates were refused, which are two
    different facts: the second is usually a file type the search index accepts
    and this pipeline does not, and it presents as "nothing matched" when
    something did.
    """
    candidates = [(indexed[hit.repo_name], hit.path)
                  for hit in found.hits if hit.repo_name in indexed]
    authorized = await authorize(pool, space, acl_keys, candidates)

    hits: list[dict] = []
    dropped = 0
    for hit in found.hits:
        repo = indexed.get(hit.repo_name)
        if repo is None:
            continue
        row = authorized.get((repo.repo_id, hit.path))
        if row is None:
            dropped += 1
            continue
        chunk = _best_chunk(hit.chunks, terms)
        start = chunk.start_line if chunk else None
        end = chunk.end_line if chunk else None
        hits.append({
            "object_id": row["id"], "repo_id": repo.repo_id, "repo": repo.slug,
            "path": hit.path, "sha": row["sha"],
            "language": hit.language or row["language"],
            "start_line": start, "end_line": end,
            "snippet": (chunk.body[:MAX_SNIPPET_CHARS] if chunk
                        else _lines(row["body"] or "", 1, 40)),
            "score": hit.score,
            # The shard against the repository's indexed commit. A file's own
            # `sha` is the commit its content last changed at, so comparing to
            # it flagged every file the newest commit did not touch.
            "stale": bool(hit.version and repo.sha and hit.version != repo.sha),
            "citation": citation(repo.slug, hit.path, start, end),
        })
    return hits, dropped


def _rationale(selected: list[dict], searched: int, narrowed: bool,
               dropped: int = 0, relaxed_to: str | None = None, as_identifiers: str | None = None) -> str:
    notes = ""
    if as_identifiers:
        notes += f"; the question was searched as the identifiers its words name: {as_identifiers}"
    if relaxed_to:
        notes += f"; the exact phrase matched nothing, so it was broadened to {relaxed_to}"
    if dropped:
        # Said out loud: otherwise this is indistinguishable from an absence,
        # and the fix (widen the ingest allowlist) is nowhere near the symptom.
        notes += (f"; {dropped} match(es) were in files this pipeline has not "
                  "indexed and were not returned")
    if not selected:
        return f"searched {searched} readable repositories; none matched{notes}"
    names = ", ".join(entry["repo"] for entry in selected[:3])
    tail = "" if narrowed else " (no repository was named by the caller)"
    return (f"searched {searched} readable repositories; "
            f"{len(selected)} answered, ranked by match strength: {names}{tail}{notes}")


async def _postgres_search(pool, *, q: str, space: str, acl_keys: list[str],
                           scoped: list[Readable], narrowed: bool, path_glob: str | None,
                           language: str | None, limit: int) -> dict:
    """The fallback leg.

    `chunks.tsv` is `to_tsvector('english', body)`, so this stems source code as
    English: it will not unify placeOrder with place_order, splits identifiers
    on punctuation, and cannot express a regex. Kept because a degraded answer
    that says so is better than none, not because it is equivalent.
    """
    args: list[Any] = [space, q, acl_keys, [r.repo_id for r in scoped]]
    clauses = ["c.space_id = $1", "c.object_type = 'code_file'",
               "c.tsv @@ plainto_tsquery('english', $2)", "c.acl_keys && $3",
               "o.deleted_at is null", "o.props->>'repo_id' = any($4)"]
    if path_glob:
        args.append(path_glob.replace("*", "%").replace("?", "_"))
        clauses.append(f"o.props->>'path' like ${len(args)}")
    if language:
        args.append(language)
        clauses.append(f"o.props->>'language' = ${len(args)}")
    args.append(limit)
    rows = await pool.fetch(
        "select c.object_id, c.body, c.start_line, c.end_line, o.title as path,"
        " o.props->>'repo_id' as repo_id, o.props->>'sha' as sha,"
        " o.props->>'language' as language,"
        " ts_rank_cd(c.tsv, plainto_tsquery('english', $2)) as score"
        " from chunks c join objects o on o.id = c.object_id"
        f" where {' and '.join(clauses)} order by score desc limit ${len(args)}", *args)

    by_id = {r.repo_id: r for r in scoped}
    hits = []
    for row in rows:
        repo = by_id.get(row["repo_id"])
        slug = repo.slug if repo else (row["repo_id"] or "")
        hits.append({
            "object_id": row["object_id"], "repo_id": row["repo_id"], "repo": slug,
            "path": row["path"], "sha": row["sha"], "language": row["language"],
            "start_line": row["start_line"], "end_line": row["end_line"],
            "snippet": (row["body"] or "")[:MAX_SNIPPET_CHARS],
            "score": float(row["score"]), "stale": False,
            "citation": citation(slug, row["path"], row["start_line"], row["end_line"]),
        })
    selected = rank_repos(hits)
    return {"query": q, "engine": "postgres-fts", "hits": hits,
            "searched_repos": sorted(r.slug for r in scoped),
            "selected_repos": selected, "unknown_repos": [],
            "withheld_repos": 0, "unindexed_repos": [], "truncated": False,
            "routing": _rationale(selected, len(scoped), narrowed)}


# ── symbols ──────────────────────────────────────────────────────────────
# Zoekt runs universal-ctags while indexing, so `sym:` already answers "where
# is this defined" without a symbol table of our own. That is why these are
# thin wrappers rather than a new index: the cheapest correct implementation
# of find_symbol is the one that does not duplicate an index we already build.

async def find_symbol(pool, zoekt: Zoekt | None, *, name: str, space: str,
                      acl_keys: list[str], repos: list[str] | None = None,
                      limit: int = 20) -> dict:
    """Where a symbol is DEFINED.

    `sym:` is a definition query, so this is the hop a caller makes after a
    search turns up a call site and they need the body. Falls back to a plain
    search when no symbol index is available, labelled so the caller knows the
    result is "mentions" rather than "definitions" — the two are different
    claims and conflating them is how a wrong file gets cited confidently.
    """
    cleaned = name.strip()
    if zoekt is None:
        result = await search(pool, None, q=cleaned, space=space, acl_keys=acl_keys,
                              repos=repos, limit=limit)
        result["kind"] = "mentions"
        return result
    result = await search(pool, zoekt, q=f"sym:{cleaned}", space=space,
                          acl_keys=acl_keys, repos=repos, limit=limit)
    result["kind"] = "definitions" if result.get("engine") == "zoekt" else "mentions"
    result["symbol"] = cleaned
    return result


async def find_references(pool, zoekt: Zoekt | None, *, name: str, space: str,
                          acl_keys: list[str], repos: list[str] | None = None,
                          limit: int = 40) -> dict:
    """Where a symbol is USED.

    Honest about what it is: a lexical search for the identifier, minus the
    lines that define it. There is no cross-file resolution here, so a common
    name ("create", "handler") will return unrelated matches. That is stated in
    `confidence` and in the tool description rather than left for the caller to
    discover, because an unqualified "references" implies a resolver we do not
    have — and a model told it has one will cite accordingly.
    """
    cleaned = name.strip()
    result = await search(pool, zoekt, q=cleaned, space=space, acl_keys=acl_keys,
                          repos=repos, limit=limit)
    result["symbol"] = cleaned
    result["kind"] = "references"
    result["confidence"] = "lexical"
    result["caveat"] = (
        "Lexical identifier matches, not resolved references. A short or common "
        "name will match unrelated code; confirm with code.get_file before citing."
    )
    return result


async def list_repos(pool, space: str, acl_keys: list[str]) -> dict:
    """What this caller can search.

    Exists so a connected model can orient before it searches, and so "nothing
    found" is distinguishable from "nothing indexed". Repositories the caller
    cannot read are absent rather than redacted: a redacted entry still tells
    the reader that `example/project-atlas` exists.
    """
    repos = await readable_repos(pool, space, acl_keys)
    return {"repos": [{"repo": r.slug, "repo_id": r.repo_id, "branch": r.branch,
                       "provider": r.provider, "health": r.health,
                       "last_indexed_at": r.last_indexed_at} for r in repos],
            "count": len(repos)}
