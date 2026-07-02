import io
import json
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import bilikara.diagnostics as diagnostics


class DiagnosticArtifactTest(unittest.TestCase):
    def test_artifact_redacts_credentials_and_local_usernames(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            log_dir = root / "logs"
            log_dir.mkdir()
            config_file = root / "cache_policy.json"
            config_file.write_text(
                json.dumps(
                    {
                        "download_source": "ytdlp",
                        "cookie": "SESSDATA=config-secret",
                        "username": "Kevin",
                    }
                ),
                encoding="utf-8",
            )
            (log_dir / "recent.log").write_text(
                "Authorization: Bearer bearer-secret\n"
                "Cookie: SESSDATA=log-secret; bili_jct=csrf-secret\n"
                "requester=SingerAlice\n"
                "path=C:\\Users\\Kevin\\bilikara\n",
                encoding="utf-8",
            )
            cache_manager = SimpleNamespace(
                diagnostic_snapshot=lambda: {
                    "tools": {
                        "yt-dlp": {
                            "installed": True,
                            "version": "2026.06.01",
                            "state": "ready",
                            "path": "C:\\Users\\Kevin\\yt-dlp.exe",
                        }
                    },
                    "tasks": {"session_user_name": "Kevin", "active_item_id": "item-1"},
                }
            )
            connectivity = {
                "github": {"reachable": True, "status": 200, "latency_ms": 20, "error": ""}
            }

            with (
                patch.object(diagnostics, "APP_HOME", root),
                patch.object(diagnostics, "LOG_DIR", log_dir),
                patch.object(diagnostics, "DIAGNOSTIC_CONFIG_FILES", (config_file,)),
                patch.object(diagnostics, "_local_usernames", return_value={"Kevin"}),
                patch.object(
                    diagnostics.shutil,
                    "disk_usage",
                    return_value=SimpleNamespace(total=1000, used=400, free=600),
                ),
            ):
                artifact = diagnostics.build_diagnostic_artifact(
                    cache_manager=cache_manager,
                    cache_policy={"download_source": "ytdlp", "token": "policy-secret"},
                    runtime_state={"requester_name": "Kevin", "cache_status": "downloading"},
                    browser_info={"user_agent": "Browser C:\\Users\\Kevin", "brands": []},
                    local_usernames=["SingerAlice"],
                    connectivity_probe=lambda: connectivity,
                )

            with zipfile.ZipFile(io.BytesIO(artifact.zip_bytes())) as archive:
                names = set(archive.namelist())
                extracted = "\n".join(
                    archive.read(name).decode("utf-8", errors="replace")
                    for name in names
                )

            self.assertIn("diagnostics.md", names)
            self.assertIn("config/cache_policy.json", names)
            self.assertIn("logs/recent.log", names)
            self.assertIn("[REDACTED]", extracted)
            for secret in (
                "config-secret",
                "bearer-secret",
                "log-secret",
                "csrf-secret",
                "policy-secret",
                "Kevin",
                "SingerAlice",
            ):
                self.assertNotIn(secret, extracted)

    def test_redact_value_preserves_non_sensitive_diagnostic_fields(self):
        payload = diagnostics.redact_value(
            {
                "download_source": "bbdown",
                "video_quality": "1080P",
                "access_token": "secret",
                "session_users": ["Alice"],
            }
        )

        self.assertEqual(payload["download_source"], "bbdown")
        self.assertEqual(payload["video_quality"], "1080P")
        self.assertEqual(payload["access_token"], diagnostics.REDACTED)
        self.assertEqual(payload["session_users"], diagnostics.REDACTED)


if __name__ == "__main__":
    unittest.main()
