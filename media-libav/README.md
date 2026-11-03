# libav media integration

Current native prerequisites and cache use the independent Rust `xtask` through
the platform recipes; see [rebuild commands](REBUILD.md) and
[current desktop builds](../docs/native-desktop.md). The replaced Python companion
builder, comparison runner and fixture generator are retired. Node comparison
uses the actual Rust driver and explicit same-build FFmpeg/ffprobe test oracles;
ordinary product prefixes disable programs. Current native packages use
`xtask verify-native-desktop` and contain neither a PyInstaller backend nor
FFmpeg/ffprobe programs or private media test executables. The former frozen-package
smoke engines and their Windows wrapper are retired. Source media-CLI routing,
manifest validation and tool restoration remain supported separately; see
[Source compatibility](../docs/source-compatibility.md).

## Probe and comparison interfaces

`bilikara_runtime::experimental_libav::LibavMetadataProbe` exposes explicit
trusted-local-file operations. Call `unsafe load(absolute_path)` only for an
approved companion, then `probe_metadata(absolute_input_path, &AtomicBool)`.
The probe has no subprocess fallback. The example driver's two-path invocation
runs this probe; `compare` explicitly starts same-build test references.

Operation contracts and verification commands:

- [Metadata comparison](COMPARISON.md): field semantics, privacy and deadlines.
- [Packet scanning](PACKET_SCAN.md): selected-stream enumeration and EOF policy.
- [MP4 copy-remux](COPY_REMUX.md): staging, timestamps and encoded content.
- [FLAC normalization](FLAC_NORMALIZATION.md): continuous samples and PCM checks.

Application routing and package requirements are documented in
[native desktop](../docs/native-desktop.md); these driver interfaces do not
select a different application backend.

## Build and reproduce

Use the pinned FFmpeg **9.0.1** sources and matching native headers/libraries.
Follow [REBUILD.md](REBUILD.md) for signature checks and platform recipes.
Comparison and fixture generation additionally require a trusted same-build
FFmpeg/ffprobe test prefix with programs enabled; ordinary product prefixes
disable programs and must not acquire them for runtime use.

From the repository root, substitute absolute paths to prepared inputs and a
private output directory. The H.264 source must be a caller-authorized local
synthetic fixture:

```bash
LIBAV_PREFIX=/absolute/test-prefix
LIBAV_OUT="$PWD/.tmp/libav-verification"
H264_SOURCE=/absolute/fixtures/synthetic_video.mp4
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix "$LIBAV_PREFIX" --out "$LIBAV_OUT/companion" --test
node media-libav/generate_fixtures.mjs --prefix "$LIBAV_PREFIX" \
  --h264-source "$H264_SOURCE" --out "$LIBAV_OUT/fixtures"
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
cargo run --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata -- \
  "$LIBAV_OUT/companion/libbilikara_media_libav.so" "$LIBAV_OUT/fixtures/av.mp4"
```

`xtask libav-companion` uses only the explicit prefix, without pkg-config, and
builds the C companion and private shim outside application Cargo build graphs.
The fixture generator creates PCM WAV, uses the test CLI for AAC/FLAC encoding
and remuxing, and stream-copies the supplied H.264 source. Generated media,
binaries, reports and per-run signature/dependency evidence stay outside Git.

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
The application retains its independent bounded re-download policy.

## Compatibility and dependency checks

Negotiation checks project ABI and struct sizes, exact header/runtime versions
(`avformat 63.1.101`, `avcodec 63.1.101`, `avutil 61.1.101`), source version
and actual runtime configurations of all three libraries before AV struct
access. The shim repeats its compatibility check at probe entry. Build
configuration is obtained from the same-prefix CLI, then compared with loaded
library functions, not merely echoed back. This is trusted-artifact
compatibility checking, not a malicious-library sandbox.

The Linux companion uses transitive **DT_RPATH** because the prepared libraries
do not have individual RUNPATHs. Check that the three libav libraries and
indirect libswresample resolve within the selected prefix; retain only the
permitted system dependencies. The reference CLI uses child-process-only
`LD_LIBRARY_PATH`, without changing the global loader environment.

