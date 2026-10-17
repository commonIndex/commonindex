"""Where rendered videos, their posters and artifact snapshots are kept.

They used to live only in a folder on the gateway's disk. That is fine on one
machine and wrong on two: a render finished by one worker was missing on the
gateway that served the next request, and a replaced machine took every file
with it. So the folder is now one of two stores:

* **local** (the default): a folder, `COMMONINDEX_MEDIA_DIR`. Nothing to set
  up, and right for one machine.
* **s3**: a bucket in any S3-compatible object store: AWS S3, Google Cloud
  Storage (through its S3-compatible XML API and HMAC keys), Cloudflare R2,
  MinIO, Backblaze B2, Wasabi. Every gateway and worker reads and writes the
  same files.

    COMMONINDEX_MEDIA_STORE=s3
    COMMONINDEX_MEDIA_BUCKET=my-bucket
    COMMONINDEX_MEDIA_PREFIX=commonindex/          # optional
    COMMONINDEX_MEDIA_ENDPOINT=https://storage.googleapis.com   # not for AWS
    COMMONINDEX_MEDIA_REGION=us-east-1             # optional

Credentials come from the usual AWS chain (an instance role, AWS_ACCESS_KEY_ID
and AWS_SECRET_ACCESS_KEY, a profile), or, when this deployment keeps its
media somewhere other than its other AWS calls, from COMMONINDEX_MEDIA_ACCESS_KEY_ID
and COMMONINDEX_MEDIA_SECRET_ACCESS_KEY.

**Files still go through the gateway.** A browser asks the gateway, the
gateway checks the reader may see the item, and streams the bytes from the
store. Nothing in the bucket is public, and no bucket needs CORS rules.

Renders and snapshots are still made in a working folder on local disk (the
renderer and Chrome write files); only the finished file moves to the store.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from collections.abc import AsyncIterator
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from fastapi.responses import FileResponse, Response, StreamingResponse

ROOT = Path(__file__).resolve().parents[2]

#: Bytes per read when streaming a file out of a bucket.
CHUNK = 1 << 20


def media_dir() -> Path:
    """The local folder: the whole store when it is local, and the working
    folder for renders and snapshots either way."""
    return Path(os.environ.get("COMMONINDEX_MEDIA_DIR") or ROOT / ".media").resolve()


class MediaStore(Protocol):
    """Files by key, like `videos/<id>.mp4`. Keys never come from a request."""

    name: str

    async def put(self, key: str, path: Path, content_type: str) -> int:
        """Keep the file at `path` under `key`, taking it (the local file is gone
        afterwards). Returns its size in bytes."""

    async def exists(self, key: str) -> bool: ...

    async def read(self, key: str) -> bytes | None:
        """The whole file, for something small; None when there is none."""

    async def response(self, key: str, media_type: str, filename: str | None = None) -> Response | None:
        """The file as an HTTP response; None when there is none."""

    async def delete(self, key: str) -> None: ...


class LocalStore:
    name = "local"

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, key: str) -> Path:
        return self.root / key

    async def put(self, key: str, path: Path, content_type: str) -> int:
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), dest)
        return dest.stat().st_size

    async def exists(self, key: str) -> bool:
        return self._path(key).exists()

    async def read(self, key: str) -> bytes | None:
        p = self._path(key)
        return p.read_bytes() if p.exists() else None

    async def response(self, key: str, media_type: str, filename: str | None = None) -> Response | None:
        p = self._path(key)
        if not p.exists():
            return None
        return FileResponse(p, media_type=media_type, filename=filename)

    async def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class S3Store:
    """Any S3-compatible bucket. `client` is a boto3 S3 client (or anything with
    its methods: the tests pass a fake)."""

    name = "s3"

    def __init__(self, client, bucket: str, prefix: str = "") -> None:
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""

    def _key(self, key: str) -> str:
        return self.prefix + key

    def _missing(self, e: Exception) -> bool:
        code = str(getattr(e, "response", {}).get("Error", {}).get("Code", ""))
        return code in ("404", "NoSuchKey", "NotFound")

    async def put(self, key: str, path: Path, content_type: str) -> int:
        size = path.stat().st_size
        await asyncio.to_thread(self.client.upload_file, str(path), self.bucket, self._key(key),
                                ExtraArgs={"ContentType": content_type})
        path.unlink(missing_ok=True)
        return size

    async def _head(self, key: str) -> dict | None:
        try:
            return await asyncio.to_thread(self.client.head_object, Bucket=self.bucket, Key=self._key(key))
        except Exception as e:
            if self._missing(e):
                return None
            raise

    async def exists(self, key: str) -> bool:
        return await self._head(key) is not None

    async def read(self, key: str) -> bytes | None:
        try:
            obj = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=self._key(key))
        except Exception as e:
            if self._missing(e):
                return None
            raise
        return await asyncio.to_thread(obj["Body"].read)

    async def response(self, key: str, media_type: str, filename: str | None = None) -> Response | None:
        try:
            obj = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=self._key(key))
        except Exception as e:
            if self._missing(e):
                return None
            raise
        body = obj["Body"]

        async def chunks() -> AsyncIterator[bytes]:
            try:
                while chunk := await asyncio.to_thread(body.read, CHUNK):
                    yield chunk
            finally:
                body.close()

        headers = {}
        if obj.get("ContentLength") is not None:
            headers["Content-Length"] = str(obj["ContentLength"])
        if filename:
            headers["Content-Disposition"] = f'attachment; filename="{filename}"'
        return StreamingResponse(chunks(), media_type=media_type, headers=headers)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=self._key(key))


class MediaConfigError(RuntimeError):
    """The media settings name a store that cannot be used."""


def _s3_settings() -> tuple[str, ...]:
    keys = ("BUCKET", "PREFIX", "ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")
    return tuple((os.environ.get(f"COMMONINDEX_MEDIA_{k}") or "").strip() for k in keys)


@lru_cache(maxsize=4)
def _s3(bucket: str, prefix: str, endpoint: str, region: str, key_id: str, secret: str) -> S3Store:
    """One client per set of settings: boto3 clients are thread-safe and costly to make."""
    if not bucket:
        raise MediaConfigError("COMMONINDEX_MEDIA_STORE=s3 needs COMMONINDEX_MEDIA_BUCKET")
    try:
        import boto3
        from botocore.config import Config
    except ImportError as e:
        raise MediaConfigError("COMMONINDEX_MEDIA_STORE=s3 needs boto3: install the `s3` extra "
                               "(uv sync --extra s3)") from e
    kwargs: dict = {"config": Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"})}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    if region:
        kwargs["region_name"] = region
    if key_id and secret:
        kwargs["aws_access_key_id"], kwargs["aws_secret_access_key"] = key_id, secret
    return S3Store(boto3.client("s3", **kwargs), bucket, prefix)


def store() -> MediaStore:
    """The store these settings name. Read each time, so a test (or an operator
    reloading settings) is never served a store for a folder it moved away from."""
    kind = (os.environ.get("COMMONINDEX_MEDIA_STORE") or "local").strip().lower()
    if kind == "local":
        return LocalStore(media_dir())
    if kind == "s3":
        return _s3(*_s3_settings())
    raise MediaConfigError(f"COMMONINDEX_MEDIA_STORE={kind!r}: use local or s3")
