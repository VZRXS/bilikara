"""Explicit companion build. No pkg-config or system FFmpeg discovery."""
import argparse
import ctypes
import json
import os
import platform
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
    if sys.platform not in {"linux", "darwin", "win32"} or not args.prefix.is_absolute() or not args.out.is_absolute():
        parser.error("Linux/macOS/Windows and absolute prefix/output paths are required")
    prefix = args.prefix.resolve(strict=True)
    out = args.out.resolve()
    source = Path(__file__).resolve().parent
    # Read the selected shared libraries directly: building the companion must
    # not require ffprobe or any other FFmpeg program.
    directory = prefix / ("bin" if sys.platform == "win32" else "lib")
    dll_directory = os.add_dll_directory(str(directory)) if sys.platform == "win32" else None
    libraries = {}
    try:
        for name in ("avutil", "avcodec", "avformat"):
            pattern = f"{name}-*.dll" if sys.platform == "win32" else (
                f"lib{name}.*.dylib" if sys.platform == "darwin" else f"lib{name}.so.*")
            candidates = {path.resolve() for path in directory.glob(pattern)}
            if len(candidates) != 1:
                parser.error(f"Expected one selected {name} library")
            library = ctypes.CDLL(str(candidates.pop()))
            getattr(library, name + "_version").restype = ctypes.c_uint
            libraries[name] = library
        libraries["avutil"].av_version_info.restype = ctypes.c_char_p
        libraries["avformat"].avformat_configuration.restype = ctypes.c_char_p
        facts = {
            "program_version": {
                "version": libraries["avutil"].av_version_info().decode(),
                "configuration": libraries["avformat"].avformat_configuration().decode(),
            },
            "library_versions": [{"name": "lib" + name, "version": getattr(library, name + "_version")()}
                                 for name, library in libraries.items()],
        }
    finally:
        if dll_directory is not None:
            dll_directory.close()
    program = facts["program_version"]
    expected = {"libavformat": 4129125, "libavcodec": 4129125, "libavutil": 3998053}
    actual = {v["name"]: v["version"] for v in facts["library_versions"]}
    if program["version"] != "9.0.1" or any(actual.get(k) != v for k, v in expected.items()):
        parser.error("this companion requires the selected FFmpeg 9.0.1 build")
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
    library = "libbilikara_media_libav.so"
    if sys.platform == "darwin":
        library = "libbilikara_media_libav.dylib"
        command = [v for v in command if not v.startswith("-Wl,")]
        command[command.index("-shared")] = "-dynamiclib"
        command[command.index(str(out / "libbilikara_media_libav.so"))] = str(out / library)
        command += ["-Wl,-rpath," + str(prefix / "lib"), "-Wl,-headerpad_max_install_names"]
    if sys.platform == "win32":
        if args.sanitize:
            parser.error("Windows companion build does not enable sanitizers")
        command = ["cl.exe", "/nologo", "/std:c11", "/O2", "/MD", "/W3", "/we4013",
                   "/D_CRT_SECURE_NO_WARNINGS", "/D_CRT_NONSTDC_NO_WARNINGS", "/LD",
                   "/I" + str(prefix / "include"), "/I" + str(out), str(source / "probe.c"),
                   "/Fo" + str(out) + os.sep, "/link", "/MACHINE:" + ("ARM64" if platform.machine().lower() in {"arm64", "aarch64"} else "X64"),
                   "/LIBPATH:" + str(prefix / "bin"), "/LIBPATH:" + str(prefix / "lib"),
                   "avformat.lib", "avcodec.lib", "avutil.lib", "kernel32.lib",
                   "/OUT:" + str(out / "bilikara_media_libav.dll")]
        subprocess.run(command, check=True)
        if args.test:
            test_command = [v for v in command if v != "/LD"]
            test_command[test_command.index(str(source / "probe.c"))] = str(source / "test_shim.c")
            test_command[-1] = "/OUT:" + str(out / "test_shim.exe")
            subprocess.run(test_command, check=True)
            subprocess.run([str(out / "test_shim.exe")], check=True)
            private_command = list(command)
            private_command[private_command.index(str(source / "probe.c"))] = str(source / "test_shim.c")
            private_command[-1] = "/OUT:" + str(out / "bilikara_media_libav_test.dll")
            subprocess.run(private_command, check=True)
        (out / "build-info.json").write_text(json.dumps(facts, indent=2) + "\n", encoding="utf-8")
        return
    if args.sanitize:
        command += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
    subprocess.run(command, check=True)
    if args.test:
        test_command = [v for v in command if v not in {"-shared", "-dynamiclib"}]
        test_command[test_command.index(str(source / "probe.c"))] = str(source / "test_shim.c")
        test_command[test_command.index(str(out / library))] = str(out / "test_shim")
        subprocess.run(test_command, check=True)
        subprocess.run([str(out / "test_shim")], check=True)
        # Private fault-injection companion for testing the real Rust staging /
        # publisher around native late failures. Never loaded by normal calls.
        private_command = list(command)
        private_command[private_command.index(str(source / "probe.c"))] = str(source / "test_shim.c")
        private_command[private_command.index(str(out / library))] = str(out / library.replace("libav.", "libav_test."))
        subprocess.run(private_command, check=True)
    (out / "build-info.json").write_text(json.dumps(facts, indent=2) + "\n")
    print(out / library)


if __name__ == "__main__":
    main()
