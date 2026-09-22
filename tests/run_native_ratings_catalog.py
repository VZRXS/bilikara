#!/usr/bin/env python3
"""Desktop rating/accepted-add routes and browser QA using the existing TLS fixture.

The production Rust executable owns state. This Python file is test orchestration
only. All external requests terminate locally; no accounts or D1 are contacted.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from urllib.parse import urlsplit, parse_qs
from login_service_fixture import LoginFixture


def main():
    evidence = Path(sys.argv[1]).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    fixture = LoginFixture()
    fixture.extra_hosts = ["api.bilibili.com", "api.kevinx96.icu"]
    calls = []
    failures = []
    gates = {key: threading.Event() for key in ("rating", "append", "metadata")}
    for gate in gates.values():
        gate.set()
    modes = {"rating": "success", "append": "success"}
    counts = {"metadata": 0}
    lock = threading.Lock()

    def handle(handler):
        parsed = urlsplit(handler.path)
        name, query = parsed.path, parse_qs(parsed.query)
        status, body = 200, {}
        if name.startswith("/x/passport-login/"):
            return False
        if name == "/fixture/control":
            for key in gates:
                if key in query:
                    (gates[key].clear if query[key][0] == "hold" else gates[key].set)()
                if key + "_mode" in query:
                    modes[key] = query[key + "_mode"][0]
        elif name == "/fixture/stats":
            with lock:
                body = {"calls": list(calls), "counts": dict(counts), "failures": list(failures)}
        elif name in ("/rate-song", "/batch-add"):
            payload = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
            if handler.headers.get("Cookie") or handler.headers.get("Authorization"):
                failures.append("private header on Catalog request")
            expected = {"session_user_name", "play_id", "bvid", "score"} if name == "/rate-song" else {"records"}
            if set(payload) != expected:
                failures.append("unexpected Catalog payload fields")
            if name == "/batch-add":
                fields = {"mid", "bvid", "title", "url", "owner_name", "owner_url", "cover_url"}
                if len(payload["records"]) != 1 or set(payload["records"][0]) != fields:
                    failures.append("unexpected public metadata")
            with lock:
                calls.append({"path": name, "body": payload, "accepted": False})
                entry = calls[-1]
            key = "rating" if name == "/rate-song" else "append"
            if not gates[key].wait(20):
                failures.append("fixture gate timed out")
            mode = modes[key]
            status = 503 if mode == "http_failure" else 200
            body = {"success": mode == "success", "error": "fixture-private-upstream-text"}
            entry["accepted"] = mode == "success"
        elif name == "/x/web-interface/nav":
            body = {"code": 0, "data": {"wbi_img": {"img_url": "https://i0.hdslb.com/bfs/wbi/" + "a" * 32 + ".png", "sub_url": "https://i0.hdslb.com/bfs/wbi/" + "b" * 32 + ".png"}}}
        elif name in ("/x/web-interface/wbi/view", "/x/web-interface/view"):
            with lock:
                counts["metadata"] += 1
            if not gates["metadata"].wait(20):
                failures.append("metadata gate timed out")
            bvid = query["bvid"][0]
            body = {"code": 0, "data": {"aid": 123, "bvid": bvid, "title": "Catalog fixture " + bvid[-1], "pic": "", "owner": {"mid": 42, "name": "Fixture UP"}, "pages": [{"page": 1, "cid": 456, "duration": 90, "part": "on vocal"}]}}
        else:
            # Reject media/update and every unrecognized external destination.
            status, body = 503, {"error": "offline fixture"}
            if any(part in name for part in ("space/wbi", "d1/", "admin/", "gviz")):
                failures.append("unauthorized background operation: " + name)
        encoded = json.dumps(body).encode()
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(encoded)))
        handler.end_headers()
        try:
            handler.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass
        return True

    fixture.handle_request = handle
    with fixture:
        env = dict(os.environ, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
        env["NODE_PATH"] = env.get("NODE_PATH", "/tmp/bilikara-pw/node_modules")
        env["CATALOG_FIXTURE_CONTROL"] = f"http://127.0.0.1:{fixture.server.server_port}"
        env["BILIKARA_CF_API_URL"] = "https://api.kevinx96.icu"
        env["BILIKARA_CATALOG_SHEETS_URL"] = "http://127.0.0.1:1/disabled.csv"
        try:
            result = subprocess.run(["node", "tests/browser/native_ratings_catalog.cjs", str(evidence)], env=env, timeout=240)
        finally:
            for gate in gates.values():
                gate.set()
    assert not failures, failures
    (evidence / "fixture-summary.json").write_text(json.dumps({"calls": calls, "counts": counts, "failures": failures, "forwarded_external_requests": 0}, indent=2))
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
