"""Explicit M2 live acceptance. Rust owns all comparison semantics.

Requires real M1 artifacts; missing inputs fail instead of skipping. Reports and
any synthetic privacy fixture are written only to the supplied directory outside
this repository. No cache discovery, network, media acceptance or normalization.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import unittest

OPTIONS = None


class LiveComparison(unittest.TestCase):
    def rust_test(self, name, extra_env, ignored=False):
        repo = Path(__file__).resolve().parent.parent
        command = ["cargo", "test", "--manifest-path", "rust-runtime/Cargo.toml", "--locked", "--lib", name,
                   "--", "--exact"]
        if ignored:
            command.append("--ignored")
        result = subprocess.run(command, cwd=repo, env=dict(os.environ, **extra_env),
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120)
        self.assertEqual(result.returncode, 0, "explicit Rust integration test must pass")
        self.assertIn(b"1 passed; 0 failed; 0 ignored", result.stdout)

    def test_existing_normalization_rejection(self):
        self.rust_test("experimental_libav::comparison::tests::live_existing_missing_mdat_normalization_rejection", {
            "BILIKARA_LIBAV_COMPANION": str(OPTIONS.companion),
            "BILIKARA_LIBAV_FIXTURES": str(OPTIONS.fixtures),
            "BILIKARA_M2_CONTRACT_REPORT": str(OPTIONS.out / "normalization-contract.json"),
        }, ignored=True)

    def test_default_runtime_stays_isolated(self):
        self.rust_test("experimental_libav::tests::missing_companion_is_unavailable_and_default_state_still_initializes", {
            "BILIKARA_LIBAV_COMPANION": str(OPTIONS.out / "absent.so"),
            "BILIKARA_M1_DEFAULT_INPUT": str(OPTIONS.fixtures / "video.mp4"),
        })

    def run_pair(self, name, source, kind="audio", repeat=1, companion=None, prefix=None, extra=()):
        command = [str(OPTIONS.driver), "compare", str(companion or OPTIONS.companion),
                   str(prefix or OPTIONS.prefix), str(source), name,
                   "--pure-rust", kind, "--repeat", str(repeat), *extra]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        self.assertLessEqual(len(result.stdout), 128 * 1024 * repeat)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(rows, "driver must emit an explicit report")
        (OPTIONS.out / (name + ".jsonl")).write_bytes(result.stdout)
        for row in rows:
            self.assertEqual(row["fixture_label"], name)
            self.assertEqual(row["inspection"]["complete_media_validation"], "not_established")
            self.assertEqual(row["inspection"]["media_acceptance"], "not_requested")
        return result.returncode, rows

    def test_real_corpus(self):
        # Expected fixture facts, not a second classifier. Every decision below
        # is produced by the Rust comparator and preserved in its JSONL.
        cases = [
            ("video", "video.mp4", "video", "success", "success"),
            ("aac", "aac.m4a", "audio", "success", "success"),
            ("multi-stream", "av.mp4", "video", "success", "media_contract_violation"),
            ("raw-flac", "audio.flac", "audio", "success", "invalid_media"),
            ("flac-mp4", "flac.mp4", "audio", "success", "success"),
            ("unknown-duration", "unknown-duration.flac", "audio", "success", "invalid_media"),
            # The read-only Pure Rust probe also succeeds here; the separately
            # executed existing normalization contract test must still reject.
            ("missing-mdat", "missing-mdat.m4a", "audio", "success", "success"),
            ("truncated-header", "truncated.mp4", "audio", "invalid_media", "invalid_media"),
            ("malformed-header", "unknown.bin", "audio", "invalid_media", "invalid_media"),
            ("long-flac", OPTIONS.long_fixture, "audio", "success", "success"),
        ]
        for name, filename, kind, enumeration, pure in cases:
            with self.subTest(fixture=name):
                source = filename if isinstance(filename, Path) else OPTIONS.fixtures / filename
                code, rows = self.run_pair(name, source, kind, repeat=3)
                self.assertEqual(code, 0 if enumeration == "success" else 1)
                self.assertEqual(len(rows), 3)
                for row in rows:
                    self.assertTrue(row["same_build"], "real same-build identity is mandatory")
                    for backend in ("libav", "ffprobe"):
                        self.assertEqual(row[backend]["outcome"], enumeration)
                        self.assertEqual(row["identity"][backend]["version"], "9.0.1")
                        self.assertEqual(row["identity"][backend]["library_versions_format_codec_util"], [4129125, 4129125, 3998053])
                    self.assertEqual(row["pure_rust"]["outcome"], pure)
                    self.assertNotIn("semantic_mismatch", row["primary"]["kinds"])
                    self.assertNotIn("potential_safety_mismatch", row["secondary"]["kinds"])
                    if enumeration == "success":
                        self.assertEqual(row["primary"]["kinds"], ["matching_comparable_metadata"])
                        self.assertIn("depth_or_contract_difference", row["secondary"]["kinds"])
                    else:
                        self.assertEqual(row["primary"]["kinds"], ["backend_or_reference_error"])
                if name == "unknown-duration":
                    self.assertIsNone(rows[0]["libav"]["metadata"]["duration_us"])
                    self.assertTrue(any(f["field"] == "container.duration_us" and f["kind"] == "not_comparable" for f in rows[0]["primary"]["fields"]))
                if name == "multi-stream":
                    self.assertEqual(len(rows[0]["libav"]["metadata"]["streams"]), 2)

    def test_missing_companion(self):
        code, rows = self.run_pair("missing-companion", OPTIONS.fixtures / "aac.m4a", companion=OPTIONS.out / "absent.so")
        self.assertEqual(code, 1)
        self.assertEqual(rows[0]["libav"]["outcome"], "unavailable")
        self.assertFalse(rows[0]["same_build"])
        self.assertEqual(rows[0]["primary"]["kinds"], ["backend_or_reference_error"])

    def test_missing_reference(self):
        code, rows = self.run_pair("missing-reference", OPTIONS.fixtures / "aac.m4a", prefix=OPTIONS.out / "absent-prefix")
        self.assertEqual(code, 1)
        self.assertEqual(rows[0]["libav"]["outcome"], "success")
        self.assertEqual(rows[0]["ffprobe"]["outcome"], "unavailable")
        self.assertFalse(rows[0]["same_build"])

    def test_precancelled(self):
        code, rows = self.run_pair("precancelled", OPTIONS.fixtures / "aac.m4a", repeat=3, extra=("--cancelled",))
        self.assertEqual(code, 1)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["comparison_cancelled"])
        for backend in ("libav", "ffprobe", "pure_rust"):
            self.assertEqual(rows[0][backend]["outcome"], "cancelled")

    def test_inflight_reference_cancel_reaps_child(self):
        prefix = OPTIONS.out / "cancel-prefix"
        (prefix / "bin").mkdir(parents=True, exist_ok=True)
        tool = prefix / "bin/ffprobe"
        pidfile = prefix / "child-pid"
        # A fake reference is used only for deterministic error-path evidence.
        tool.write_text('#!/bin/sh\necho $$ > "${0%/*}/../child-pid"\nexec /bin/sleep 30\n')
        tool.chmod(0o700)
        if pidfile.exists():
            pidfile.unlink()
        process = subprocess.Popen([str(OPTIONS.driver), "compare", str(OPTIONS.companion), str(prefix),
                                    str(OPTIONS.fixtures / "aac.m4a"), "inflight-cancel"],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(pidfile.exists(), "reference must have actually started")
            pid = int(pidfile.read_text())
            process.send_signal(signal.SIGINT)
            output, _ = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 1)
            report = json.loads(output)
            self.assertTrue(report["comparison_cancelled"])
            self.assertEqual(report["ffprobe"]["outcome"], "cancelled")
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            (OPTIONS.out / "inflight-cancel.jsonl").write_bytes(output)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()

    def test_report_privacy_and_original_m1_invocation(self):
        private = OPTIONS.out / "FAKE_PRIVATE_PATH_SECRET_TITLE.m4a"
        command = [str(OPTIONS.prefix / "bin/ffmpeg"), "-v", "error", "-nostdin", "-y", "-i",
                   str(OPTIONS.fixtures / "aac.m4a"), "-c", "copy", "-metadata", "title=SECRET_TITLE",
                   "-metadata", "comment=https://example.invalid/SIGNED_SECRET?auth=AUTH_SECRET; cookie=COOKIE_SECRET; room=ROOM_SECRET", str(private)]
        env = dict(os.environ, LD_LIBRARY_PATH=str(OPTIONS.prefix / "lib"))
        env.pop("FFREPORT", None)
        made = subprocess.run(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        self.assertEqual(made.returncode, 0, "same-build synthetic privacy fixture creation")
        code, rows = self.run_pair("privacy", private)
        self.assertEqual(code, 0)
        text = json.dumps(rows)
        for secret in (str(OPTIONS.out), str(OPTIONS.prefix), "FAKE_PRIVATE_PATH", "SECRET_TITLE", "SIGNED_SECRET", "AUTH_SECRET", "COOKIE_SECRET", "ROOM_SECRET"):
            self.assertNotIn(secret, text)
        # Old two-argument invocation remains M1-only, even with a poison PATH
        # reference and explicit test env set. Its raw legacy JSON is not saved.
        prefix = OPTIONS.out / "default-canary"
        prefix.mkdir(exist_ok=True)
        marker = prefix / "called"
        tool = prefix / "ffprobe"
        tool.write_text('#!/bin/sh\ntouch "${0%/*}/called"\nexit 91\n')
        tool.chmod(0o700)
        env = dict(os.environ, PATH=str(prefix) + os.pathsep + os.environ.get("PATH", ""),
                   BILIKARA_LIBAV_FFMPEG_PREFIX=str(prefix))
        result = subprocess.run([str(OPTIONS.driver), str(OPTIONS.companion), str(OPTIONS.fixtures / "video.mp4")],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("primary", json.loads(result.stdout))
        self.assertFalse(marker.exists())


def main():
    global OPTIONS
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("driver", "companion", "prefix", "fixtures", "long-fixture", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    OPTIONS = parser.parse_args()
    for name in ("driver", "companion", "prefix", "fixtures", "long_fixture", "out"):
        path = getattr(OPTIONS, name)
        if not path.is_absolute():
            parser.error(name + " must be absolute")
        if name != "out" and not path.exists():
            parser.error(name + " is required; no skipped live acceptance")
    repo = Path(__file__).resolve().parent.parent
    if OPTIONS.out.resolve().is_relative_to(repo):
        parser.error("--out must be outside the repository")
    OPTIONS.out.mkdir(parents=True, exist_ok=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(LiveComparison)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    (OPTIONS.out / "live-results.json").write_text(json.dumps({"tests_run": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors), "skipped": len(result.skipped),
        "passed": result.wasSuccessful()}, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
