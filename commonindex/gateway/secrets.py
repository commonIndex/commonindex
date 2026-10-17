"""The credential store the connections table points at.

Kept out of ``commonindex/core`` on purpose. The core is the engine that names no
collection and holds no secret; a credential is neither an object nor part of
the graph, and the isolation guards should stay able to say so.

The contract is one function each way: put a plaintext in, get a handle back;
give the handle to the connection opener, get the plaintext back. Swapping this
for real KMS means replacing the two bodies, because the handle is opaque
everywhere else.
"""

from __future__ import annotations

import os

#: Where the data key comes from. Generated per process when unset, which makes
#: a dev restart lose stored credentials — noisy, and better than a default key
#: baked into the source, which is how a dev shortcut becomes a production CVE.
KEY_ENV = "COMMONINDEX_SECRET_KEY"


class MissingKey(RuntimeError):
    pass


def _fernet():
    from cryptography.fernet import Fernet

    key = os.environ.get(KEY_ENV)
    if not key:
        raise MissingKey(
            f"{KEY_ENV} is not set. Generate one with:\n"
            "  python -c \"from cryptography.fernet import Fernet;"
            " print(Fernet.generate_key().decode())\""
        )
    return Fernet(key.encode())


async def put(db, ref_id: str, plaintext: str, actor_id: str) -> str:
    """Store a credential and return the handle to keep on the connection."""
    token = _fernet().encrypt(plaintext.encode())
    await db.execute(
        "insert into connection_secrets (id, ciphertext, created_by) values ($1,$2,$3)"
        " on conflict (id) do update set ciphertext = excluded.ciphertext,"
        " rotated_at = now()",
        ref_id, token, actor_id)
    return f"local:{ref_id}"


async def get(db, secret_ref: str | None) -> str | None:
    """Resolve a handle at connect time. Returns None when there is no secret,
    which is a real case — a local socket connection needs no password."""
    if not secret_ref:
        return None
    if secret_ref.startswith("env:"):
        # The other honest backend: point at an environment variable and let
        # whatever already manages the deployment's secrets manage this one.
        return os.environ.get(secret_ref[4:])
    if not secret_ref.startswith("local:"):
        raise ValueError(f"unknown secret backend in {secret_ref!r}")
    row = await db.fetchrow(
        "select ciphertext from connection_secrets where id = $1", secret_ref[6:])
    if row is None:
        raise LookupError(f"no secret {secret_ref}")
    return _fernet().decrypt(bytes(row["ciphertext"])).decode()
