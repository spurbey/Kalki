import hashlib
import json
from collections.abc import Mapping
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse
from urllib.request import ProxyHandler, Request, build_opener

from .contracts import HttpJsonResponse


class AllowlistedHttpClient:
    def __init__(self, allowed_hosts: set[str], timeout: int, max_bytes: int):
        self.allowed_hosts = allowed_hosts
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.opener = build_opener(ProxyHandler({}))

    def _check_url(self, url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.hostname not in self.allowed_hosts:
            raise ValueError(f"URL is not allowed: {url}")

    def get_json(
        self,
        url: str,
        *,
        params: Mapping[str, str | int | float | bool] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> HttpJsonResponse:
        self._check_url(url)
        request_url = f"{url}?{urlencode(params)}" if params else url
        request = Request(request_url, headers=dict(headers or {}), method="GET")
        with self.opener.open(request, timeout=self.timeout) as response:
            final_url = response.geturl()
            self._check_url(final_url)
            body = response.read(self.max_bytes + 1)
            if len(body) > self.max_bytes:
                raise ValueError("HTTP response exceeded max_response_bytes")
            return HttpJsonResponse(
                data=json.loads(body),
                final_url=final_url,
                status=response.status,
                retrieved_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                response_sha256=hashlib.sha256(body).hexdigest(),
            )


class NoNetworkHttpClient:
    def get_json(self, url: str, **_: object) -> HttpJsonResponse:
        raise RuntimeError(f"Network access is disabled for transformers: {url}")
