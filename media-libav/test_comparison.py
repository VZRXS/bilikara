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
import tempfile
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


class LivePacketScan(LiveComparison):
    """M3 extends the M2 suite/runner; inherited M2 assertions stay enabled."""

    def scan_pair(self, name, source, index=0, kind="audio", repeat=1, companion=None, extra=(), measured=False):
        command = [str(OPTIONS.driver), "compare", str(companion or OPTIONS.companion),
                   str(OPTIONS.prefix), str(source), name, "--scan-stream", str(index),
                   "--scan-kind", kind, "--repeat", str(repeat), *extra]
        if measured:
            # Existing Linux wait4 gives a representative high-water observation
            # without installing GNU time or adding application telemetry.
            report = OPTIONS.out / (name + ".jsonl")
            with report.open("wb") as output:
                process = subprocess.Popen(command, stdout=output, stderr=subprocess.DEVNULL)
                try:
                    deadline = time.monotonic() + 60
                    while True:
                        pid, status, usage = os.wait4(process.pid, os.WNOHANG)
                        if pid:
                            process.returncode = os.waitstatus_to_exitcode(status)
                            break
                        if time.monotonic() >= deadline:
                            self.fail("measured paired driver exceeded test timeout")
                        time.sleep(0.001)
                finally:
                    if process.returncode is None:
                        process.kill()
                        process.wait()
            (OPTIONS.out / "paired-maxrss-kib.txt").write_text(str(usage.ru_maxrss) + "\n")
            result = subprocess.CompletedProcess(command, process.returncode, report.read_bytes())
        else:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        self.assertLess(len(result.stdout), 64 * 1024 * repeat)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(rows)
        (OPTIONS.out / (name + ".jsonl")).write_bytes(result.stdout)
        for r in rows:
            self.assertEqual(r["operation"], "packet_scan")
            self.assertEqual(r["inspection"]["media_acceptance"], "not_requested")
            self.assertEqual(r["inspection"]["complete_media_validation"], "not_established")
            for secret in (str(OPTIONS.out), str(OPTIONS.prefix), "FAKE_PRIVATE_PATH", "SECRET_TITLE", "SIGNED_SECRET", "AUTH_SECRET", "COOKIE_SECRET", "ROOM_SECRET"):
                self.assertNotIn(secret, json.dumps(r))
        return result.returncode, rows

    def test_scan_real_corpus_and_long_end(self):
        cases = [
            ("scan-video", "video.mp4", 0, "video", 60),
            ("scan-aac", "aac.m4a", 0, "audio", 48),
            ("scan-mux-video", "av.mp4", 0, "video", 60),
            ("scan-mux-audio", "av.mp4", 1, "audio", 48),
            ("scan-raw-flac", "audio.flac", 0, "audio", 12),
            ("scan-flac-mp4", "flac.mp4", 0, "audio", 12),
            ("scan-unknown-duration", "unknown-duration.flac", 0, "audio", 12),
            ("scan-missing-mdat", "missing-mdat.m4a", 0, "audio", 48),
            ("scan-long", OPTIONS.long_fixture, 0, "audio", 3520),
        ]
        for name, filename, index, kind, count in cases:
            with self.subTest(fixture=name):
                source = filename if isinstance(filename, Path) else OPTIONS.fixtures / filename
                code, rows = self.scan_pair(name, source, index, kind, repeat=3, measured=name == "scan-long")
                self.assertEqual(code, 0)
                self.assertEqual(len(rows), 3)
                for r in rows:
                    self.assertEqual(r["scan_capability_schema"], 1)
                    self.assertEqual(r["same_build"], {"inventory": True, "operational": True})
                    for tool in ("libav", "ffprobe", "ffmpeg"):
                        self.assertEqual(r["identity"][tool]["version"], "9.0.1")
                    self.assertTrue(r["libav"]["clean_eof"])
                    self.assertEqual(r["libav"]["terminal"], "eof")
                    self.assertEqual(r["libav"]["selected"]["index"], index)
                    self.assertEqual(r["libav"]["selected"]["packet_count"], count)
                    self.assertEqual(r["ffprobe"]["streams"][0]["packet_count"], count)
                    self.assertEqual(r["primary"]["kinds"], ["matching_comparable_packet_scan"])
                    self.assertEqual(r["operational_comparison"]["kinds"], ["matching_comparable_packet_scan"])
                if "mux" in name:
                    self.assertEqual(rows[0]["libav"]["demuxed_packets"], 108)
                if name == "scan-long":
                    summary = rows[0]["libav"]["selected"]
                    self.assertGreater(summary["pts_ticks"]["max"] / 96000, 299)
                    memory = int((OPTIONS.out / "paired-maxrss-kib.txt").read_text().strip())
                    self.assertGreater(memory, 0)
                    (OPTIONS.out / "memory-and-timing.json").write_text(json.dumps({
                        "scope": "Linux wait4 ru_maxrss of the driver with sequential native scans and CLI references; not a native-only allocation or constant-RSS guarantee",
                        "max_rss_kib": memory, "fixture_filesystem_bytes": source.stat().st_size,
                        "selected_packet_count": count, "selected_payload_bytes": summary["payload_bytes"],
                        "elapsed_us": [r["elapsed_us"] for r in rows],
                    }, indent=2) + "\n")

    def test_scan_late_truncation_observed_limit(self):
        # Four seconds from the accepted long fixture, with moov before payload.
        # Only this small missing case is generated; original media is unchanged.
        small = OPTIONS.out / "four-seconds.mp4"
        command = [str(OPTIONS.prefix / "bin/ffmpeg"), "-nostdin", "-v", "error", "-y",
                   "-i", str(OPTIONS.long_fixture), "-t", "4", "-map", "0:0", "-c", "copy",
                   "-strict", "-2", "-movflags", "+faststart", str(small)]
        result = subprocess.run(command, env=dict(os.environ, LD_LIBRARY_PATH=str(OPTIONS.prefix / "lib")),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        self.assertEqual(result.returncode, 0)
        self.assertLess(small.stat().st_size, 4 * 1024 * 1024)
        late = OPTIONS.out / "late-truncated.mp4"
        with small.open("rb") as source:
            late.write_bytes(source.read(small.stat().st_size * 95 // 100))
        code, metadata = self.run_pair("late-metadata", late)
        self.assertEqual(code, 0)
        self.assertEqual(metadata[0]["libav"]["outcome"], "success")
        code, rows = self.scan_pair("scan-late-truncated", late)
        self.assertEqual(code, 1)
        r = rows[0]
        self.assertEqual(r["libav"]["terminal"], "eof")
        self.assertEqual(r["libav"]["outcome"], "invalid_media")
        self.assertFalse(r["libav"]["clean_eof"])
        self.assertEqual(r["libav"]["selected"]["packet_count"], 45)
        self.assertEqual(r["libav"]["selected"]["corrupt_packets"], 1)
        self.assertEqual(r["ffprobe"]["streams"][0]["packet_count"], 45)
        self.assertTrue(r["ffprobe"]["diagnostics_present"])
        self.assertEqual(r["ffprobe"]["outcome"], "success")
        self.assertEqual(r["ffmpeg"]["outcome"], "execution_error")
        self.assertNotIn("matching_comparable_packet_scan", r["primary"]["kinds"])

    def test_scan_lifecycle_capability_and_private_shim(self):
        env = {"BILIKARA_LIBAV_COMPANION": str(OPTIONS.companion),
               "BILIKARA_LIBAV_FIXTURES": str(OPTIONS.fixtures),
               "BILIKARA_M3_OLD_COMPANION": str(OPTIONS.old_companion)}
        for name in ("live_scan_lifecycle_and_selection", "live_old_companion_keeps_metadata_without_scan"):
            self.rust_test("experimental_libav::scan::tests::" + name, env, ignored=True)
        result = subprocess.run([str(OPTIONS.shim_test)], env=dict(os.environ,
            BILIKARA_M3_SHIM_INPUT=str(OPTIONS.fixtures / "aac.m4a")),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"real reads + injected", result.stdout)
        (OPTIONS.out / "shim-lifecycle.txt").write_bytes(result.stdout)
        code, rows = self.scan_pair("scan-old-companion", OPTIONS.fixtures / "aac.m4a", companion=OPTIONS.old_companion)
        self.assertEqual(code, 1)
        self.assertIsNone(rows[0]["scan_capability_schema"])
        self.assertEqual(rows[0]["libav"]["outcome"], "unavailable")
        self.assertFalse(rows[0]["libav"]["clean_eof"])

    def test_scan_invalid_selection_cancelled_and_malformed(self):
        for name, source, index, kind, extra, expected in [
            ("scan-no-index", "aac.m4a", 31, "audio", (), "invalid_request"),
            ("scan-wrong-kind", "aac.m4a", 0, "video", (), "invalid_request"),
            ("scan-precancelled", "aac.m4a", 0, "audio", ("--cancelled",), "cancelled"),
            ("scan-truncated-header", "truncated.mp4", 0, "audio", (), "invalid_media"),
        ]:
            code, rows = self.scan_pair(name, OPTIONS.fixtures / source, index, kind, extra=extra)
            self.assertEqual(code, 1)
            self.assertEqual(rows[0]["libav"]["outcome"], expected)
            self.assertFalse(rows[0]["libav"]["clean_eof"])
            self.assertEqual(rows[0]["libav"]["terminal"], "incomplete")

    def test_scan_small_accumulator_spot_check(self):
        # Intentionally tiny 48-packet fixture only, bounded pipe; no long dump.
        command = [str(OPTIONS.prefix / "bin/ffprobe"), "-v", "error", "-select_streams", "0",
                   "-show_packets", "-show_entries", "packet=stream_index,size,pts,dts", "-of", "json",
                   str(OPTIONS.fixtures / "aac.m4a")]
        process = subprocess.Popen(command, env=dict(os.environ, LD_LIBRARY_PATH=str(OPTIONS.prefix / "lib")),
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            data = process.stdout.read(32769)
            self.assertLessEqual(len(data), 32768)
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
        packets = json.loads(data)["packets"]
        self.assertEqual(len(packets), 48)
        _, rows = self.scan_pair("scan-spot-check", OPTIONS.fixtures / "aac.m4a")
        selected = rows[0]["libav"]["selected"]
        self.assertEqual(selected["payload_bytes"], sum(int(p["size"]) for p in packets))
        for field in ("pts", "dts"):
            values = [p[field] for p in packets if field in p]
            self.assertEqual(selected[field + "_ticks"], {"min": min(values), "max": max(values)})
        # Persist summary only, never the packet document.
        (OPTIONS.out / "accumulator-spot-check.json").write_text(json.dumps({
            "packet_count": len(packets), "payload_bytes": selected["payload_bytes"],
            "pts_ticks": selected["pts_ticks"], "dts_ticks": selected["dts_ticks"],
            "time_base": selected["time_base"], "compared": True,
        }, indent=2) + "\n")

    def test_report_privacy_and_original_m1_invocation(self):
        super().test_report_privacy_and_original_m1_invocation()
        code, _ = self.scan_pair("scan-privacy", OPTIONS.out / "FAKE_PRIVATE_PATH_SECRET_TITLE.m4a")
        self.assertEqual(code, 0)


class LiveCopyRemux(LivePacketScan):
    """M5 adds one explicit transform profile; inherited M1–M3 checks remain."""

    def remux_pair(self, label, source, kind="audio", extra=(), companion=None, keep=None):
        temporary = OPTIONS.out / "remux-temporary"
        temporary.mkdir(exist_ok=True)
        command = [str(OPTIONS.driver), "compare", str(companion or OPTIONS.companion),
                   str(OPTIONS.prefix), str(source), label, "--copy-remux", kind, *extra]
        if keep is not None:
            command += ["--keep-outputs", str(keep)]
        result = subprocess.run(command, env=dict(os.environ, TMPDIR=str(temporary)),
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        self.assertLess(len(result.stdout), 128 * 1024)
        row = json.loads(result.stdout)
        self.assertEqual(list(temporary.iterdir()), [], "default experiments must release owned outputs")
        for secret in (str(OPTIONS.out), str(OPTIONS.prefix), str(source), "SECRET_TITLE", "SIGNED_SECRET", "AUTH_SECRET", "COOKIE_SECRET", "ROOM_SECRET"):
            self.assertNotIn(secret, result.stdout.decode())
        self.assertEqual(row["operation"], "copy_remux")
        self.assertEqual(row["inspection"]["media_acceptance"], "not_requested")
        (OPTIONS.out / (label + ".json")).write_bytes(result.stdout)
        return result.returncode, row

    def test_remux_real_success_and_extended_configuration(self):
        summary = []
        with tempfile.TemporaryDirectory(prefix="m5-fixtures-", dir=OPTIONS.out) as directory:
            directory = Path(directory)
            extended = directory / "extended-aac.m4a"
            self.rust_test("media_backend::tests::export_extended_aac_fixture_for_m5", {
                "BILIKARA_M5_EXTENDED_FIXTURE": str(extended)}, ignored=True)
            positive = directory / "positive-start.m4a"
            reference = subprocess.run([str(OPTIONS.prefix / "bin/ffmpeg"), "-v", "error", "-nostdin",
                "-copyts", "-itsoffset", "1.234567", "-i", str(OPTIONS.fixtures / "aac.m4a"),
                "-map", "0:0", "-c", "copy", "-avoid_negative_ts", "disabled", "-use_editlist", "1", "-n", str(positive)],
                env=dict(os.environ, LD_LIBRARY_PATH=str(OPTIONS.prefix / "lib")),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            self.assertEqual(reference.returncode, 0)
            cases = [("h264", OPTIONS.fixtures / "video.mp4", "video", 60, 39),
                     ("aac", OPTIONS.fixtures / "aac.m4a", "audio", 48, 5),
                     ("extended-aac", extended, "audio", 4, 4),
                     ("fragmented", OPTIONS.fragmented_fixture, "audio", 88, 5),
                     ("positive-start", positive, "audio", 48, 5)]
            for label, source, kind, count, config_size in cases:
                with self.subTest(fixture=label):
                    original = source.read_bytes()
                    code, row = self.remux_pair("remux-" + label, source, kind)
                    self.assertEqual(code, 0, row.get("outcome"))
                    self.assertEqual(row["outcome"], "success")
                    self.assertTrue(row["same_build"])
                    native = row["companion"]["result"]
                    self.assertTrue(native["finalized_and_published"] and native["leading_moov"])
                    self.assertEqual(row["reference"]["layout"], {"leading_moov": True, "fragmented": False})
                    self.assertEqual(native["input"]["selected"]["packet_count"], count)
                    for check in row["content_comparison"].values():
                        self.assertTrue(check["matches"])
                        self.assertEqual(check["mismatches"], [])
                        self.assertEqual(check["configuration_bytes_left"], config_size)
                        self.assertEqual(check["configuration_bytes_right"], config_size)
                        self.assertEqual(check["packets_left"], count)
                        self.assertEqual(check["packets_right"], count)
                        self.assertEqual(check["max_rounding_us"], 0)
                    self.assertEqual(source.read_bytes(), original)
                    if label == "aac":
                        self.assertEqual(native["input"]["selected"]["dts_ticks"]["min"], -1024)
                    if label == "positive-start":
                        self.assertGreater(native["input"]["selected"]["dts_ticks"]["min"], 0)
                    if label == "extended-aac":
                        # Accepted fixture uses synthetic packets, not a full
                        # decoder sample. Retain observed decoder diagnostics.
                        self.assertTrue(row["reference"]["diagnostics_present"])
                        self.assertFalse(row["clean_reference_execution"])
                    else:
                        self.assertTrue(row["clean_reference_execution"])
                    summary.append({"fixture_label":row["fixture_label"],"outcome":row["outcome"],
                        "profile":row["profile"],"content_comparison":row["content_comparison"],
                        "clean_reference_execution":row["clean_reference_execution"],
                        "output_bytes":row["output_bytes"],"elapsed_us":row["elapsed_us"]})
        (OPTIONS.out / "copy-remux-summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    def test_remux_rejections_and_old_capability(self):
        for label, filename, kind, expected in [
            ("wrong-kind", "aac.m4a", "video", "media_contract_violation"),
            ("multi-stream", "av.mp4", "video", "media_contract_violation"),
            ("missing-mdat", "missing-mdat.m4a", "audio", "invalid_media"),
            ("truncated", "truncated.mp4", "audio", "invalid_media"),
            ("unsupported-codec", "flac.mp4", "audio", "unsupported_codec"),
            ("unsupported-format", "audio.flac", "audio", "unsupported_format")]:
            with self.subTest(fixture=label):
                code, row = self.remux_pair("remux-" + label, OPTIONS.fixtures / filename, kind)
                self.assertEqual(code, 1)
                self.assertEqual(row["outcome"], expected)
                self.assertFalse(row.get("companion", {}).get("published", False))
                self.assertNotIn("reference", row, "no CLI track selection after native contract failure")
        for label, companion, extra, expected in [
            ("old", OPTIONS.remux_old_companion, (), "unavailable"),
            ("missing", OPTIONS.out / "missing-remux.so", (), "unavailable"),
            ("cancelled", OPTIONS.companion, ("--cancelled",), "cancelled")]:
            code, row = self.remux_pair("remux-" + label, OPTIONS.fixtures / "aac.m4a", companion=companion, extra=extra)
            self.assertEqual(code, 1)
            self.assertEqual(row["outcome"], expected)

    def test_remux_real_publisher_and_fault_lifecycle(self):
        env = {"BILIKARA_LIBAV_COMPANION":str(OPTIONS.companion),
               "BILIKARA_LIBAV_FIXTURES":str(OPTIONS.fixtures),
               "BILIKARA_M5_FAULT_COMPANION":str(OPTIONS.fault_companion),
               "BILIKARA_M5_OLD_COMPANION":str(OPTIONS.remux_old_companion)}
        for name in ("live_publication_cancellation_and_late_errors", "live_old_companion_does_not_remux"):
            self.rust_test("experimental_libav::remux::tests::" + name, env, ignored=True)

    def test_remux_explicit_keep_and_privacy(self):
        with tempfile.TemporaryDirectory(prefix="m5-keep-", dir=OPTIONS.out) as directory:
            keep = Path(directory) / "outputs"
            code, row = self.remux_pair("remux-kept", OPTIONS.fixtures / "aac.m4a", keep=keep)
            self.assertEqual(code, 0)
            self.assertTrue(row["outputs_retained"])
            self.assertEqual(sorted(p.name for p in keep.iterdir()), ["companion.mp4", "reference.mp4"])
            self.assertNotEqual((keep / "companion.mp4").stat().st_ino, (keep / "reference.mp4").stat().st_ino)

    def test_report_privacy_and_original_m1_invocation(self):
        super().test_report_privacy_and_original_m1_invocation()
        code, _ = self.remux_pair("remux-privacy", OPTIONS.out / "FAKE_PRIVATE_PATH_SECRET_TITLE.m4a")
        self.assertEqual(code, 0)


def main():
    global OPTIONS
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("driver", "companion", "prefix", "fixtures", "long-fixture", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--packet-scan", action="store_true", help="M3 live suite including inherited M2 tests")
    parser.add_argument("--old-companion", type=Path)
    parser.add_argument("--shim-test", type=Path)
    parser.add_argument("--copy-remux", action="store_true", help="M5 suite including inherited M1–M3 tests")
    parser.add_argument("--remux-old-companion", type=Path)
    parser.add_argument("--fault-companion", type=Path)
    parser.add_argument("--fragmented-fixture", type=Path)
    OPTIONS = parser.parse_args()
    if OPTIONS.copy_remux:
        OPTIONS.packet_scan = True
        for name in ("remux_old_companion", "fault_companion", "fragmented_fixture"):
            path = getattr(OPTIONS, name)
            if path is None or not path.is_absolute() or not path.is_file():
                parser.error(name + " required for M5; no skipped live acceptance")
    if OPTIONS.packet_scan:
        for name in ("old_companion", "shim_test"):
            path = getattr(OPTIONS, name)
            if path is None or not path.is_absolute() or not path.is_file():
                parser.error(name + " required for M3; no skipped live acceptance")
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
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(LiveCopyRemux if OPTIONS.copy_remux else LivePacketScan if OPTIONS.packet_scan else LiveComparison)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    (OPTIONS.out / "live-results.json").write_text(json.dumps({"tests_run": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors), "skipped": len(result.skipped),
        "passed": result.wasSuccessful()}, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
