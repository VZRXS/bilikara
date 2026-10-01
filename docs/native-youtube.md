# Native YouTube quick requests

## Scope

Native desktop and Android Hosts accept `https://www.youtube.com/watch?v=VIDEO_ID`
in the existing quick-request form, including LAN/public Remote requests.
The bare, `www`, `m` and `music` YouTube hosts are recognized. Only the eleven-
character video ID is retained: `list`, `radio`, `start_radio`, time offsets and
fragments never select a playlist or alter the playback start position.
Short links, Shorts, playlist pages and live streams are deliberately unsupported.
Private, login-, payment-, region- or DRM-restricted videos fail explicitly.
Network access to YouTube and Google video servers is required at the Host;
Remote only sends the source-scoped ID. The legacy Python Host is not extended.

## Architecture and isolation

- `rust::media_source`: pure link/source identity policy. Old items without a
  source field remain Bilibili items. YouTube items have no BV/AID/CID/UP identity.
- `rust::youtube_selection`: pure compatible format/quality selection.
- `rust-runtime::youtube`: bounded HTTP watch/player extraction and temporary
  stream URL resolution. When WEB only supplies SABR metadata, it performs one
  VISIONOS player request using anonymous visitor context from the watch page.
  This client profile may need updates when YouTube changes its public players.
- Signature/`n` computation uses pinned EJS 0.8.0 in embedded QuickJS via
  rquickjs 0.14.0: 256 MiB heap, 2 MiB stack, ten-second execution budget and
  cancellation. Only one solver VM is admitted at once (up to twenty seconds
  waiting, cancellable). Current multi-megabyte player ASTs exceed 128 MiB.
  No host filesystem/network/process bindings or module loader are installed.
  This is native orchestration with a small embedded JS engine, not an assertion
  that YouTube's changing JavaScript transforms were rewritten into pure Rust.
- Existing Rust cache admission, concurrent HTTP ranges, cancellation, progress,
  normalization and atomic publication remain authoritative. Resolved URLs are
  shared only within a cache job, not persisted or exposed to Remote. A manual
  retry resolves fresh URLs. Parser/unavailability errors are terminal for the
  attempt rather than repeated through the download retry loop.
- One source-aware AppState owns mixed queues, duplicates, history, sessions,
  export links and player controls. No second YouTube queue or player is added.
- YouTube never enters catalog append/D1, ratings, Gacha, Bilibili login, UP or
  favorites queries, or invalid-BV deletion. Bilibili cookies are not forwarded.

Metadata needs one watch request. A cache attempt fetches a fresh watch response,
at most one alternative player response, and player JS only when needed to solve
selected tracks. Media range requests are separate. There is no D1/Worker lookup
for this feature and no whole-playlist crawling.

YouTube media uses 1 MiB HTTP ranges with at most four workers per track.
This also segments typical short audio files that otherwise receive a paced
whole-file response. Bilibili and other transfers retain their existing 5 MiB /
sixteen-worker policy. Range, content-length, cancellation and publication
validation are shared; unsupported ranges still use the existing fallback.

## Quality and playback

Both MP4 and WebM can contain either separate tracks or multiplexed audio/video;
the container extension alone does not determine this. This implementation selects
**independent H.264/MP4 video and mono/stereo AAC-LC/MP4 audio**, so no demuxing,
transcoding or FFmpeg executable is introduced. Original audio is preferred over
automatic dubbing, then the default track, then bitrate. Formats requiring DRM
are excluded. The existing MP4 normalization and player consume the two tracks.

| Existing setting | YouTube ceiling |
| --- | --- |
| 360P | 360p, 30 fps |
| 480P | 480p, 30 fps |
| 720P | 720p, 30 fps |
| 1080P | 1080p, 30 fps |
| 1080P high frame rate | 1080p, 60 fps |