```bash
readelf -d "$LIBAV_OUT/companion/libbilikara_media_libav.so"
ldd "$LIBAV_OUT/companion/libbilikara_media_libav.so"
readelf -d rust-runtime/target/release/libbilikara_runtime.so
ldd rust-runtime/target/release/libbilikara_runtime.so
```

Mandatory Runtime libraries must not link to libav at process startup. Check
this separately from explicit companion loading. Native loading, packaging,
signing and playback require verification on the matching target platform;
a Linux diagnostic run cannot qualify Windows or macOS products.

## Explicit acceptance tests

Default runtime tests need no companion, headers, pkg-config or C compiler.
Artifact-dependent live tests are ignored by default. Supply their real inputs
and run them explicitly; missing artifacts must not become a passing result:

```bash
BILIKARA_LIBAV_COMPANION="$LIBAV_OUT/companion/libbilikara_media_libav.so" \
BILIKARA_LIBAV_FIXTURES="$LIBAV_OUT/fixtures" \
BILIKARA_LIBAV_FFMPEG_PREFIX="$LIBAV_PREFIX" \
BILIKARA_LIBAV_EXAMPLE="$PWD/rust-runtime/target/debug/examples/libav_metadata" \
cargo test --manifest-path rust-runtime/Cargo.toml --locked --lib \
  experimental_libav::tests::live_ -- --ignored --test-threads=1 --nocapture
```

Keep coverage for same-build metadata comparison, unknown duration, stream
enumeration, path/playlist/device restrictions, malformed/truncated inputs,
pre-cancel, in-call cancellation and repeated success/error/cancel cleanup.
Check descriptors, native allocations and separation from normalization.
Controlled child processes must reject missing dependencies/symbols, wrong ABI
or build and runtime version/configuration mismatches. Fake artifacts cannot
provide success-path evidence. Run Rust conversion, output-validation,
negotiation and AppState-isolation tests, plus the C shim `--test` checks.

Reference ffprobe uses `-show_streams -show_format`, the same discovery limits,
no `-count_packets` or decode/scan mode. Assertions compare format, index,
codec, dimensions, time base, rate/channels, raw depth, duration and start time.
Time tolerance is 1 microsecond for textual rounding; absent values must agree.
On the missing-mdat fixture, metadata succeeds at this limited depth while
the existing normalization returns `InvalidMedia` and creates no destination.

Sanitizer reproduction (GCC ASan/UBSan, Linux; test binary path is printed by
`cargo test --no-run --manifest-path rust-runtime/Cargo.toml --locked --lib`):

```bash
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix "$LIBAV_PREFIX" --out "$LIBAV_OUT/asan" --sanitize --test
# Substitute the lib test executable printed by Cargo for LIBAV_TEST_BINARY.
LD_PRELOAD=/usr/lib/gcc/x86_64-linux-gnu/11/libasan.so \
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
BILIKARA_LIBAV_COMPANION="$LIBAV_OUT/asan/libbilikara_media_libav.so" \
BILIKARA_LIBAV_FIXTURES="$LIBAV_OUT/fixtures" \
"$LIBAV_TEST_BINARY" --exact experimental_libav::tests::live_cancellation_and_repeated_cleanup \
  --ignored --nocapture
```

This instruments the shim and intercepts allocations; the selected FFmpeg
libraries and Rust are not sanitizer-instrumented. It does not prove absence
of every native-library memory error, damaged-tail detection, or full decoding.

Primary API context: [FFmpeg demuxing documentation](https://ffmpeg.org/doxygen/8.0/group__lavf__decoding.html).
The ABI authority for this interface is the **installed 9.0.1 headers**, especially
`libavformat/avformat.h`, `libavformat/avio.h`, `libavcodec/codec_par.h`,
`libavutil/error.h`, plus same-source `libavformat/file.c` (`fd_open`),
`demux.c`, `mov.c` and `options_table.h`. Online docs are not an ABI pin.
