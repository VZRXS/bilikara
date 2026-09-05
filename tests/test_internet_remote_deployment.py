from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "internet-remote-sync.yml"


class RemoteResourcesParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.resources: set[str] = set()
        self.scripts: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "script":
            source = attributes.get("src")
        elif tag == "link":
            source = attributes.get("href")
        else:
            return
        if not source:
            return
        url = urlsplit(source)
        if url.scheme or url.netloc:
            return
        path = url.path.lstrip("/")
        self.resources.add(path)
        if tag == "script":
            self.scripts.add(path)


class InternetRemoteDeploymentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.resources = RemoteResourcesParser()
        cls.resources.feed((ROOT / "static" / "remote.html").read_text(encoding="utf-8"))
        cls.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

    def test_sync_copies_current_remote_html_dependencies(self):
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required to execute the actual asset sync")
        self.assertTrue({"export-guard.js", "export-download.js"} <= self.resources.scripts)
        with tempfile.TemporaryDirectory(prefix="bilikara-remote-assets-") as directory:
            destination = Path(directory)
            for script in ("export-guard.js", "export-download.js"):
                (destination / script).write_text("stale export script", encoding="utf-8")
            result = subprocess.run(
                [
                    powershell, "-NoProfile", "-File",
                    str(ROOT / "scripts" / "sync_internet_remote_assets.ps1"),
                    "-Destination", str(destination),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for asset in sorted(self.resources.resources | {"remote.html", "i18n.json"}):
                with self.subTest(asset=asset):
                    self.assertTrue((destination / asset).is_file(), f"Missing {asset}")
                    self.assertEqual(
                        (destination / asset).read_bytes(),
                        (ROOT / "static" / asset).read_bytes(),
                    )

    def test_production_syntax_checks_cover_every_remote_script(self):
        checked = set(re.findall(r"node --check static/([^\s]+)", self.workflow))
        self.assertEqual(self.resources.scripts - checked, set())


if __name__ == "__main__":
    unittest.main()
