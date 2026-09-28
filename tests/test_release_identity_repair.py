"""Constrain the preview.2 metadata repair to the known source archives."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts import repair_preview2_windows_identity as repair
from scripts.check_native_desktop_bundle import inspect_package


class ReleaseIdentityRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source, self.output = self.root / "original.zip", self.root / "repaired.zip"
        old = f"{repair.TAG}-g{repair.COMMIT[:12]}-dirty"
        self.facts = {"schema_version": 1, "backend": "rust", "version": old,
                      "resource_layout": "internal-v1", "platform": "windows",
                      "arch": "x64", "development": False}
        self.payload = {repair.RECORDS[0]: (old + "\r\n").encode("utf-8"),
                        repair.RECORDS[1]: json.dumps(self.facts).encode("utf-8"),
                        "bilikara/_internal/bilikara-desktop-host.exe": b"MZ\x00signed\xffbinary",
                        "bilikara/_internal/static/i18n.json": '{"语言":"中文"}'.encode("utf-8")}
        with zipfile.ZipFile(self.source, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in self.payload.items():
                archive.writestr(name, data)

    def test_changes_only_the_two_version_records_and_preserves_crlf(self):
        with patch.dict(repair.ORIGINAL_SHA256, x64=repair.sha256(self.source)):
            result = repair.repair(self.source, self.output, "x64")
        self.assertTrue(result["other_entries_byte_identical"])
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(archive.namelist(), list(self.payload))
            for name, data in self.payload.items():
                if name not in repair.RECORDS:
                    self.assertEqual(archive.read(name), data)
            self.assertEqual(archive.read(repair.RECORDS[0]), (repair.TAG + "\r\n").encode("utf-8"))
            facts = json.loads(archive.read(repair.RECORDS[1]))
            self.assertEqual(facts, {**self.facts, "version": repair.TAG})

    def test_unknown_archive_or_wrong_architecture_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "known original"):
            repair.repair(self.source, self.output, "x64")
        with patch.dict(repair.ORIGINAL_SHA256, arm64=repair.sha256(self.source)):
            with self.assertRaisesRegex(ValueError, "Unexpected package identity"):
                repair.repair(self.source, self.output, "arm64")
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_overwritten(self):
        self.output.write_bytes(b"preserve")
        with patch.dict(repair.ORIGINAL_SHA256, x64=repair.sha256(self.source)):
            with self.assertRaises(FileExistsError):
                repair.repair(self.source, self.output, "x64")
        self.assertEqual(self.output.read_bytes(), b"preserve")

    def test_release_gate_rejects_matching_but_wrong_version_records(self):
        internal = self.root / "_internal"
        internal.mkdir()
        (internal / "native-desktop.json").write_text(json.dumps(self.facts), encoding="utf-8")
        (internal / "APP_VERSION").write_text(self.facts["version"], encoding="utf-8")
        with patch.dict(os.environ, BILIKARA_EXPECT_RELEASE_VERSION=repair.TAG):
            with self.assertRaisesRegex(AssertionError, "Release version mismatch"):
                inspect_package(internal / "bilikara-desktop-host.exe")


if __name__ == "__main__":
    unittest.main()
