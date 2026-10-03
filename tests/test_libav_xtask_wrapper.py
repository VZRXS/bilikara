"""Exercise the real libav shell helper; Cargo is only a recording command here."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("bash"), "Requires the Bash used by libav recipes")
class LibavXtaskWrapperTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="libav wrapper 中文 ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "external FFmpeg source 中文"
        self.source.mkdir()
        (self.source / "ffbuild").mkdir()
        (self.source / "ffbuild/config.log").write_bytes(b"configure log from the extracted source\n")
        self.stub = self.root / "recording tools 中文"
        self.stub.mkdir()
        cargo = self.stub / "cargo"
        cargo.write_text(
            '#!/usr/bin/env bash\n'
            'printf "%s\\0" "$PWD" "${RUSTUP_TOOLCHAIN-}" "$@"\n'
            'printf "%s\\n" "recorded Cargo diagnostic" >&2\n'
            'exit "$CARGO_RECORD_EXIT"\n', encoding="utf-8", newline="\n")
        cargo.chmod(0o755)
        self.kit = self.root / "independent source kit 中文 ; $()"
        (self.kit / "media-libav").mkdir(parents=True)
        (self.kit / "xtask").mkdir()
        shutil.copy2(ROOT / "media-libav/xtask.sh", self.kit / "media-libav/xtask.sh")
        shutil.copy2(ROOT / "rust-toolchain.toml", self.kit / "rust-toolchain.toml")
        (self.kit / "xtask/Cargo.toml").write_text("# independent kit fixture\n", encoding="utf-8")
        self.arguments = ["libav-cache", "snapshot", "prefix 空格 ; $(touch evaluated)",
                          "cache ' & $USER 中文\nsecond line"]

    def invoke(self, repo, helper, code=0, with_trap=False):
        # cd/pwd normalizes the fixture paths for native MSYS Bash too. The
        # function itself is sourced unchanged, with the same repo variable
        # supplied by the production wrappers. No eval or shell-string args.
        script = '''
set -u
repo="$1"; helper="$2"; source_dir="$3"; stub_dir="$4"
shift 4
if [ -d "$repo" ]; then repo="$(cd "$repo" && pwd)"; fi
stub_dir="$(cd "$stub_dir" && pwd)"
export PATH="$stub_dir:$PATH"
source "$helper"
cd "$source_dir" || exit
if [ -n "${LIBAV_WRAPPER_TRAP_LOG-}" ]; then
  trap 'cat ffbuild/config.log > "$LIBAV_WRAPPER_TRAP_LOG"' EXIT
fi
printf '%s\\0' "$repo" "$PWD"
if bilikara_xtask "$@"; then status=0; else status=$?; fi
printf '%s\\0' "$PWD" "$status"
exit "$status"
'''
        return subprocess.run(
            [shutil.which("bash"), "--noprofile", "--norc", "-c", script, "libav wrapper test",
             repo.as_posix(), helper.as_posix(), self.source.as_posix(), self.stub.as_posix(),
             *self.arguments],
            cwd=self.source, env=dict(os.environ, CARGO_RECORD_EXIT=str(code),
                                     RUSTUP_TOOLCHAIN="explicit-user-override",
                                     LIBAV_WRAPPER_TRAP_LOG=(self.root / "saved config.log").as_posix() if with_trap else ""),
            capture_output=True, timeout=20)

    def assert_record(self, result, code):
        self.assertEqual(result.returncode, code, result.stderr.decode("utf-8"))
        fields = result.stdout.decode("utf-8").split("\0")
        self.assertEqual(fields[-1], "")
        fields.pop()
        root, caller = fields[:2]
        self.assertEqual(fields[2:], [root, "explicit-user-override", "run", "--manifest-path",
                                     root + "/xtask/Cargo.toml", "--locked", "--target", "host-tuple",
                                     "--", *self.arguments, caller, str(code)])
        self.assertEqual(result.stderr, b"recorded Cargo diagnostic\n")
        self.assertFalse((self.source / "evaluated").exists())

    def test_repository_child_uses_root_and_restores_caller(self):
        self.assert_record(self.invoke(ROOT, ROOT / "media-libav/xtask.sh"), 0)

    def test_independent_source_kit_uses_its_own_root(self):
        self.assert_record(self.invoke(self.kit, self.kit / "media-libav/xtask.sh"), 0)
        self.assertFalse((self.kit / "rust-runtime").exists())

    def test_failure_propagates_and_caller_directory_is_preserved(self):
        for repo in (ROOT, self.kit):
            with self.subTest(repo=repo):
                self.assert_record(self.invoke(repo, repo / "media-libav/xtask.sh", 29), 29)

    def test_missing_root_fails_before_cargo_without_changing_caller(self):
        result = self.invoke(self.root / "missing root", ROOT / "media-libav/xtask.sh")
        self.assertNotEqual(result.returncode, 0)
        fields = result.stdout.decode("utf-8").split("\0")
        self.assertEqual(len(fields), 5)
        self.assertEqual(fields[1], fields[2])
        self.assertEqual(fields[3], str(result.returncode))
        self.assertNotIn(b"recorded Cargo diagnostic", result.stderr)

    def test_configure_log_exit_trap_keeps_source_directory(self):
        result = self.invoke(self.kit, self.kit / "media-libav/xtask.sh", with_trap=True)
        self.assert_record(result, 0)
        self.assertEqual((self.root / "saved config.log").read_bytes(),
                         (self.source / "ffbuild/config.log").read_bytes())


if __name__ == "__main__":
    unittest.main()
