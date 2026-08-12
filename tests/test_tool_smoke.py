from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara.tool_smoke import packaged_tool_smoke_json


class PackagedToolSmokeTest(unittest.TestCase):
    def test_smoke_validates_native_runtime_capabilities(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime = root / "rust" / "bilikara_runtime.dll"
            runtime.parent.mkdir(parents=True)
            runtime.write_bytes(b"native")
            with patch(
                "bilikara.rust_runtime.runtime_status",
                return_value={
                    "loaded": True,
                    "path": str(runtime),
                    "abi_version": 1,
                    "error": "",
                    "capabilities": {
                        "http_download": True,
                        "media_backend": True,
                        "status_service": True,
                        "json_http": True,
                        "networking": True,
                        "update_installer": True,
                        "diagnostics": True,
                    },
                },
            ):
                payload = json.loads(packaged_tool_smoke_json("native"))

        self.assertEqual(payload["event"], "bilikara.tool_smoke")
        self.assertEqual(payload["tool"], "native")
        self.assertEqual(payload["version"], "ABI 1")
        self.assertTrue(payload["capabilities"]["media_backend"])
        self.assertTrue(payload["capabilities"]["status_service"])
        self.assertTrue(payload["capabilities"]["diagnostics"])


if __name__ == "__main__":
    unittest.main()
