#!/usr/bin/env python3
"""Real desktop backend + shared browser UI, behind a non-forwarding TLS fixture.

Uses P02's fixture trust/QR exchange and generated local media. Python is only
this test orchestrator; the child serving Host/UI is the production Rust entry.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlsplit, parse_qs
from login_service_fixture import LoginFixture

ROOT = Path(__file__).resolve().parents[1]


def main():
    cache_policy = "--cache-policy" in sys.argv
    evidence = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="desktop-rust-evidence-"))
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="desktop-rust-fixture-") as temp:
        media = Path(temp)
        for name, args in [
            ("video.mp4", ["-f", "lavfi", "-i", "color=c=0x354c62:s=640x360:r=24", "-t", "90", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p"]),
            ("audio.m4a", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "90", "-vn", "-c:a", "aac"]),
        ]:
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", *args, "-movflags", "+faststart", str(media / name)], check=True)
        if cache_policy:
            subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","90","-c:a","flac","-strict","-2",str(media/"audio-flac.mp4")],check=True)
        fixture = LoginFixture()
        fixture.extra_hosts = ["api.bilibili.com", "fixture.bilivideo.com", "api.kevinx96.icu"]
        delayed = threading.Event()
        release = threading.Event()
        counts = {}
        media_requests = []
        media_delay = threading.Event()
        media_release = threading.Event(); media_release.set()
        def handle(handler):
            route = urlsplit(handler.path)
            query = parse_qs(route.query)
            name = route.path
            if name.startswith("/x/passport-login/"):
                return False
            counts[name] = counts.get(name, 0) + 1
            status = 200
            headers = {}
            if name == "/fixture/cache-stats":
                body = {"media":list(media_requests)}
            elif name == "/fixture/cache-delay":
                media_release.clear(); media_delay.set(); body = {}
            elif name == "/fixture/cache-release":
                media_delay.clear(); media_release.set(); body = {}
            elif name == "/fixture/delayed":
                body = {"started": delayed.is_set()}
            elif name == "/fixture/release":
                release.set()
                body = {}
            elif name == "/fixture/login-wait":
                fixture.codes = [86101]
                body = {}
            elif name == "/x/web-interface/nav":
                body = {"code": 0, "data": {"wbi_img": {"img_url": "https://i0.hdslb.com/bfs/wbi/" + "a"*32 + ".png", "sub_url": "https://i0.hdslb.com/bfs/wbi/" + "b"*32 + ".png"}}}
            elif name == "/x/web-interface/wbi/view":
                bvid = query.get("bvid", ["BV1xx411c7mD"])[0]
                if bvid == "BV1xx411c7mF":
                    delayed.set()
                    if not release.wait(12):
                        raise AssertionError("Delayed metadata test did not release request")
                manual = bvid == "BV1xx411c7mE"
                body = {"code": 0, "data": {"aid": 123, "bvid": bvid, "title": "Desktop fixture " + bvid[-1], "pic": "", "owner": {"mid": 42, "name": "Fixture"},
                    "pages": [{"page": 1, "cid": 456, "duration": 90, "part": "Take A" if manual else "on vocal"}, {"page": 2, "cid": 457, "duration": 90, "part": "Take B" if manual else "off vocal"}]}}
            elif name in ["/x/player/wbi/playurl", "/x/player/playurl"]:
                body = {"code": 0, "data": {"quality": 64, "dash": {"video": [{"id": 64, "codecid": 7, "bandwidth": 100000, "baseUrl": "https://fixture.bilivideo.com/video.mp4", "mimeType": "video/mp4", "codecs": "avc1.64001e"}], "audio": [{"id": 30280, "bandwidth": 128000, "baseUrl": "https://fixture.bilivideo.com/audio.m4a", "mimeType": "audio/mp4", "codecs": "mp4a.40.2"}]}}}
                if cache_policy:
                    dash=body["data"]["dash"]
                    dash["video"]=[{"id":quality,"codecid":codec,"bandwidth":100000,"baseUrl":f"https://fixture.bilivideo.com/video.mp4?q={quality}&codec={codec}","mimeType":"video/mp4","codecs":"avc1.64001e" if codec==7 else "hev1.1.6.L93.B0"} for quality in [116,80,64,32,16] for codec in [7,12]]
                    dash["flac"]={"audio":{"id":30251,"baseUrl":"https://fixture.bilivideo.com/audio-flac.mp4","mimeType":"audio/mp4","codecs":"fLaC"}}
            elif name in ["/video.mp4", "/audio.m4a", "/audio-flac.mp4"]:
                media_requests.append({"path":name,"quality":query.get("q",[""])[0],"codec":query.get("codec",[""])[0]})
                if cache_policy and name=="/video.mp4" and media_delay.is_set():
                    media_release.wait(10)
                body = (media / name[1:]).read_bytes()
                if handler.headers.get("Range"):
                    first, last = handler.headers["Range"].split("=", 1)[1].split("-", 1)
                    first, last = int(first), int(last) if last else len(body)-1
                    headers["Content-Range"] = f"bytes {first}-{last}/{len(body)}"
                    body = body[first:last+1]
                    status = 206
                headers["Accept-Ranges"] = "bytes"
            elif name in ["/api/catalog/search", "/search", "/api/search"]:
                body = [{"title":"Desktop fixture catalog","bvid":"BV1xx411c7mD","url":"https://www.bilibili.com/video/BV1xx411c7mD"}]
            else:
                status, body = 503, {"error": "offline fixture: unsupported external request"}
            encoded = body if isinstance(body, bytes) else json.dumps(body).encode()
            handler.send_response(status)
            for key, value in headers.items():
                handler.send_header(key, value)
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
            env["BILIKARA_CATALOG_SHEETS_URL"] = "http://127.0.0.1:1/disabled-fixture.csv"
            env["DESKTOP_FIXTURE_CONTROL"] = f"http://127.0.0.1:{fixture.server.server_port}"
            # Restrict only the application, not fixture generation or WebKit.
            application_path = media / "application-path"
            application_path.mkdir()
            env["BILIKARA_TEST_APPLICATION_PATH"] = str(application_path)
            if cache_policy: env["BILIKARA_CACHE_POLICY_FIXTURE"]="1"
            driver="tests/live_desktop_import.js" if cache_policy else "tests/live_desktop_rust_host.js"
            result = subprocess.run(["node", driver, str(evidence)], cwd=ROOT, env=env, timeout=240)
        if cache_policy: assert not fixture.stages, "Cache policy tests must not run login"
        else: assert "generate" in fixture.stages and "poll" in fixture.stages
        forbidden = [name for name in counts if any(word in name for word in ["batch-add", "rating", "space/wbi", "gviz", "d1/"])]
        assert not forbidden, forbidden
        (evidence / "fixture-summary.json").write_text(json.dumps({"request_counts": counts, "login_stages": fixture.stages, "forwarded_external_requests": 0}, indent=2))
        return result.returncode

if __name__ == "__main__":
    raise SystemExit(main())
