# Native YouTube quick requests

## Scope

Native desktop and Android Hosts accept `https://www.youtube.com/watch?v=VIDEO_ID`
in the existing quick-request form, including LAN/public Remote requests.
The bare, `www`, `m` and `music` YouTube hosts are recognized. Only the eleven-
character video ID is retained: `list`, `radio`, `start_radio`, time offsets and
fragments never select a playlist or alter the playback start position.
The same form also accepts youtu.be, /shorts/, /embed/, /v/ and /live/ video
URLs and share text containing exactly one video. A /live/ URL is only a URL
shape: an ongoing live stream and a playlist-only page remain unsupported.
Multiple distinct videos fail explicitly rather than selecting one silently.
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

Set `BILIKARA_TEST_YOUTUBE_VIDEO_ID` to a public video for opt-in network checks.
These checks do not establish availability for every video, region or IP, or
physical Android playback acceptance. Use isolated caches and no private login.
