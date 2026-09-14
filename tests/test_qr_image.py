"""P01 production QR paths; synthetic inputs, real FFI, independent ZXing decode.

Install requirements-test-qr.txt to run the independent decoder tests.
With BILIKARA_REQUIRE_RUST_LIB=1 a missing decoder/native backend fails the gate.
"""
from __future__ import annotations

import base64
import io
import os
import stat
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image, ImageOps

from bilikara import rust_runtime, server
from login_service_fixture import LoginFixture

try:
    import zxingcpp
except ImportError:
    zxingcpp = None


REMOTE_PREFIX = "https://rtc.kevinx96.icu/remote.html#"
SHORT_URL = "https://example.test/"
REMOTE_URL = REMOTE_PREFIX + (
    "room=SYNTHETIC00000000000000000&join=SYNTHETIC0000000000000000000000000000000"
    "&expires=1788649200000&password=synthetic%2Bonly%26value"
)
ESCAPED_URL = REMOTE_PREFIX + "url=https%3A%2F%2Fexample.test%2Fa%3Fx%3D1&x=a+b%20c%2f%2F#fragment"
UNICODE_URL = REMOTE_PREFIX + "room=合成测试&name=カラオケ🎤&value=%E4%B8%AD#片段"
LOGIN_URL = "https://passport.bilibili.com/synthetic-login?token=SYNTHETIC-ONLY%2B123#qr"


def post_qr(url, *, address="127.0.0.1"):
    handler = server.BilikaraHandler.__new__(server.BilikaraHandler)
    handler.path = "/api/internet-remote/qr"
    handler.headers = {}
    handler.client_address = (address, 12345)
    handler.connection = SimpleNamespace(getsockname=lambda: ("127.0.0.1", 6764))
    handler._read_json_body = lambda: {"url": url}
    writes = []
    handler._write_json = lambda payload, status=200: writes.append((status, payload))
    with patch.object(server, "CONTEXT", SimpleNamespace(touch_client=Mock())):
        handler.do_POST()
    assert len(writes) == 1
    return writes[0]


class QrImageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not rust_runtime.app_state_available() or zxingcpp is None:
            reason = "P01 requires native Runtime and requirements-test-qr.txt (zxing-cpp)"
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                raise RuntimeError(reason)
            raise unittest.SkipTest(reason)

    def decode(self, png, expected, *, quiet=0):
        image = Image.open(io.BytesIO(png))
        self.assertEqual(image.format, "PNG")
        image.load()  # Read/decompress the whole image, not just the signature.
        self.assertEqual(image.mode, "1")
        self.assertEqual(image.width, image.height)
        if quiet:
            image = ImageOps.expand(image, border=quiet, fill="white")
        decoded = zxingcpp.read_barcode(image.convert("L"))
        self.assertIsNotNone(decoded)
        self.assertTrue(decoded.valid)
        self.assertEqual(decoded.bytes, expected.encode("utf-8"))
        self.assertEqual(decoded.ec_level, "M")
        return image

    def test_real_ffi_exact_payloads_for_both_borders(self):
        # Includes the full HTTP character limit, without an arbitrary byte cap.
        max_remote = REMOTE_PREFIX + "x" * (2048 - len(REMOTE_PREFIX))
        for payload in [SHORT_URL, REMOTE_URL, ESCAPED_URL, UNICODE_URL, max_remote, LOGIN_URL]:
            for border in [0, 4]:
                with self.subTest(payload_kind=len(payload), border=border):
                    result = rust_runtime.generate_qr_image(payload, border=border)
                    self.assertEqual(base64.b64decode(result.data_url.split(",", 1)[1]), result.png)
                    image = self.decode(result.png, payload, quiet=40 if border == 0 else 0)
                    self.assertEqual(image.getpixel((0, 0)), 255)

    def test_endpoint_keeps_response_and_url_bytes(self):
        for payload in [REMOTE_URL, ESCAPED_URL, UNICODE_URL]:
            status, body = post_qr(payload)
            self.assertEqual(status, 200)
            self.assertEqual(set(body), {"ok", "data"})
            self.assertIs(body["ok"], True)
            self.assertEqual(set(body["data"]), {"image"})
            self.assertTrue(body["data"]["image"].startswith("data:image/png;base64,"))
            png = base64.b64decode(body["data"]["image"].split(",", 1)[1])
            self.assertEqual(Image.open(io.BytesIO(png)).getpixel((0, 0)), 0)
            self.decode(png, payload, quiet=40)

    def test_endpoint_access_and_url_validation_precede_encoding(self):
        with patch.object(rust_runtime, "generate_qr_image") as generate:
            for address in ["192.0.2.1", "::ffff:192.0.2.1"]:
                self.assertEqual(post_qr(REMOTE_URL, address=address), (403, {"ok": False, "error": "forbidden"}))
            for payload in ["", SHORT_URL, "http://rtc.kevinx96.icu/remote.html#x", REMOTE_PREFIX + "x" * 2048]:
                self.assertEqual(post_qr(payload), (400, {"ok": False, "error": "invalid Internet Remote URL"}))
            generate.assert_not_called()

    def test_capacity_and_invalid_parameters_fail_explicitly(self):
        for request, kind in [
            ({"payload": "x" * 2332, "module_scale": 10, "border": 0}, "capacity_exceeded"),
            ({"payload": "", "module_scale": 10, "border": 0}, "invalid_request"),
            ({"payload": "x", "module_scale": 0, "border": 0}, "invalid_request"),
            ({"payload": "x", "module_scale": 17, "border": 0}, "size_limit"),
            ({"payload": "x", "module_scale": 10, "border": 17}, "size_limit"),
            ({"payload": "x", "module_scale": -1, "border": 0}, "invalid_request"),
            ({"payload": 12, "module_scale": 10, "border": 0}, "invalid_request"),
            ({"payload": "x", "module_scale": 10, "border": False}, "invalid_request"),
            ({"payload": "x", "module_scale": 10, "border": 0, "extra": True}, "invalid_request"),
            ({}, "invalid_request"),
        ]:
            with self.subTest(kind=kind, keys=list(request)):
                with self.assertRaises(rust_runtime.RustRuntimeServiceError) as caught:
                    rust_runtime._call_runtime_service("qr_image", request)
                self.assertEqual(caught.exception.kind, kind)
                self.assertNotIn("result", caught.exception.response)
        # Valid HTTP character length, but too many UTF-8 bytes for a QR code.
        status, body = post_qr(REMOTE_PREFIX + "🎤" * 1000)
        self.assertEqual(status, 500)
        self.assertIs(body["ok"], False)
        self.assertNotIn("data", body)
        self.assertNotIn("🎤", body["error"])

    def test_login_file_data_url_permissions_and_cleanup(self):
        # P02 moved the login file writer into Rust; retain the independent QR
        # decode, payload, permission and cleanup assertions at its real boundary.
        with TemporaryDirectory() as root, LoginFixture() as fixture:
            directory = Path(root) / "bbdown"
            data_path = str(directory / "BBDown.data")
            path = directory / "qrcode.png"
            for payload in [LOGIN_URL, "https://passport.bilibili.com/scan?name=カラオケ🎤"]:
                fixture.generate_body = {"code": 0, "data": {"url": payload, "qrcode_key": "synthetic"}}
                release = threading.Event()
                fixture.before_poll = lambda: release.wait(10)
                generation = rust_runtime.desktop_login("start", data_path=data_path, force=True)["generation"]
                worker = threading.Thread(target=rust_runtime.desktop_login, args=("run",), kwargs={
                    "data_path": data_path, "generation": generation,
                })
                worker.start()
                try:
                    deadline = time.monotonic() + 8
                    while True:
                        status = rust_runtime.desktop_login("snapshot", data_path=data_path)
                        if status["state"] == "waiting":
                            break
                        self.assertLess(time.monotonic(), deadline, status["state"])
                        time.sleep(.01)
                    self.assertEqual(path.read_bytes(), base64.b64decode(status["qr_image"].split(",", 1)[1]))
                    self.decode(path.read_bytes(), payload)
                    if os.name != "nt":
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                finally:
                    rust_runtime.desktop_login("cancel", data_path=data_path)
                    release.set()
                    worker.join(16)
                self.assertFalse(worker.is_alive())
                self.assertFalse(path.exists())
                rust_runtime.desktop_login("cancel", data_path=data_path)

    def test_native_unavailable_and_failed_never_fall_back(self):
        # Python qrcode cannot be imported even if installed in a developer env.
        with patch.dict("sys.modules", {"qrcode": None}):
            self.assertTrue(rust_runtime.generate_qr_image(LOGIN_URL, border=4).png)
            with patch.object(rust_runtime, "_runtime_lib", None):
                with self.assertRaises(rust_runtime.RustRuntimeUnavailableError):
                    rust_runtime.generate_qr_image(LOGIN_URL, border=4)
                self.assertEqual(post_qr(REMOTE_URL)[0], 500)
            with patch.object(rust_runtime, "_call_runtime_service", side_effect=rust_runtime.RustRuntimeServiceError(
                "encoding_failed", "QR image encoding failed", response={}
            )):
                with self.assertRaises(rust_runtime.RustRuntimeServiceError):
                    rust_runtime.generate_qr_image(LOGIN_URL, border=4)
                self.assertEqual(post_qr(REMOTE_URL)[0], 500)

    def test_malformed_native_images_are_rejected_before_consumption(self):
        for encoded in [None, "", "not base64", base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()]:
            with patch.object(rust_runtime, "_call_runtime_service", return_value={"png_base64": encoded}):
                with self.assertRaises(rust_runtime.RustRuntimeServiceError) as caught:
                    rust_runtime.generate_qr_image(LOGIN_URL, border=4)
                self.assertEqual(caught.exception.kind, "invalid_response")


if __name__ == "__main__":
    unittest.main()
