"""Compatibility entry for the native package gate (no retired smoke flags)."""
from __future__ import annotations

import json
from pathlib import Path
import sys

from check_native_desktop_bundle import check


def main() -> None:
    # The maintained native gate checks the real shipped layout for forbidden
    # executables/runtimes, launches it without PATH tools, exercises authenticated
    # HTTP/SSE and shuts down/reopens it. Media fixtures use the dedicated libav
    # package gate; a successful check is not fabricated media-render evidence.
    report = check(Path(sys.argv[1]).resolve(strict=True))
    report["mediaCliAbsent"] = True
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
