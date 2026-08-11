from __future__ import annotations

from dataclasses import dataclass
import json
import ssl
import sys
import urllib.parse
import urllib.request

PACKAGED_HTTPS_SMOKE_URL = "https://example.com/"
_SYSTEM_TRUST_INJECTED = False


@dataclass(frozen=True)
class HttpsTrustStatus:
    backend: str
    verify_mode: ssl.VerifyMode
    check_hostname: bool


def _is_frozen_macos() -> bool:
    return sys.platform == "darwin" and bool(getattr(sys, "frozen", False))


def _strict_default_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    if context.verify_mode != ssl.CERT_REQUIRED or context.check_hostname is not True:
        raise RuntimeError(
            "HTTPS trust initialization refused an insecure SSL context: "
            "certificate and hostname verification must remain enabled"
        )
    return context


def initialize_https_trust() -> HttpsTrustStatus:
    global _SYSTEM_TRUST_INJECTED

    backend = "python-default"
    if _is_frozen_macos():
        if not _SYSTEM_TRUST_INJECTED:
            try:
                import truststore
            except ImportError as exc:
                raise RuntimeError(
                    "truststore is required for packaged macOS HTTPS system trust"
                ) from exc
            truststore.inject_into_ssl()
        backend = "macos-system"

    context = _strict_default_context()
    if backend == "macos-system":
        _SYSTEM_TRUST_INJECTED = True
    return HttpsTrustStatus(
        backend=backend,
        verify_mode=context.verify_mode,
        check_hostname=context.check_hostname,
    )


def perform_packaged_https_smoke(timeout: float = 20.0) -> dict[str, object]:
    trust_status = initialize_https_trust()
    parsed = urllib.parse.urlsplit(PACKAGED_HTTPS_SMOKE_URL)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise RuntimeError("Packaged HTTPS smoke endpoint must be a credential-free HTTPS URL")

    context = _strict_default_context()
    request = urllib.request.Request(
        PACKAGED_HTTPS_SMOKE_URL,
        headers={"User-Agent": "bilikara-packaged-https-smoke"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        response.read(1)
        status_code = int(getattr(response, "status", 0) or 0)
    if status_code < 200 or status_code >= 400:
        raise RuntimeError(f"Packaged HTTPS smoke endpoint returned HTTP {status_code}")

    return {
        "event": "bilikara.https_smoke",
        "status": status_code,
        "trustBackend": trust_status.backend,
        "verifyMode": "CERT_REQUIRED",
        "checkHostname": True,
    }


def packaged_https_smoke_json(timeout: float = 20.0) -> str:
    return json.dumps(perform_packaged_https_smoke(timeout), sort_keys=True)
