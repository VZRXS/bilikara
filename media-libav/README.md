# M1 optional libav metadata probe (Linux preview)

`bilikara_runtime::experimental_libav::LibavMetadataProbe` is a developer-only
Rust entry. The only opt-in is explicitly calling `unsafe load(absolute_path)`
on a trusted companion, then `probe_metadata(absolute_input_path, &AtomicBool)`.
The example exercises this exact entry. No normal application request calls it.
No Python ABI, cache route, retry policy, publication rule or player changes.
There is no fallback and no ffprobe subprocess in the M1 probe implementation.

M2 extends this same example with an explicitly invoked developer `compare`
subcommand. See [COMPARISON.md](COMPARISON.md) for the paired runner, semantic
field contract, privacy rules and live acceptance command. The two-argument M1
invocation below keeps its original behavior.

M3 adds explicit selected-stream packet enumeration and both same-build reference
roles to that driver. See [PACKET_SCAN.md](PACKET_SCAN.md) for its contract and
executable live suite. M1 metadata ABI and behavior remain available.

M5's first transform profile adds only explicit single-stream MP4 copy-remux.
See [COPY_REMUX.md](COPY_REMUX.md) for staging ownership, timestamp policy,
bounded encoded-content comparison and the runnable regression command.

## Build and reproduce