The effective AVC cap still applies. Missing compatible qualities fall back to
the best lower resolution; no compatible independent pair gives a clear failure.
WebM/VP9/AV1/Opus, 4K, YouTube login/PO tokens and Hi-Res are not part of this
first implementation. The Hi-Res preference does not synthesize lossless audio.
Audio/video offset, pitch, volume, seek and skip use the existing player. One
YouTube audio track is not vocal removal and does not fabricate an instrumental.

## Build and validation

No yt-dlp/Python/Node/Deno runtime is added to the product. EJS source is about
155 KiB uncompressed; the native QuickJS code also increases executable size.
Do not equate source size with installed APK size or promise zero growth.
`static/youtube-native-LICENSES.txt` is automatically shipped by both asset paths.

Android needs build-time libclang for rquickjs bindings. CI installs `libclang-dev`
and sets target-specific bindgen arguments to NDK r27's sysroot/Clang resources.
CI also runs the offline Remote transport and pinned EJS checksum regression tests.
On Windows set `LIBCLANG_PATH` to a matching libclang DLL directory, and set
`BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android` to:

```text
--target=aarch64-linux-android24 --sysroot=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/sysroot -resource-dir=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/lib/clang/18
```

libclang and headers are build tools, not APK resources. Use the existing NDK
compiler/archiver/linker configuration (or Tauri Android build environment).

Offline targeted checks:

```text
cargo test --manifest-path rust/Cargo.toml --locked
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host youtube --locked
node --test tests/youtube_quick_request.test.mjs
```

Explicit opt-in network smokes (public Creative Commons Big Buck Bunny):

```text
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host live_public_watch --locked -- --ignored --nocapture
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --release --lib live_player_signature_solver --locked -- --ignored --nocapture
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host youtube_live_native_download_and_normalize --locked -- --ignored --nocapture
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --test native_youtube_http --locked -- --ignored --nocapture
```

The download smokes fetch approximately 25 MB at 360p into an isolated temporary cache,
validates both tracks with the production normalizer, then removes that fixture.
It is not a download-speed benchmark against BBDown/DownKyi, nor a substitute
for physical Android audio/video sync and playback testing.

Set `BILIKARA_TEST_YOUTUBE_VIDEO_ID` for `live_public_watch` and
`native_youtube_http` to test a different public watch video. On 2026-10-01,
`je76h5UXDTw` (288 seconds) passed metadata and both live media reads, then the
real HTTP quick-request/cache/local-media pipeline at 360p (about 21 MiB).
The latter completed in about 4.1 seconds with small ranges; before that change,
the full-body audio transfer had only fetched 2.7 / 4.4 MiB after ninety seconds.
These observations apply to that run and network, not all videos, regions or IPs.

## Implementation handoff — 2026-10-01

Implementation base: `dev` at `7ead1efd12a06077bd3f0535ea4f7b9cf0648798`.
The results below describe local implementation verification, before the
subsequently requested commit/push and artifact-only Actions build. They do not
claim a successful CI bundle, PR, Cloudflare deployment or release upload.

### Files with source changes

New files:

- `docs/native-youtube.md`
- `rust/src/media_source.rs`
- `rust/src/media_source/wire.rs`
- `rust/src/youtube_selection.rs`
- `rust-runtime/src/youtube.rs`
- `rust-runtime/tests/native_youtube_http.rs`
- `rust-runtime/vendor/yt-dlp-ejs/LICENSE`
- `rust-runtime/vendor/yt-dlp-ejs/README.md`
- `rust-runtime/vendor/yt-dlp-ejs/yt.solver.core.min.js`
- `rust-runtime/vendor/yt-dlp-ejs/yt.solver.lib.min.js`
- `static/youtube-native-LICENSES.txt`
- `tests/youtube_quick_request.test.mjs`

Modified files:

