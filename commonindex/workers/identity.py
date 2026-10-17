"""Resolves the same person and account across every connected source.

N5, accepted in the freeze, built alongside the first two connectors rather than
retrofitted at the twentieth. With v1 scope at exactly two — Slack and GitHub,
both keyed on a verified email or SSO subject — the deterministic path covers
very nearly all of it and the probabilistic path will rarely fire. It is built
now so the pattern is established rather than bolted on later.

OPEN: `same_as` edges join two objects, but people and agents live in ``actors``,
which is a different table, and there is no person object type. The review found
this and it is unresolved — either actors become objects with ``actors`` as an
extension table, or identity links need storage of their own.
"""

from commonindex.core.eventlog import Event

#: A wrong identity merge is expensive and hard to notice, so nothing merges
#: silently below this.
FLOOR = 0.90


class Resolver:
    name = "identity"

    async def handle(self, e: Event) -> None:
        # 1 · deterministic first — SSO subject, then verified email. Exhaust
        #     these before scoring: they resolve most of the volume and are
        #     never wrong. Writes same_as with confidence None.
        # 2 · probabilistic second, above FLOOR only, and as a PROPOSAL.
        #     Accepting is an event; unmerging is a replay without it, which is
        #     the only reason probabilistic linking is safe to run at all.
        raise NotImplementedError
