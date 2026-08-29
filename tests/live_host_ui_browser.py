#!/usr/bin/env python3
"""Rendered-browser Host/Remote regression and Host-shell acceptance harness."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BROWSER_DRIVER = Path(__file__).with_name("live_host_ui_browser.js")
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from tests.live_immutable_recache_acceptance import (  # noqa: E402
    _chromium_executable,
    _playwright_module_root,
)


def main(args: argparse.Namespace) -> int:
    playwright_root = _playwright_module_root(args.playwright_module_root)
    chromium = _chromium_executable(args.chromium)
    with tempfile.TemporaryDirectory(prefix="bilikara-host-ui-") as runtime_root:
        os.environ["BILIKARA_HOME"] = runtime_root
        os.environ["BILIKARA_HOST"] = "127.0.0.1"
        os.environ["BILIKARA_PORT"] = "0"
        os.environ["BILIKARA_REQUIRE_RUST_LIB"] = "1"

        from http.server import ThreadingHTTPServer

        from bilikara import server

        context = server.CONTEXT
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BilikaraHandler)
        context.bind_server(httpd, shutdown_on_last_client=False)
        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()
        port = int(httpd.server_address[1])
        node_env = dict(os.environ)
        node_env["NODE_PATH"] = str(playwright_root)
        command = [
            "node",
            str(BROWSER_DRIVER),
            f"http://127.0.0.1:{port}",
            str(chromium),
        ]
        if args.screenshot:
            command.append(str(Path(args.screenshot).resolve()))
        try:
            completed = subprocess.run(
                command,
                cwd=REPOSITORY_ROOT,
                env=node_env,
                capture_output=True,
                text=True,
                check=False,
            timeout=120,
            )
        finally:
            httpd.shutdown()
            httpd.server_close()
            context.shutdown()
        try:
            result = json.loads(completed.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as exc:
            raise RuntimeError(
                "Host UI browser driver returned invalid evidence\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            ) from exc
        print(f"HOST_UI_BROWSER_RESULT_JSON={json.dumps(result, ensure_ascii=False)}")
        if completed.stderr.strip():
            print(completed.stderr.strip(), file=sys.stderr)
        return 0 if completed.returncode == 0 and result.get("passed") is True else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--playwright-module-root")
    parser.add_argument("--chromium")
    parser.add_argument("--screenshot")
    raise SystemExit(main(parser.parse_args()))
