"""The media store: a local folder by default, or any S3-compatible bucket.

The bucket is a fake here, holding objects in a dict and answering the way an
S3 client does (including the 404 a missing key raises), so these run with
no network, no credentials and no boto3.
"""

from __future__ import annotations

import io

import pytest


class _Missing(Exception):
    """What botocore raises for a key that is not there."""

    def __init__(self, code="404"):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class _Body(io.BytesIO):
    pass


class FakeS3:
    def __init__(self):
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.fail_with: str | None = None

    def upload_file(self, filename, bucket, key, ExtraArgs=None):
        with open(filename, "rb") as f:
            self.objects[(bucket, key)] = (f.read(), (ExtraArgs or {}).get("ContentType", ""))

    def _get(self, bucket, key):
        if self.fail_with:
            raise _Missing(self.fail_with)
        if (bucket, key) not in self.objects:
            raise _Missing("404")
        return self.objects[(bucket, key)]

    def head_object(self, Bucket, Key):
        data, kind = self._get(Bucket, Key)
        return {"ContentLength": len(data), "ContentType": kind}

    def get_object(self, Bucket, Key):
        data, kind = self._get(Bucket, Key)
        return {"Body": _Body(data), "ContentLength": len(data), "ContentType": kind}

    def delete_object(self, Bucket, Key):
        self.objects.pop((Bucket, Key), None)


async def _body(resp) -> bytes:
    if hasattr(resp, "body_iterator"):
        return b"".join([c async for c in resp.body_iterator])
    return resp.body


@pytest.fixture
def bucket():
    from commonindex.gateway.media import S3Store

    fake = FakeS3()
    return fake, S3Store(fake, "media-bucket", prefix="/commonindex/")


async def test_the_bucket_keeps_a_file_under_its_prefix_and_takes_it(bucket, tmp_path):
    fake, s3 = bucket
    f = tmp_path / "video.mp4"
    f.write_bytes(b"frames")
    assert await s3.put("videos/v1.mp4", f, "video/mp4") == 6
    assert fake.objects[("media-bucket", "commonindex/videos/v1.mp4")] == (b"frames", "video/mp4")
    assert not f.exists()                       # the working copy is gone once it is kept
    assert await s3.exists("videos/v1.mp4") and not await s3.exists("videos/v2.mp4")
    assert await s3.read("videos/v1.mp4") == b"frames"
    assert await s3.read("videos/v2.mp4") is None


async def test_the_bucket_streams_a_file_out(bucket, tmp_path):
    _, s3 = bucket
    f = tmp_path / "v.webm"
    f.write_bytes(b"x" * 3_000_000)             # more than one chunk
    await s3.put("videos/v.webm", f, "video/webm")
    resp = await s3.response("videos/v.webm", "video/webm", filename="VID-1.webm")
    assert resp.headers["content-length"] == "3000000"
    assert 'filename="VID-1.webm"' in resp.headers["content-disposition"]
    assert await _body(resp) == b"x" * 3_000_000
    assert await s3.response("videos/none.webm", "video/webm") is None


async def test_a_bucket_failure_that_is_not_a_missing_key_is_raised(bucket):
    fake, s3 = bucket
    fake.fail_with = "AccessDenied"
    with pytest.raises(_Missing):
        await s3.exists("videos/v1.mp4")


async def test_deleting_from_the_bucket(bucket, tmp_path):
    fake, s3 = bucket
    f = tmp_path / "a.png"
    f.write_bytes(b"png")
    await s3.put("artifacts/a.png", f, "image/png")
    await s3.delete("artifacts/a.png")
    await s3.delete("artifacts/never.png")      # deleting nothing is not an error
    assert not fake.objects


async def test_the_folder_does_the_same(tmp_path):
    from commonindex.gateway.media import LocalStore

    local = LocalStore(tmp_path / "media")
    f = tmp_path / "shot.png"
    f.write_bytes(b"png")
    assert await local.put("artifacts/a.png", f, "image/png") == 3
    assert not f.exists() and (tmp_path / "media" / "artifacts" / "a.png").read_bytes() == b"png"
    assert await local.read("artifacts/a.png") == b"png" and await local.read("artifacts/b.png") is None
    resp = await local.response("artifacts/a.png", "image/png")
    assert resp.status_code == 200 and await local.response("artifacts/b.png", "image/png") is None
    await local.delete("artifacts/a.png")
    assert not await local.exists("artifacts/a.png")


def test_the_settings_choose_the_store(monkeypatch, tmp_path):
    from commonindex.gateway import media

    monkeypatch.delenv("COMMONINDEX_MEDIA_STORE", raising=False)
    monkeypatch.setenv("COMMONINDEX_MEDIA_DIR", str(tmp_path))
    assert media.store().name == "local" and media.store().root == tmp_path.resolve()

    monkeypatch.setenv("COMMONINDEX_MEDIA_STORE", "s3")
    monkeypatch.delenv("COMMONINDEX_MEDIA_BUCKET", raising=False)
    with pytest.raises(media.MediaConfigError, match="COMMONINDEX_MEDIA_BUCKET"):
        media.store()

    monkeypatch.setenv("COMMONINDEX_MEDIA_STORE", "azure")
    with pytest.raises(media.MediaConfigError, match="local or s3"):
        media.store()
