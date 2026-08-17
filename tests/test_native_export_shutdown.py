import json
import multiprocessing
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path


def _run_native_export_shutdown_fixture(
    runtime_home: str,
    export_kind: str,
    shutdown_token: str,
    listener: socket.socket,
    readiness,
) -> None:
    """Run the real handler in a spawned child without inheriting test threads."""

    os.environ.update(
        {
            "BILIKARA_HOME": runtime_home,
            "BILIKARA_LAUNCH_MODE": "tauri",
            "BILIKARA_SHUTDOWN_TOKEN": shutdown_token,
            # This child isolates HTTP lifecycle behavior; it does not exercise
            # Rust policy loading and must remain portable across CI layouts.
            "BILIKARA_REQUIRE_RUST_LIB": "0",
            "BILIKARA_RUST_STRICT_EQUIVALENCE": "0",
        }
    )

    def send_stage(stage: str) -> None:
        readiness.send(("stage", stage))

    try:
        send_stage("BOOTSTRAP")
        from http.server import ThreadingHTTPServer

        send_stage("BEFORE_SERVER_IMPORT")
        import bilikara.server as server_module
        from bilikara.diagnostics import DiagnosticArtifact
        send_stage("SERVER_IMPORTED")

        context = server_module.CONTEXT
        original_do_get = server_module.BilikaraHandler.do_GET
        original_do_post = server_module.BilikaraHandler.do_POST
        entered = threading.Event()
        release = threading.Event()
        fixture_state_path = "/__test_native_export_shutdown/state"
        fixture_release_path = "/__test_native_export_shutdown/release"
        send_stage("FIXTURE_STATE_READY")

        server_module.BilikaraHandler._log_export_stage = lambda *args, **kwargs: None
        server_module.BilikaraHandler._log_diagnostics_stage = lambda *args, **kwargs: None

        def do_get(handler):
            route = handler.path.split("?", 1)[0]
            if route == fixture_state_path:
                handler._write_json({"ok": True, "entered": entered.is_set()})
                return
            if route == "/api/playlist/export":
                entered.set()
                release.wait(timeout=30)
            return original_do_get(handler)

        def do_post(handler):
            route = handler.path.split("?", 1)[0]
            if route == fixture_release_path:
                release.set()
                handler._write_json({"ok": True})
                return
            if route == "/api/diagnostics/package":
                entered.set()
                release.wait(timeout=30)
            return original_do_post(handler)
        send_stage("HANDLERS_READY")

        if export_kind == "png":
            server_module.playlist_image_export = lambda *args, **kwargs: (
                b"\\x89PNG\\r\\n\\x1a\\nfixture",
                "image/png",
                "playlist.png",
            )
        elif export_kind == "zip":
            server_module.playlist_image_export = lambda *args, **kwargs: (
                b"PK\\x03\\x04fixture",
                "application/zip",
                "playlist.zip",
            )
        send_stage("PAYLOAD_STUBBED")

        context.history_snapshot = lambda: [{"title": "shutdown test", "requested_at": 1.0}]
        context.session_played_snapshot = context.history_snapshot
        context.build_diagnostics = lambda *args, **kwargs: DiagnosticArtifact(
            markdown="# shutdown test",
            files={"system.json": b"{}"},
        )
        server_module.BilikaraHandler.do_GET = do_get
        server_module.BilikaraHandler.do_POST = do_post
        # macOS CI can block indefinitely in the spawned child's HTTPServer
        # bind path. The parent binds the disposable loopback port and
        # multiprocessing transfers the listener to retain the real
        # ThreadingHTTPServer request/daemon-thread/shutdown behavior.
        send_stage("BEFORE_SERVER_BIND")
        server = ThreadingHTTPServer(
            listener.getsockname(),
            server_module.BilikaraHandler,
            bind_and_activate=False,
        )
        server.socket.close()
        server.socket = listener
        server.server_address = listener.getsockname()
        server.server_name = "localhost"
        server.server_port = server.server_address[1]
        send_stage("SERVER_BOUND")
        # The fixture initializes only the server ownership request_shutdown()
        # consumes. bind_server() additionally launches unrelated UI startup
        # work, outside this handler/shutdown race.
        with context._client_lock:
            context._server = server
            context._shutdown_on_last_client = False
            context._shutdown_requested = False
            context._active_local_exports = 0
            if hasattr(context, "_local_export_idle"):
                context._local_export_idle.set()
        readiness.send(("ready", server.server_address[1]))
        readiness.close()
        try:
            server.serve_forever()
        finally:
            context.shutdown()
            server.server_close()
    except BaseException as exc:
        try:
            readiness.send(("error", type(exc).__name__))
        except (BrokenPipeError, EOFError, OSError):
            pass
        readiness.close()
        raise


