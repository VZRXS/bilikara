"""Explicit Linux companion build. No pkg-config or system FFmpeg discovery."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--sanitize", action="store_true", help="ASan/UBSan companion for local tests")
    parser.add_argument("--test", action="store_true", help="also run the focused C shim assertions")
    args = parser.parse_args()
    if sys.platform != "linux" or not args.prefix.is_absolute() or not args.out.is_absolute():
        parser.error("Linux and absolute prefix/output paths are required")
    prefix = args.prefix.resolve(strict=True)
    out = args.out.resolve()
    source = Path(__file__).resolve().parent
    env = dict(os.environ, LD_LIBRARY_PATH=str(prefix / "lib"))
    facts = json.loads(subprocess.check_output([
        str(prefix / "bin/ffprobe"), "-v", "quiet", "-show_program_version",
        "-show_library_versions", "-of", "json",
    ], env=env))
    program = facts["program_version"]
    expected = {"libavformat": 4129125, "libavcodec": 4129125, "libavutil": 3998053}
    actual = {v["name"]: v["version"] for v in facts["library_versions"]}
    if program["version"] != "9.0.1" or any(actual.get(k) != v for k, v in expected.items()):
        parser.error("this preview requires the selected FFmpeg 9.0.1 build")
    config = program["configuration"]
    if "--disable-network" not in config.split() or "--enable-shared" not in config.split():
        parser.error("selected build must disable network and enable shared libraries")
    if len(config.encode()) > 2048:
        parser.error("configuration exceeds ABI bound")
    out.mkdir(parents=True, exist_ok=True)
    (out / "build_config.h").write_text("#define BM_BUILD_CONFIG " + json.dumps(config) + "\n")
    # DT_RPATH is intentional: the libavcodec -> libswresample dependency has
    # no RUNPATH of its own. A transitive private prefix avoids system mixing.
    command = [os.environ.get("CC", "cc"), "-std=c11", "-O2", "-g", "-Wall", "-Wextra", "-Werror",
               "-fPIC", "-fvisibility=hidden", "-shared", "-I" + str(prefix / "include"),
               "-I" + str(out), str(source / "probe.c"), "-L" + str(prefix / "lib"),
               "-Wl,--disable-new-dtags,-rpath," + str(prefix / "lib"), "-Wl,-z,defs",
               "-lavformat", "-lavcodec", "-lavutil", "-o", str(out / "libbilikara_media_libav.so")]
    if args.sanitize:
        command += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
    subprocess.run(command, check=True)
    if args.test:
        test_command = [v for v in command if v != "-shared"]
        test_command[test_command.index(str(source / "probe.c"))] = str(source / "test_shim.c")
        test_command[test_command.index(str(out / "libbilikara_media_libav.so"))] = str(out / "test_shim")
        subprocess.run(test_command, check=True)
        subprocess.run([str(out / "test_shim")], check=True)
    (out / "build-info.json").write_text(json.dumps(facts, indent=2) + "\n")
    print(out / "libbilikara_media_libav.so")


if __name__ == "__main__":
    main()
