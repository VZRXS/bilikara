from __future__ import annotations

import sys
from . import rust_runtime


def detect_lan_ipv4_addresses(*, platform_name: str | None = None) -> list[str]:
    return rust_runtime.detect_lan_ipv4_addresses(
        platform_name=(platform_name or sys.platform).casefold()
    )