- `.github/workflows/ci-bundle.yml`
- `THIRD_PARTY_NOTICES.md`
- `rust-runtime/Cargo.toml`
- `rust-runtime/Cargo.lock`
- `rust-runtime/src/app_state.rs`
- `rust-runtime/src/cache_runtime.rs`
- `rust-runtime/src/cache_runtime/orchestration.rs`
- `rust-runtime/src/http_downloader.rs`
- `rust-runtime/src/internet_remote.rs`
- `rust-runtime/src/lib.rs`
- `rust-runtime/src/native_host/cache.rs`
- `rust-runtime/src/native_host/catalog_append.rs`
- `rust-runtime/src/native_host/exports.rs` (test only)
- `rust-runtime/src/native_host/files.rs`
- `rust-runtime/src/native_host/internet.rs`
- `rust-runtime/src/native_host/preferences.rs`
- `rust-runtime/src/native_video.rs`
- `rust/src/internet_remote_protocol.rs`
- `rust/src/lib.rs`
- `rust/src/playlist_planning.rs`
- `rust/src/quality_policy.rs`
- `src-tauri/Cargo.lock`
- `static/i18n.json`
- `static/index.html`
- `static/remote-transport-client.js`
- `static/remote.html`
- `tests/test_host_build_review_repair.py` (expected intentional copy change)

No source files were deleted. Generated Tauri permission files and the core
Cargo lockfile can have refreshed timestamps/line endings but no Git content
diff. Compiler outputs, `node_modules` and isolated test fixtures are not source
changes. Build-only libclang was placed under the ignored
`.tmp/youtube-native/toolchain`, not installed in or shipped with the application.

### Architectural classification

Rust core owns deterministic source identity, duplicate keys, quality ranking
and public-protocol validation. Rust Runtime owns network/VM execution, source-
aware cache I/O and AppState admission/projection. Existing state authority and
playback are reused. The export change is a regression test, not a second export
implementation. Python business logic and frozen references are unchanged; the
only Python edit updates a UI-copy assertion, retaining explicit UTF-8 reads.
Frontend changes adapt the public transport and copy, with no new media nodes,
player engine, framework or asynchronous UI actions. CI adds build tools and
offline regression checks, not product resources.

### Validation commands and outcomes

Commands below ran from the repository root on Windows. Earlier intentionally
failing test-first iterations are not represented as successful checks.

| Exact command | Outcome |
| --- | --- |
| `cargo fmt --manifest-path rust/Cargo.toml --check` | Pass |
| `cargo clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings` | Pass |
| `cargo test --manifest-path rust/Cargo.toml --locked` | Pass, 232 tests |
| `cargo build --manifest-path rust/Cargo.toml --release --locked` | Pass |
| `cargo fmt --manifest-path rust-runtime/Cargo.toml --check` | Pass |
| `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --locked -- -D warnings` | Pass |
| `cargo clippy --manifest-path rust-runtime/Cargo.toml --features native-host --all-targets --locked -- -D warnings` | Pass |
| `cargo test --manifest-path rust-runtime/Cargo.toml --locked` | Fails in the unchanged live Windows gateway comparison; see below |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --lib` | 462 pass, 2 fail, 8 ignored; see below |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --test '*'` | Both existing HTTP integration tests pass; live YouTube test opt-in |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --lib youtube` | 11 pass, 3 live smokes opt-in |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --lib http_downloader` | 9 pass |
| `cargo build --manifest-path rust-runtime/Cargo.toml --release --locked` | Pass |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --release --lib live_player_signature_solver -- --ignored --nocapture` | Pass against the real public player JS after the memory fix |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --lib live_public_watch -- --ignored --nocapture` | Pass with `BILIKARA_TEST_YOUTUBE_VIDEO_ID=je76h5UXDTw` |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host youtube_live_native_download_and_normalize --locked -- --ignored --nocapture` | Pass, both CC sample tracks normalized |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --test native_youtube_http -- --ignored --nocapture` | Pass with `BILIKARA_TEST_YOUTUBE_VIDEO_ID=je76h5UXDTw`, 4.13 s |
| `cargo check --manifest-path rust-runtime/Cargo.toml --features native-host --target aarch64-linux-android --locked` | Pass with the NDK/libclang settings below |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Pass |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | Pass |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 102 pass, 1 existing packaged-backend smoke opt-in |
| `cargo build --manifest-path src-tauri/Cargo.toml --release --locked` | Pass |
| `$env:BILIKARA_REQUIRE_RUST_LIB='1'; python -m unittest discover -s tests -v` | 1805 run: 7 failures, 1 error, 129 skips; see below |
| `python -m unittest discover -s tests -p test_host_build_review_repair.py -v` | 42 pass after aligning initial HTML copy with i18n |
| `python -m compileall -q bilikara` | Pass |
| `python -m py_compile start_bilikara.py build_bundle.py` | Pass |
| `node --test tests/youtube_quick_request.test.mjs` | 3 pass, including pinned vendor checksums |
| `node --check static/remote-transport-client.js` | Pass |
| `npm ci` | Pass |
| `npm run build` | Fails: pinned BBDown vendor preparation required |
| `git diff --check` | Pass |