class NativeExportShutdownLeaseTest(unittest.TestCase):
    """Exercise a real daemon handler paused after request parsing."""

    ROOT = Path(__file__).resolve().parents[1]
    FIXTURE_STATE_PATH = "/__test_native_export_shutdown/state"
    FIXTURE_RELEASE_PATH = "/__test_native_export_shutdown/release"
    SHUTDOWN_TOKEN = "native-export-shutdown-test-token"

    @staticmethod
    def _request(port: int, method: str, path: str, body: bytes = b"") -> bytes:
        request = (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n"
            f"Content-Length: {len(body)}\r\n"
            + ("Content-Type: application/json\r\n" if body else "")
            + "\r\n"
        ).encode("ascii") + body
        with socket.create_connection(("127.0.0.1", port), timeout=10) as stream:
            stream.sendall(request)
            stream.shutdown(socket.SHUT_WR)
            response = bytearray()
            while chunk := stream.recv(64 * 1024):
                response.extend(chunk)
        return bytes(response)

    @staticmethod
    def _wait_for_fixture_ready(readiness, process) -> int:
        deadline = time.monotonic() + 10
        last_stage = "NONE"
        while time.monotonic() < deadline:
            if not readiness.poll(max(0.0, deadline - time.monotonic())):
                break
            try:
                event, value = readiness.recv()
            except EOFError as exc:
                raise AssertionError(
                    "fixture closed before becoming ready "
                    f"(exit {process.exitcode}, stage={last_stage})"
                ) from exc
            if event == "stage":
                last_stage = str(value)
                continue
            if event == "ready" and isinstance(value, int) and 1 <= value <= 65535:
                return value
            raise AssertionError(
                "fixture failed before becoming ready "
                f"(exit {process.exitcode}, event={event!r}, stage={last_stage})"
            )
        raise AssertionError(
            "fixture did not become ready within 10 seconds "
            f"(exit {process.exitcode}, stage={last_stage})"
        )

    @classmethod
    def _wait_for_dispatch(cls, port: int) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                response = cls._request(port, "GET", cls.FIXTURE_STATE_PATH)
            except OSError:
                time.sleep(0.05)
                continue
            header_end = response.find(b"\r\n\r\n")
            if response.startswith(b"HTTP/1.1 200 OK\r") and header_end >= 0:
                state = json.loads(response[header_end + 4 :].decode("utf-8"))
                if state.get("entered") is True:
                    return
            time.sleep(0.05)
        raise AssertionError("export handler did not reach the post-parse barrier")

    @classmethod
    def _release_dispatch(cls, port: int) -> None:
        response = cls._request(port, "POST", cls.FIXTURE_RELEASE_PATH, b"{}")
        if not response.startswith(b"HTTP/1.1 200 OK\r"):
            raise AssertionError("fixture did not release the paused export handler")

    @staticmethod
    def _read_export(port: int, method: str, path: str, body: bytes, result: dict[str, bytes]) -> None:
        request = (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n"
            "X-Bilikara-Client: native-export-shutdown-test\r\n"
            f"Content-Length: {len(body)}\r\n"
            + ("Content-Type: application/json\r\n" if method == "POST" else "")
            + "\r\n"
        ).encode("ascii") + body
        with socket.create_connection(("127.0.0.1", port), timeout=10) as stream:
            stream.sendall(request)
            stream.shutdown(socket.SHUT_WR)
            response = bytearray()
            while chunk := stream.recv(64 * 1024):
                response.extend(chunk)
        result["response"] = bytes(response)

    @classmethod
    def _request_shutdown(cls, port: int) -> None:
        request = (
            "POST /api/app/shutdown HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n"
            "Content-Type: application/json\r\n"
            f"X-Bilikara-Shutdown-Token: {cls.SHUTDOWN_TOKEN}\r\n"
            "Content-Length: 2\r\n\r\n{}"
        ).encode("ascii")
        with socket.create_connection(("127.0.0.1", port), timeout=10) as stream:
            stream.sendall(request)
            stream.shutdown(socket.SHUT_WR)
            while stream.recv(64 * 1024):
                pass

    @staticmethod
    def _content_length_matches(response: bytes) -> bool:
        header_end = response.find(b"\r\n\r\n")
        if header_end < 0:
            return False
        for line in response[:header_end].split(b"\r\n")[1:]:
            if line.lower().startswith(b"content-length:"):
                return len(response) - header_end - 4 == int(line.split(b":", 1)[1].strip())
        return False

    def _run_case(self, kind: str, method: str, path: str, body: bytes, content_type: bytes) -> None:
        with tempfile.TemporaryDirectory(prefix="bilikara-native-export-shutdown-") as runtime_home:
            context = multiprocessing.get_context("spawn")
            readiness, child_readiness = context.Pipe(duplex=False)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                process = context.Process(
                    target=_run_native_export_shutdown_fixture,
                    args=(runtime_home, kind, self.SHUTDOWN_TOKEN, listener, child_readiness),
                )
                process.start()
                child_readiness.close()
                try:
                    port = self._wait_for_fixture_ready(readiness, process)
                    received: dict[str, bytes] = {}
                    client = threading.Thread(
                        target=self._read_export,
                        args=(port, method, path, body, received),
                    )
                    client.start()
                    self._wait_for_dispatch(port)

                    self._request_shutdown(port)
                    # v0.7.1 exits while its daemon export handler is still paused,
                    # producing a clean empty response. The lease must keep the
                    # server alive until the admitted export completes.
                    process.join(timeout=1)
                    self.assertTrue(
                        process.is_alive(),
                        f"shutdown ended the admitted export (exit {process.exitcode})",
                    )
                    self._release_dispatch(port)
                    client.join(10)
                    self.assertFalse(client.is_alive())
                    response = received.get("response", b"")
                    self.assertEqual(response[:16], b"HTTP/1.1 200 OK\r")
                    self.assertIn(content_type, response.split(b"\r\n\r\n", 1)[0])
                    self.assertTrue(self._content_length_matches(response))
                    process.join(timeout=10)
                    self.assertFalse(process.is_alive())
                    self.assertEqual(process.exitcode, 0)
                finally:
                    readiness.close()
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=10)
                    if process.is_alive():
                        process.kill()
                        process.join(timeout=10)

    def test_shutdown_waits_for_each_native_export(self):
        cases = (
            ("csv", "GET", "/api/playlist/export?format=csv&source=history", b"", b"Content-Type: text/csv; charset=utf-8"),
            ("png", "GET", "/api/playlist/export?format=image&source=history&page_size=80", b"", b"Content-Type: image/png"),
            ("zip", "GET", "/api/playlist/export?format=image&source=history&page_size=80", b"", b"Content-Type: application/zip"),
            ("diagnostics", "POST", "/api/diagnostics/package", b'{"browser":{}}', b"Content-Type: application/zip"),
        )
        for case in cases:
            with self.subTest(kind=case[0]):
                self._run_case(*case)


if __name__ == "__main__":
    unittest.main()
