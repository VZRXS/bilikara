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

CI tests use `ubuntu-latest`, `windows-latest` and `macos-latest`. Distributed
bundles cover Windows and macOS x64/ARM64 only; Linux remains available for
source builds. Branch artifacts and their ZIP archives end with the sanitized
branch name (for example, `bilikara-windows-x64-work-v0.8.0.zip`). Tagged archives
retain the `bilikara-v0.8.0-windows-x64.zip` format.
Application ZIPs are uploaded directly with `archive: false`, without an outer
artifact ZIP. The platform test jobs own native-media behavioral validation;
bundle jobs build, stage, structurally verify, sign, archive and upload only.
They do not publish separate diagnostics artifacts.

Every bundle includes source and license records. Build-only native test drivers,
the fault-injection companion, smoke launchers and smoke result files are never
staged into the application bundle. POSIX dependencies use
`$ORIGIN` or `@loader_path`; macOS signing runs after final native-file staging.
The mandatory Rust libraries do not link to libav at process startup.

CI extracts each archive into a new path containing spaces and Unicode and
performs structural, architecture and signing checks. Native-media tests cover
default and legacy routing, CLI restoration, same-build comparisons, native
cache routing, cancellation and publication collisions before bundle
publication. The source-tree diagnostic drivers and fault companion remain
test-only and are never loaded by normal application calls.

Automated synthetic checks do not establish manual device playback or real
Hi-Res acceptance. Those checks retain their separately recorded status.
