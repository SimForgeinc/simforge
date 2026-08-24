from __future__ import annotations

import json
import io
import os
import socket
import urllib.error
import urllib.request
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit


MAX_UPLOAD_ERROR_BODY_BYTES = 16 * 1024


def _is_s3_host(host: str) -> bool:
    return host == "s3.amazonaws.com" or (
        host.endswith(".amazonaws.com") or host.endswith(".amazonaws.com.cn")
    ) and (".s3." in host or ".s3-" in host or host.startswith("s3.") or host.startswith("s3-"))


def _trusted_artifact_url(url: str, configured_hosts_env: str) -> None:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError as exc:
        raise ValueError("artifact URL is malformed") from exc
    configured = {
        item.strip().lower().rstrip(".")
        for item in os.environ.get(configured_hosts_env, "").split(",")
        if item.strip()
    }
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("artifact URL must be an HTTPS URL without credentials or fragments")
    if host not in configured and not _is_s3_host(host):
        raise ValueError(f"artifact URL host is not allowed by {configured_hosts_env}")


def _verify_response_url(response: Any, original_url: str, configured_hosts_env: str) -> None:
    geturl = getattr(response, "geturl", None)
    final_url = geturl() if callable(geturl) else original_url
    _trusted_artifact_url(final_url, configured_hosts_env)


class _AllowlistedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, configured_hosts_env: str):
        super().__init__()
        self.configured_hosts_env = configured_hosts_env

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        _trusted_artifact_url(newurl, self.configured_hosts_env)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_artifact(request: urllib.request.Request, timeout: float, configured_hosts_env: str) -> Any:
    opener = urllib.request.build_opener(_AllowlistedRedirectHandler(configured_hosts_env))
    return opener.open(request, timeout=timeout)


class ArtifactUploadError(RuntimeError):
    """A bounded, secret-free summary of an object-store upload failure."""

    def __init__(self, status: int, body: bytes, truncated: bool):
        self.status = status
        self.body_bytes_captured = len(body)
        self.body_truncated = truncated
        self.error_code: str | None = None
        self.request_id: str | None = None
        try:
            root = ET.fromstring(body)
            values = {node.tag.rsplit("}", 1)[-1]: (node.text or "").strip() for node in root.iter()}
            self.error_code = values.get("Code") or None
            self.request_id = values.get("RequestId") or None
        except (ET.ParseError, UnicodeDecodeError):
            pass
        fields = [f"HTTP {status}"]
        if self.error_code:
            fields.append(f"code={self.error_code[:128]}")
        if self.request_id:
            fields.append(f"requestId={self.request_id[:128]}")
        fields.append(f"capturedBytes={self.body_bytes_captured}")
        if truncated:
            fields.append("truncated=true")
        super().__init__("artifact upload failed (" + ", ".join(fields) + ")")


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, ArtifactUploadError):
        return exc.status in {408, 425, 429} or 500 <= exc.status < 600
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in {408, 425, 429} or 500 <= exc.code < 600
    return isinstance(exc, (urllib.error.URLError, TimeoutError))


def _remaining_timeout(deadline_monotonic: Callable[[], float] | None, maximum: float) -> float:
    if deadline_monotonic is None:
        return maximum
    remaining = deadline_monotonic() - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("lease deadline exceeded")
    return max(0.001, min(maximum, remaining))


def _with_retries(
    operation: Any,
    attempts: int = 3,
    *,
    deadline_monotonic: Callable[[], float] | None = None,
    abort: Callable[[], None] | None = None,
) -> Any:
    for attempt in range(attempts):
        if abort:
            abort()
        _remaining_timeout(deadline_monotonic, float("inf"))
        try:
            return operation()
        except Exception as exc:
            if attempt + 1 == attempts or not _retryable(exc):
                raise
            if abort:
                abort()
            delay = min(0.25 * (2 ** attempt), _remaining_timeout(deadline_monotonic, float("inf")))
            time.sleep(delay)
    raise AssertionError("unreachable retry loop")


def download(
    url: str,
    maximum: int,
    *,
    deadline_monotonic: Callable[[], float] | None = None,
    abort: Callable[[], None] | None = None,
) -> bytes:
    _trusted_artifact_url(url, "UNISCENARIO_ASSET_DOWNLOAD_HOSTS")
    def operation() -> bytes:
        request = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
        with _open_artifact(request, _remaining_timeout(deadline_monotonic, 120), "UNISCENARIO_ASSET_DOWNLOAD_HOSTS") as response:
            _verify_response_url(response, url, "UNISCENARIO_ASSET_DOWNLOAD_HOSTS")
            chunks: list[bytes] = []
            size = 0
            while size <= maximum:
                if abort:
                    abort()
                _remaining_timeout(deadline_monotonic, 120)
                chunk = response.read(min(1024 * 1024, maximum + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            body = b"".join(chunks)
        if len(body) > maximum:
            raise RuntimeError(f"asset exceeds {maximum} byte download limit")
        return body
    return _with_retries(operation, deadline_monotonic=deadline_monotonic, abort=abort)


class _DeadlineReader:
    def __init__(self, source: Any, deadline_monotonic: Callable[[], float] | None, abort: Callable[[], None] | None):
        self.source = source
        self.deadline_monotonic = deadline_monotonic
        self.abort = abort
        self.last_abort = 0.0

    def read(self, size: int = -1) -> bytes:
        _remaining_timeout(self.deadline_monotonic, float("inf"))
        now = time.monotonic()
        if self.abort and (self.last_abort == 0.0 or now - self.last_abort >= 5.0):
            self.abort()
            self.last_abort = now
        return self.source.read(min(size if size >= 0 else 1024 * 1024, 1024 * 1024))


def upload(
    url: str,
    body: bytes | Path,
    media_type: str,
    headers: Mapping[str, str] | None = None,
    *,
    deadline_monotonic: Callable[[], float] | None = None,
    abort: Callable[[], None] | None = None,
) -> None:
    _trusted_artifact_url(url, "UNISCENARIO_ARTIFACT_UPLOAD_HOSTS")
    def operation() -> None:
        request_headers = dict(headers or {})
        if not any(name.lower() == "content-type" for name in request_headers):
            request_headers["Content-Type"] = media_type
        size = body.stat().st_size if isinstance(body, Path) else len(body)
        request_headers["Content-Length"] = str(size)
        source = body.open("rb") if isinstance(body, Path) else io.BytesIO(body)
        with source:
            reader = _DeadlineReader(source, deadline_monotonic, abort)
            request = urllib.request.Request(url, data=reader, method="PUT", headers=request_headers)
            try:
                with _open_artifact(request, _remaining_timeout(deadline_monotonic, 300), "UNISCENARIO_ARTIFACT_UPLOAD_HOSTS") as response:
                    _verify_response_url(response, url, "UNISCENARIO_ARTIFACT_UPLOAD_HOSTS")
                    if not 200 <= response.status < 300:
                        raise RuntimeError(f"artifact upload failed with HTTP {response.status}")
            except urllib.error.HTTPError as exc:
                captured = exc.read(MAX_UPLOAD_ERROR_BODY_BYTES + 1)
                raise ArtifactUploadError(
                    exc.code,
                    captured[:MAX_UPLOAD_ERROR_BODY_BYTES],
                    len(captured) > MAX_UPLOAD_ERROR_BODY_BYTES,
                ) from exc
    _with_retries(operation, deadline_monotonic=deadline_monotonic, abort=abort)

