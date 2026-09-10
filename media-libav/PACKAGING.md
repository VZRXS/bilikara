# Native libav packages

Windows, macOS and Linux x64/ARM64 bundles use FFmpeg 9.0.1 and the companion
built from the same signed source on a native runner. The normal media route
negotiates libav at the operation boundary. FFmpeg/ffprobe CLI compatibility
and `BILIKARA_MEDIA_BACKEND=legacy` remain available.

Set an absolute `BILIKARA_LIBAV_PREFIX`, then run `build-posix.sh` or, in the
native MSVC environment, `build-windows.sh` and `prepare-windows.ps1`.
`build_bundle.py` requires that complete prefix, including source, license,
build records, native drivers and the verified private dependency closure.
Windows requires the shared MSVC CRT; MSYS2 supplies build tools only.

Every bundle includes source and license records. POSIX dependencies use
`$ORIGIN` or `@loader_path`; macOS signing runs after final native-file staging.
The mandatory Rust libraries do not link to libav at process startup.

CI extracts each archive into a new path containing spaces and Unicode and
executes the packaged backend with isolated synthetic state. Diagnostics cover
default and legacy routing, CLI restoration, same-build comparisons, native
cache routing, cancellation and publication collisions. The diagnostic test
binary and fault companion are never loaded by normal application calls.
Windows uses `libav-smoke.ps1`; POSIX uses `--tool-smoke libav-package` with
`BILIKARA_LIBAV_SMOKE_RESULT` pointing to a writable result file.

Automated synthetic checks do not establish manual device playback or real
Hi-Res acceptance. Those checks retain their separately recorded status.
