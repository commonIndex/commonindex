"""CommonIndex — the open substrate.

Everything in this package is Apache-2.0 open per P1: the event log, the object
model, the MCP gateway and the skill format. Governance — SSO/SCIM, audit export,
residency, BYOK, trust tiers and promotion — lives in ``commonindex_enterprise``.

The split is a packaging fact rather than a comment, because P1 was decided early
precisely so the boundary would not need retrofitting once authorization has
threaded through every surface.
"""