Run from the repository root. At the user's request this M1 now pins **9.0.1**,
the [latest stable release checked on 2026-09-08](https://ffmpeg.org/download.html).
It does not follow a moving development snapshot. A fresh same-source CLI and
shared-library build is installed in the separate prefix below. The previous
8.1.2 M0 prefix and `.tmp/m1-libav/` acceptance evidence are preserved.

```bash
M1_OUT="$PWD/.tmp/m1-libav-9"
M1_PREFIX="$M1_OUT/ffmpeg-prefix"
python media-libav/build.py --prefix "$M1_PREFIX" --out "$M1_OUT/companion" --test
python media-libav/generate_fixtures.py --prefix "$M1_PREFIX" \
  --h264-source /tmp/bilikara_media_native_research_20260901_ijcpsG/fixtures/synthetic_video.mp4 \
  --out "$M1_OUT/fixtures"
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
cargo run --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata -- \
  "$M1_OUT/companion/libbilikara_media_libav.so" "$M1_OUT/fixtures/av.mp4"
```

`build.py` uses only the explicit prefix, no pkg-config. It builds one C shared
companion with a private shim, outside every Cargo build graph. No new Cargo
dependency or lockfile entry is needed: the Linux loader uses existing `libc`.
The fixture generator creates a small PCM WAV, uses the same-build CLI for
AAC/FLAC encoding and remuxing, and stream-copies a one-second portion of the
existing synthetic M0 H.264 source (this preview has no H.264 encoder or lavfi
input device). Generated media and binaries stay in ignored `.tmp/`.

Selected configuration (same flags as M0, with a separate prefix):

```text
--prefix=/sunhonglin/bilikara/.tmp/m1-libav-9/ffmpeg-prefix --disable-autodetect --disable-debug --disable-doc --disable-ffplay --disable-static --enable-shared --disable-x86asm --disable-avdevice --disable-swscale --enable-swresample --disable-network
```

The [official 9.0.1 archive](https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz) and
its detached signature are retained in `.tmp/m1-libav-9/`. GPG verification used
a private local keyring and the official release key fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8`; `signature.log` records `VALIDSIG`.
The signed source and installed/runtime libraries report `63.1.101` for
format/codec and `61.1.101` for util. These actual micro versions take precedence
over the download page's `*.1.100` summary. The build retains LGPL 2.1-or-later
configuration and does not change upstream licensing/integrity checks.

To rebuild the selected prefix from the already verified extracted source:

```bash
cd "$M1_OUT/source/ffmpeg-9.0.1"
./configure --prefix="$M1_PREFIX" --disable-autodetect --disable-debug \
  --disable-doc --disable-ffplay --disable-static --enable-shared \
  --disable-x86asm --disable-avdevice --disable-swscale --enable-swresample \
  --disable-network
make -j8
make install
cd /sunhonglin/bilikara
```

This is a local preview recipe, not a production packaging recipe. The selected
source, headers, CLI and companion dependencies all belong to this one build.

## Operation and ownership contract

- Depth is `stream_metadata`: `avformat_open_input` plus
  `avformat_find_stream_info` can read packets and do limited decoding. It is
  neither header-only I/O nor a complete scan/decode/integrity check. Enumerating
  multiple streams never selects tracks or satisfies a single-track contract.
- Rust opens an authorized absolute path read-only with `O_NONBLOCK`, then
  checks the opened descriptor is a regular file. URLs, relative paths, devices,
  directories and FIFOs are rejected. The C shim uses libav's existing `fd`
  protocol, which duplicates that descriptor; there is no custom read/seek I/O.
- Only the MOV/MP4 and raw FLAC demuxers can be opened. Detection of another
  demuxer reports `UnsupportedFormat`, without certifying validity. Unknown
  bytes remain an error. The fd deliberately provides no extension/MIME hint:
  the pinned HLS detector consequently rejects the network playlist fixture as
  `InvalidMedia`. No playlist is opened. MOV `enable_drefs=0` and
  `use_absolute_path=0` are pinned; `io_open` rejects every subordinate opening,
  even another local file. `--disable-network` is also checked at negotiation.
- Discovery limits: format probe 64 KiB, `probesize` 1 MiB,
  `analyzeduration` 1,000,000 media microseconds, `max_probe_packets` 256,
  `max_streams` 32, and `skip_estimate_duration_from_pts=1`. These are discovery
  controls, **not hard bounds on elapsed time, memory or total file reads**.
  No project code materializes the complete input or packet/sample inventory.
- Unknown facts are `None`/JSON `null`. Known times use microseconds. Stream
  ticks are converted using checked `i128` arithmetic, nearest microsecond
  (ties away from zero); negative starts are preserved. `AV_NOPTS_VALUE` never
  becomes a real timestamp. Raw bit depth and bitrate are populated only when
  libav reports them. Codec identifiers are names; no FFmpeg enum, arbitrary
  tags, title, packet count or sample count appears in the result.
- ABI v1 has four symbols in `probe.h`: `bm_abi_version`, `bm_get_info`,
  `bm_probe_metadata`, `bm_release`. It uses fixed-width project structs,
  bounded UTF-8 byte arrays with lengths, and one bounded aggregate result.
  The **allocating module frees its own allocations**. Rust copies results,
  then its guard calls the companion release on success, error or conversion
  failure; the guard borrows the adapter, keeping its library live. C closes AV
  contexts, options and the duplicated fd on every path, including before
  `open_input`. Borrowed AV fields never outlive the format context.
- Cancellation uses a request-local `AVIOInterruptCB` and Rust atomic flag.
  The context lives until the synchronous call returns. Rust and C both check
  before discovery; there is also a callback observation after open. Tests
  deterministically set the flag on the second C callback observation, after
  context allocation during libav I/O. This is callback-path evidence, not a
  guarantee that every CPU section is interruptible. The callback performs
  only non-panicking atomics. No global logging callback is installed.
- Library handles have ordinary scoped lifetimes; there is no hot-reload
  facility or background scheduler. Trusting a native library is an unsafe
  caller precondition. Optional loading offers no native crash containment.

`Unavailable` is separate from operation errors (missing library/dependency,
incompatible ABI/layout/version/configuration, or unimplemented platform).
Relevant existing `MediaErrorKind` values are reused through `ProbeError::Media`:
`InvalidRequest`, `SourceMissing`, `UnsupportedCodec`, `MediaContractViolation`,
`InvalidMedia`, `Io`. `Cancelled`, `UnsupportedFormat`, and `BackendFailure`
stay local to this experimental API. Pinned `AVERROR_INVALIDDATA`/EOF map to
invalid media, known I/O errno values to I/O, and decoder-not-found to a codec
capability limit. EINVAL, ENOMEM, unexplained EXIT and other unknown negatives
remain backend failures. No error here triggers retry or backend fallback.
S3's existing, independent bounded re-download policy is unchanged.

## Compatibility and dependency proof

Negotiation checks project ABI and struct sizes, exact header/runtime versions
(`avformat 63.1.101`, `avcodec 63.1.101`, `avutil 61.1.101`), source version
and actual runtime configurations of all three libraries before AV struct
access. The shim repeats its compatibility check at probe entry. Build
configuration is obtained from the same-prefix CLI, then compared with loaded
library functions, not merely echoed back. This is trusted-artifact
compatibility checking, not a malicious-library sandbox.

The companion uses Linux **DT_RPATH**, intentionally transitive because these
libraries do not have individual RUNPATHs. Actual `ldd` resolves the three
libav libraries and indirect `libswresample.so.7` to `$M1_PREFIX/lib`; other
dependencies are the system loader, libc and libm. The reference CLI is invoked with
child-process-only `LD_LIBRARY_PATH`; no global loader environment is changed.

```bash
readelf -d "$M1_OUT/companion/libbilikara_media_libav.so"
ldd "$M1_OUT/companion/libbilikara_media_libav.so"
readelf -d rust-runtime/target/release/libbilikara_runtime.so
ldd rust-runtime/target/release/libbilikara_runtime.so
```

Mandatory runtime has no companion/libav dependency. The live suite also starts
a fresh process and initializes AppState, snapshots it and probes H.264 using
the existing backend with the companion absent; `/proc/self/maps` contains no
companion or libavformat. Windows/macOS loading returns `Unavailable` in M1;
native loading, packaging, signing and device playback are unverified there.

## Explicit acceptance tests

Default runtime tests need no companion, headers, pkg-config or C compiler.
The **five** live tests are explicitly ignored by default, and each requires
its real artifact; the acceptance invocation executes them with **zero skips**:

```bash
BILIKARA_LIBAV_COMPANION="$M1_OUT/companion/libbilikara_media_libav.so" \
BILIKARA_LIBAV_FIXTURES="$M1_OUT/fixtures" \
BILIKARA_LIBAV_FFMPEG_PREFIX="$M1_PREFIX" \
BILIKARA_LIBAV_EXAMPLE="$PWD/rust-runtime/target/debug/examples/libav_metadata" \
cargo test --manifest-path rust-runtime/Cargo.toml --locked --lib \
  experimental_libav::tests::live_ -- --ignored --test-threads=1 --nocapture
```

Coverage: six same-build ffprobe metadata comparisons, unknown duration,
multi-stream enumeration, path/playlist/device restrictions, malformed and
truncated headers, pre-cancel and deterministic in-call cancel, 100 repetitions
each of success/error/cancel (including descriptor checks), and S3 operation
separation. Controlled child processes test missing dependency/symbol/companion,
wrong ABI/build and interposed actual runtime version/configuration failures;
fake artifacts never provide success-path evidence. Six ordinary Rust tests
cover conversion, output validation, taxonomy, negotiation and AppState
isolation. The C `--test` command executes four assertion groups.

Reference ffprobe uses `-show_streams -show_format`, the same discovery limits,
no `-count_packets` or decode/scan mode. Assertions compare format, index,
codec, dimensions, time base, rate/channels, raw depth, duration and start time.
Time tolerance is 1 microsecond for textual rounding; absent values must agree.
On the missing-mdat fixture, metadata succeeds at this limited depth while
the existing normalization returns `InvalidMedia` and creates no destination.

Sanitizer reproduction (GCC ASan/UBSan, Linux; test binary path is printed by
`cargo test --no-run --manifest-path rust-runtime/Cargo.toml --locked --lib`):

```bash
python media-libav/build.py --prefix "$M1_PREFIX" --out "$M1_OUT/asan" --sanitize --test
# Substitute the lib test executable printed by Cargo for M1_TEST_BINARY.
LD_PRELOAD=/usr/lib/gcc/x86_64-linux-gnu/11/libasan.so \
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
BILIKARA_LIBAV_COMPANION="$M1_OUT/asan/libbilikara_media_libav.so" \
BILIKARA_LIBAV_FIXTURES="$M1_OUT/fixtures" \
"$M1_TEST_BINARY" --exact experimental_libav::tests::live_cancellation_and_repeated_cleanup \
  --ignored --nocapture
```

This instruments the shim and intercepts allocations; the selected FFmpeg
libraries and Rust are not sanitizer-instrumented. It does not prove absence
of every native-library memory error, damaged-tail detection, or full decoding.

Primary API context: [FFmpeg demuxing documentation](https://ffmpeg.org/doxygen/8.0/group__lavf__decoding.html).
The ABI authority for this slice is the **installed 9.0.1 headers**, especially
`libavformat/avformat.h`, `libavformat/avio.h`, `libavcodec/codec_par.h`,
`libavutil/error.h`, plus same-source `libavformat/file.c` (`fd_open`),
`demux.c`, `mov.c` and `options_table.h`. Online docs are not an ABI pin.

## Local review evidence (2026-09-08)

Baseline: `work/v0.8.0`, accepted S3 HEAD `0dfec42`, following S2 `62ffc4c`
and S1 `7049e67`. Local history is three commits ahead of the recorded origin
branch. No fetch, checkout or history operation was performed. The pre-existing
untracked `S1_NATIVE_RECACHE_REVISION4.patch` and
`S1_NATIVE_RECACHE_REVISION5.patch` were preserved. No accepted implementation
file was edited except the additive module declaration in `lib.rs`.

Complete M1 file list (one modified, ten new):

- Modified: `rust-runtime/src/lib.rs`.
- New: `rust-runtime/src/experimental_libav/mod.rs`,
  `rust-runtime/src/experimental_libav/wire.rs`,
  `rust-runtime/src/experimental_libav/tests.rs`,
  `rust-runtime/examples/libav_metadata.rs`.
- New: `media-libav/probe.h`, `media-libav/probe.c`, `media-libav/build.py`,
  `media-libav/generate_fixtures.py`, `media-libav/test_shim.c`,
  `media-libav/README.md`.

Architecture: Rust runtime adapter owns explicit loading, request validation,
cancellation and project result conversion; C owns libav execution/resources.
Python additions are developer build/fixture orchestration only, with no
application business rules, endpoints, fallbacks or mutable state authority.

The following gate is rerun for the 9.0.1 upgrade; the earlier 8.1.2 gate remains
preserved separately. Commands and results (all exit 0):

| Working directory | Exact commands | Result |
| --- | --- | --- |
| `rust/` | `cargo fmt --check`; `cargo clippy --all-targets --locked -- -D warnings`; `cargo test --locked`; `cargo build --release --locked` | PASS; 216 unit tests, 0 doc tests |
| `rust-runtime/` | `cargo fmt --check`; `cargo clippy --all-targets --locked -- -D warnings`; `cargo test --locked`; `cargo build --release --locked` | PASS; 141 unit tests, 5 optional tests ignored here, 0 doc tests |
| `src-tauri/` | `cargo fmt --check`; `cargo clippy --all-targets --locked -- -D warnings`; `cargo test --locked`; `cargo build --release --locked` | PASS; 76 tests |
| Root | `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -v` | PASS; 1509 discovered, 1501 passed, 8 skipped below |
| Root | `python -m compileall -q bilikara`; `python -m py_compile start_bilikara.py build_bundle.py` | PASS |
| Root | `npm ci`; `npm run build` | PASS; local Linux build/bundles only |
| Root | `git diff --check`; `python -m py_compile media-libav/build.py media-libav/generate_fixtures.py` | PASS |

The explicit commands above additionally passed: companion build/C assertions
(4 groups), fixture generation, Rust example, live suite (5 passed, **0
ignored**, plus 1 default-isolation child test), ASan/LSan/UBSan build/C
assertions and repeated-call Rust test (1 passed). The same live test selected
with an absent artifact produced exactly 1 failure and 0 ignored tests, as
required. Runtime gate includes the accepted S2 collision, S3 missing-mdat,
taxonomy and retry/fallback tests; Python gate includes S3 native retry and
FFI error propagation tests. No earlier review's PASS substitutes for these
executions. The 9.0.1 upgrade changes only the selected version checks and this
document: `media-libav/build.py`, `media-libav/probe.c`,
`rust-runtime/src/experimental_libav/mod.rs`,
`rust-runtime/src/experimental_libav/tests.rs`, and `media-libav/README.md`.
Project ABI v1, metadata/error semantics and all existing assertions remain;
test build-version fixtures are updated to the selected version. The previous
8.1.2 companion explicitly reports `Unavailable` through the new runtime entry.

Exact inherited Python skips:

| Test | Technical reason reported by existing test |
| --- | --- |
| `test_internet_remote_deployment.InternetRemoteDeploymentTest.test_sync_copies_current_remote_html_dependencies` | PowerShell is required to execute the actual asset sync |
| `test_macos_backend_smoke.MacOSBackendSmokeTest.test_backend_ready_handshake_and_graceful_shutdown` | Backend executable absent at `dist/bilikara.app/Contents/MacOS/bilikara` |
| `test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_bbdown_restores_offline_vendor_to_clean_runtime` | Requires macOS |
| `test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_ffmpeg_and_runtime_copy_execute` | Requires macOS |
| `test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_https_uses_macos_system_trust` | Requires macOS |
| `test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_macos_aria2_prepares_on_demand_with_minimal_path` | Full aria2c download reserved for package validation gate |
| `test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_native_runtime_loads_from_bundle` | Requires macOS |
| `test_macos_tauri_smoke.MacOSTauriSmokeTest.test_tauri_resolves_backend_and_completes_ready_handshake` | Requires macOS |

No M1 Linux acceptance check remains incomplete. Windows/macOS companion
loading/packaging and real-device playback were not run (outside M1 scope).
No authenticated Hi-Res sample, full decode/scan or damaged-tail guarantee is
claimed. The existing `.app` bundle-identifier warning remains unrelated.

Local command records and raw outputs are in `.tmp/m1-libav-9/`:
`gate-*.json` / `gate-*.log`, `live-tests.log`, `asan-build.log`,
`asan-live.log`, `required-artifact-negative.log`, and `demo.json`.
`companion-{readelf,ldd}.txt`, `runtime-{readelf,ldd}.txt`,
`header-dependencies.txt` (52 libav headers, all in the selected prefix), and
`ffmpeg-info.json`, `signature.log`, `configure.log`, `ffmpeg-build.log` and
`ffmpeg-install.log` record actual dependency/header/build origins.
`av.mp4.strace` and `network.m3u8.strace` show only the driver exec, with no network
or ffprobe subprocess. Build-time/test reference ffprobe calls are separate.

Review the working tree or `.tmp/m1-libav-9/M1_LIBAV_PROBE.patch`, which includes
all eleven M1 files and excludes the two S1 patches. For untracked source files,
ordinary `git diff` alone is insufficient; use this patch or open the new files.
`.tmp/m1-libav-9/FFMPEG9_UPGRADE.patch` isolates the five-file upgrade from the
preserved 8.1.2 M1 implementation; `.tmp/m1-libav-9/before-upgrade/` contains its
original eleven-file boundary. Old M0 artifacts and evidence were not overwritten.
Commit: none. Push: No. No PR, tag, published release, remote workflow or deploy.
