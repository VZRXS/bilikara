from __future__ import annotations

import json
import os
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

import build_bundle


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_VERSION = "0.7.1"


class ReleaseVersionConsistencyTest(unittest.TestCase):
    def test_application_manifests_use_release_version(self):
        tauri_config = json.loads(
            (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        with (ROOT / "src-tauri" / "Cargo.toml").open("rb") as handle:
            tauri_manifest = tomllib.load(handle)
        with (ROOT / "rust" / "Cargo.toml").open("rb") as handle:
            rust_manifest = tomllib.load(handle)
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        package_lock = json.loads(
            (ROOT / "package-lock.json").read_text(encoding="utf-8")
        )

        self.assertEqual(tauri_config["version"], EXPECTED_VERSION)
        self.assertEqual(tauri_manifest["package"]["version"], EXPECTED_VERSION)
        self.assertEqual(rust_manifest["package"]["version"], EXPECTED_VERSION)
        self.assertEqual(package["version"], EXPECTED_VERSION)
        self.assertEqual(package_lock["version"], EXPECTED_VERSION)
        self.assertEqual(package_lock["packages"][""]["version"], EXPECTED_VERSION)

    def test_bundle_and_windows_versions_use_release_representation(self):
        with patch.dict(os.environ, {"BILIKARA_VERSION": "v0.7.1"}, clear=False):
            self.assertEqual(build_bundle._bundle_version(), "v0.7.1")
        self.assertEqual(build_bundle._windows_version_tuple("v0.7.1"), (0, 7, 1, 0))


if __name__ == "__main__":
    unittest.main()