Android cross-check environment (build tools, not product resources):

```powershell
$ytNdk='C:/Users/kevin/AppData/Local/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/windows-x86_64'
$env:CC_aarch64_linux_android="$ytNdk/bin/aarch64-linux-android24-clang.cmd"
$env:AR_aarch64_linux_android="$ytNdk/bin/llvm-ar.exe"
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$ytNdk/bin/aarch64-linux-android24-clang.cmd"
$env:LIBCLANG_PATH='D:/bilikara/bilikara/.tmp/youtube-native/toolchain/clang/native'
$env:BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--target=aarch64-linux-android24 --sysroot=$ytNdk/sysroot -resource-dir=$ytNdk/lib/clang/18"
```

### Remaining gate failures and unverified scope

The full release gate is **not green**. No assertions were disabled or weakened:

- `native_host::desktop::tests::isolated_root_never_enrolls_existing_data`:
  Windows canonical `\\?\C:\...` versus ordinary `C:\...` temp-root equality.
- `networking::tests::live_windows_gateways_match_net_ip_configuration`:
  PowerShell reports `以太网 2`, absent from the native interface result.
- `test_build_bundle.BuildBundleTest.test_resolve_ffprobe_from_ffmpeg_sibling_when_not_on_path`:
  `Libav prefix is incomplete; no system fallback`.
- `test_build_bundle.BuildBundleTest.test_resolve_bundle_binary_path_rejects_unresolved_windows_shim`:
  repository `tools/local-build/libav-windows-x64/bin/ffprobe.exe` is discovered.
- Six `test_cache` failures discover `build/bbdown-vendor/bin/BBDown.exe` instead
  of the tests' mocked temporary tool/acquisition route:
  `test_failed_bbdown_update_preserves_existing_binary_and_bbdown_data`,
  `test_invalid_bbdown_archive_raises_clear_error`,
  `test_bbdown_uses_bucket_fallback_when_release_check_fails`,
  `test_ensure_bbdown_existing_binary_reads_binary_version_without_metadata`,
  `test_ensure_bbdown_existing_binary_skips_release_request`, and
  `test_ensure_bbdown_raises_when_release_check_fails_and_no_local_binary`.

Those production/test paths were not changed for this feature. Python's existing
129 skips include platform-specific TLS fixtures requiring Linux SSL_CERT_FILE
trust, unsupported-platform checks and unavailable opt-in fixtures. Opt-in live
YouTube tests were run separately as recorded above; the Tauri packaged-backend
smoke was not run because packaging did not complete.

The failed bundle command recreated `dist/bilikara` before stopping at its
BBDown check. That directory currently contains an incomplete generated staging
tree, **not a runnable installation or deliverable**. No backup was made before
that command; do not assume pre-existing contents there can be restored. A new
bundle requires fixing the existing pinned vendor prerequisite first.

No APK installation, Android physical audio/video sync test, rendered WebView
playback test, Linux/macOS build, signed release or precise before/after APK size
measurement was performed. No connected Android test target was used this turn;
the real media tests ran in the Windows shared native Host. Network success here
does not establish access from another device, region or IP. Anti-bot/login/DRM
failures remain explicit errors rather than cookie import, token farming or
unbounded retries.
