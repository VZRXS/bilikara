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

    def test_export_diagnostics_sanitization_bounds_and_redacts(self):
        cache_manager = SimpleNamespace(diagnostic_snapshot=lambda: {"tools": {}, "tasks": {}})
        raw_export_records = ["malformed_non_dict_entry"] + [
            {
                "timestamp": "2026-08-05T00:00:00Z",
                "surface": "host",
                "runtime": "tauri",
                "format": "csv",
                "source": "played",
                "pageSize": 200,
                "stage": "complete",
                "status": "saved",
                "httpStatus": 200,
                "contentType": "text/csv",
                "bytes": 1024,
                "filenameExtension": "csv",
                "elapsedMs": 150,
                "stageTimings": [{"stage": "request_backend", "elapsedMs": 100}],
                "errorCode": None,
                "errorMessage": None,
                "requester": "AliceSecret",
                "songTitle": "SongSecret",
                "cookie": "SESSDATA=secret",
            }
            for _ in range(75)
        ]

        with (
            patch.object(diagnostics, "APP_HOME", Path("/tmp")),
            patch.object(diagnostics, "LOG_DIR", Path("/tmp/nonexistent_logs")),
            patch.object(diagnostics, "DIAGNOSTIC_CONFIG_FILES", ()),
            patch.object(diagnostics, "_local_usernames", return_value={"AliceSecret"}),
            patch.object(
                diagnostics.shutil,
                "disk_usage",
                return_value=SimpleNamespace(total=1000, used=400, free=600),
            ),
        ):
            artifact = diagnostics.build_diagnostic_artifact(
                cache_manager=cache_manager,
                cache_policy={},
                runtime_state={},
                export_diagnostics=raw_export_records,
                connectivity_probe=lambda: {},
            )

        with zipfile.ZipFile(io.BytesIO(artifact.zip_bytes())) as archive:
            names = set(archive.namelist())
            self.assertIn("export-diagnostics.json", names)
            export_bytes = archive.read("export-diagnostics.json")
            export_data = json.loads(export_bytes.decode("utf-8"))

        self.assertEqual(len(export_data), 64)
        for record in export_data:
            self.assertNotIn("requester", record)
            self.assertNotIn("songTitle", record)
            self.assertNotIn("cookie", record)
            self.assertEqual(record["format"], "csv")
            self.assertEqual(record["status"], "saved")

        self.assertIn("## Recent Export Pipeline Diagnostics", artifact.markdown)
        self.assertNotIn("AliceSecret", artifact.markdown)
        self.assertNotIn("SongSecret", artifact.markdown)

    def test_stage_timings_capped_at_16_in_python_sanitizer(self):
        many_timings = [{"stage": f"stage_{i}", "elapsedMs": i * 10} for i in range(25)]
        sanitized = diagnostics._sanitize_export_diagnostics(
            [
                {
                    "timestamp": "2026-08-05T00:00:00Z",
                    "surface": "host",
                    "runtime": "tauri",
                    "format": "csv",
                    "stageTimings": many_timings,
                }
            ]
        )
        self.assertEqual(len(sanitized[0]["stageTimings"]), 16)
        self.assertEqual(sanitized[0]["stageTimings"][0]["stage"], "stage_0")
        self.assertEqual(sanitized[0]["stageTimings"][-1]["stage"], "stage_15")

    def test_unreadable_log_root_does_not_fail_diagnostics(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            log_dir = root / "logs"
            log_dir.write_text("not a directory", encoding="utf-8")

            cache_manager = SimpleNamespace(diagnostic_snapshot=lambda: {"tools": {}, "tasks": {}})

            with (
                patch.object(diagnostics, "APP_HOME", root),
                patch.object(diagnostics, "LOG_DIR", log_dir),
                patch.object(diagnostics, "DIAGNOSTIC_CONFIG_FILES", ()),
                patch.object(diagnostics, "_local_usernames", return_value=set()),
                patch.object(
                    diagnostics.shutil,
                    "disk_usage",
                    return_value=SimpleNamespace(total=1000, used=400, free=600),
                ),
            ):
                artifact = diagnostics.build_diagnostic_artifact(
                    cache_manager=cache_manager,
                    cache_policy={},
                    runtime_state={},
                    connectivity_probe=lambda: {},
                )

            self.assertIsNotNone(artifact)
            self.assertIn("Bilikara Diagnostic Report", artifact.markdown)

            with zipfile.ZipFile(io.BytesIO(artifact.zip_bytes())) as archive:
                names = set(archive.namelist())
                self.assertIn("diagnostics.md", names)
                self.assertNotIn("logs/bad.log", names)


if __name__ == "__main__":
    unittest.main()
