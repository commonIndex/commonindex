"""The engine. Knows nothing about any collection.

The import rule, enforced by tests/test_core_isolation.py rather than by a grep:
no module under ``commonindex.core`` may name a collection, in a string literal or in a
match on ``.type``. If one appears, the abstraction has leaked and the next
collection costs what the last one did.
"""
