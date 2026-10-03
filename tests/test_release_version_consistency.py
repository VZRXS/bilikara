from __future__ import annotations

import json
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_VERSION = "0.8.0"


class ReleaseVersionConsistencyTest(unittest.TestCase):
    def test_application_manifests_use_release_version(self):
        tauri_config = json.loads(
            (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        with (ROOT / "src-tauri" / "Cargo.toml").open("rb") as handle:
            tauri_manifest = tomllib.load(handle)
        with (ROOT / "rust" / "Cargo.toml").open("rb") as handle:
            rust_manifest = tomllib.load(handle)
        with (ROOT / "rust-runtime" / "Cargo.toml").open("rb") as handle:
            runtime_manifest = tomllib.load(handle)
        with (ROOT / "rust-runtime" / "Cargo.lock").open("rb") as handle:
            runtime_lock = tomllib.load(handle)
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        package_lock = json.loads(
            (ROOT / "package-lock.json").read_text(encoding="utf-8")
        )

        self.assertEqual(tauri_config["version"], EXPECTED_VERSION)
        self.assertEqual(tauri_manifest["package"]["version"], EXPECTED_VERSION)
        self.assertEqual(rust_manifest["package"]["version"], EXPECTED_VERSION)
        self.assertEqual(runtime_manifest["package"]["version"], EXPECTED_VERSION)
        self.assertEqual(
            next(package for package in runtime_lock["package"] if package["name"] == "bilikara_runtime")["version"],
            EXPECTED_VERSION,
        )
        self.assertEqual(package["version"], EXPECTED_VERSION)
        self.assertEqual(package_lock["version"], EXPECTED_VERSION)
        self.assertEqual(package_lock["packages"][""]["version"], EXPECTED_VERSION)



if __name__ == "__main__":
    unittest.main()
