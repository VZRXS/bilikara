# Android Host Alpha

## Scope and branch

Development starts on `codex/android-host-alpha`, based on desktop commit
`b064fb383544ae4b4224840d683b3659ea83862f`. This is a temporary feature branch,
not a separate mobile product or a second implementation of the Rust core.
Desktop and mobile will ultimately build from the same integrated release tag.
Keep independently reviewable commits and desktop regression gates throughout.

The first playback target is a foreground Android Host connected to a compatible
display with an HDMI adapter. Start with system screen mirroring and another
web Remote for control. Independent phone-controller / TV-video presentation is
a later native display adapter. DLNA, Cast and AirPlay are not Alpha prerequisites.
Wired display output still depends on the phone and adapter hardware.

The existing web Remote, UI layout and HTTP/SSE contracts remain the compatibility
target. Do not create an Android Remote app, another Remote UI, or deploy Worker
changes as part of the Host bootstrap. The native HTTP listener now serves Local
Remote; Tauri IPC is used only for the initial local bootstrap.

## Current build: foreground playback / device-test Alpha

This is now a playable Rust Host, not just the bootstrap page described in the
historical slices below. It uses the same `index.html` / `app.js` and `remote.html`
/ `remote.js` as desktop. Desktop still uses its existing transport adapter.

- Rust owns AppState, private persistence, authenticated HTTP/SSE, Bilibili QR
  login, BV/av metadata, manual/automatic page binding and native media caching.
  No Python process, BBDown, FFmpeg executable or downloader sidecar is packaged
  into Android. AVC/AAC download/normalization runs through the existing runtime.
- The Tauri shell resolves app-private paths, loads bundled assets and keeps the
  foreground screen awake. A read-only schema-3 bootstrap exchanges a random
  loopback token for an HttpOnly cookie before entering the shared Host UI.
- Host-only commands require both the Host cookie and a loopback connection.
  LAN Remote gets a separate per-device cookie via the Host's QR invitation.
  Cookies, QR login state, Host tokens and diagnostic access are not sent to Remote.
  Origin/Host validation, bounded request bodies, concurrency, command queues and
  a 10-device cap apply. This remains trusted-LAN **HTTP**, not encrypted public
  hosting; do not expose the listener with router port forwarding.
- Local QR selection prefers Wi-Fi over cellular private addresses. Connect Wi-Fi
  before launching; restart the Alpha and scan its new QR after changing networks.
- Native media responses support byte ranges for seeking and stream from files.
  Three queued/current songs are prefetched; quality is fixed to AVC up to 720p
  and ordinary audio. Failed jobs require an explicit retry, not an infinite loop.
  Old artifact generations are reclaimed after both the player and open HTTP
  readers release them. A restart clears obsolete private staging/artifact files.
- Bilibili login cookies are stored separately in the application's private
  directory, never in the queue checkpoint or diagnostic output. Logout invalidates
  the in-flight polling generation and the saved credential. Android backup is
  disabled. Login QR acquisition was checked; successful human scanning and login
  persistence still require a device check.
- The shared player and Remote support queue/history, pause/resume, seek, next,
  original/accompaniment selection and the existing player settings. Native
  diagnostics retain bounded audio/video error facts and reuse the sanitized
  Markdown export. Use Settings → diagnostic information → copy diagnostic info.
- Unsupported UI is explicitly hidden/disabled: shared-library search/Gacha,
  favorites/following management, Internet Remote, independent dual display,
  desktop tool/update/export controls. Do not mistake those gaps for full mobile
  feature parity. Public Remote and Worker code are not modified by this Alpha.

### Install and check on hardware

Build output: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
This is an ARM64 debug APK (`com.bilikara.app.alpha`, Android 7/API 24 minimum),
not a Play Store release or production signing configuration.

1. Install the APK on an ARM64 Android phone. Join the intended Wi-Fi **before**
   opening it. With USB debugging available: `adb install -r <apk-path>`.
2. Open the app, add a session user, and request a BV directly. Optional QR login
   is in Settings; scan it with an already logged-in Bilibili app on another
   device. An unauthenticated public-video request can be tested first.
3. Check video **and** audible audio, pause/resume, repeated seeks, automatic next
   and original/accompaniment switching. Check manual selection on an ambiguous
   multi-part video. The BV `BV1z84y1p7oS` was used for the desktop native-network
   acceptance, not as a promise of future upstream availability.
4. Open “手机点歌” and scan using a second phone on the same LAN. Verify request
   admission, queue/history and all playback controls without reloading. Client
   isolation in a venue's Wi-Fi can prevent this; the Alpha has no Internet mode.
5. Connect a supported USB-C/HDMI adapter and display. Use system mirroring and
   the shared full-screen player; verify picture, TV audio routing, A/V delay,
   cable reconnect and rotation. USB-C alone does not imply display-output support.
6. Close/reopen the app; users, queue, page choices and settings should persist.
   Media is downloaded afresh after restart; runtime playback tokens are not
   restored. Finally test a long foreground session and watch temperature/storage.
7. If playback fails, copy diagnostics from Settings; also save Android logcat
   for startup/WebView/codec problems. Exclude room links/cookies and personal data
   before sharing raw logcat. Do not clear app data before capturing the failure.

Physical-device codec support, actual audio output, HDMI behavior, 16-KB-page
devices and long-session thermal behavior are **not established by desktop tests**.
Background playback, lock-screen operation, interruption recovery and separate
phone/TV layouts are later work; keep the Host foreground during this first test.

## Slice 1: native bootstrap, not a playable Alpha

- Tauri's library entry excludes the desktop process/window adapters on Android.
- The Android shell links `bilikara_runtime` directly and initializes its existing
  process-wide AppState. Re-entering initialization does not reset live state.
- A local-only, read-only command verifies that AppState returns a typed snapshot.
- At the initial bootstrap commit, the page reported Host API, persistence and
  playback as unavailable. Slice 2 below replaces ephemeral state with native
  storage; song mutations and external listeners are still not exposed.
- The foreground Activity keeps the display awake for cable-mirror testing. This
  is not a background service, wake-lock workaround or lock-screen guarantee.
- iOS is intentionally not enabled by this Android bootstrap.

This small startup page is a temporary diagnostic, not a replacement Host UI.
Replace its launch URL with the shared Host when the compatible native server
can provide the required services. Desktop continues using its current backend.

## Slice 2: native saved state (historical bootstrap milestone)

- Android resolves its app-private data directory and calls `initialize_native_host`.
  The shared process-wide Rust AppState remains the only mutable authority.
  Rust owns loading, validation, restart policy and persistence; Tauri only adapts
  platform paths/time and shows the startup result. No Python implementation is added.
- `host-state.json` is a versioned, bounded checkpoint (32 MiB maximum) containing
  the queue/current item, player settings, histories, session users, session archives
  and backup. It does not import or change the desktop adapter's legacy JSON files.
  Cookies, media files and Gacha configuration are **not** part of this checkpoint.
- A lifetime file lock excludes a second writer. State-changing commits, including
  those originating in the native cache runtime, save their restart-safe projection
  under the AppState lock before publishing the new live state. Snapshot reads,
  duplicate startup calls and cache-progress-only changes do not rewrite the file.
- Writes use a bounded temporary file, flush/sync its contents, then replace the
  checkpoint by same-directory rename. This protects against partial writes and
  ordinary process interruption; abrupt power-loss durability still requires
  filesystem/device testing (the parent directory is not explicitly fsynced).
  The scratch file is never promoted during loading. Unsupported, malformed,
  oversized or unreadable checkpoints fail closed instead of becoming empty state.
  See the [Rust rename contract](https://doc.rust-lang.org/std/fs/fn.rename.html).
- Saved queues resume with `current_item_started = false`, fresh item identities,
  empty cache reservations and no restored Remote peers. Media artifacts must be
  validated/rebuilt before playback; in-flight cache/playback credentials are not
  revived. Page selections, settings and user history remain intact. Runtime reset
  and backup discard are saved as state changes, so old records do not reappear.
- The read-only startup response now uses schema 2 / `native-persistence` and reports
  persistence ready. A storage error remains visible on the local diagnostic page;
  it neither silently clears data nor falls back to an ephemeral Host. HTTP service,
  login, song requests and playback remain unavailable in this build.

## Local build

Use the repository's Node and Rust versions, a JDK supported by the generated
Gradle project, Android SDK platform 36, and an Android NDK. Set `JAVA_HOME`,
`ANDROID_HOME` and `NDK_HOME` in the build shell; do not commit machine-local paths.

```text
rustup target add aarch64-linux-android
npm ci
npm run android:build:debug -- -- --locked
```

The Android project is checked in under `src-tauri/gen/android`. Build output,
local SDK paths, generated Tauri glue, keys and signing files remain ignored.
`npm run android:init` is for regenerating the scaffold, not a normal build step;
review generated changes so it does not discard the Activity's platform adapter.
Kotlin incremental compilation is disabled because the Cargo registry and the
checkout can reside on different Windows drives; Kotlin 1.9's relative-path
cache fails in that layout. Desktop-only Tauri plugins are not linked on Android.
Only ARM64 is selected for the initial debug build. No device installation,
production signing, release upload or Worker deployment is performed by this script.
JNI debug sections are stripped from the APK; the original symbol-bearing library
remains at `src-tauri/target/aarch64-linux-android/debug/libbilikara_app.so`. Keep
that exact build when collecting a crash report. The APK remains debug-signed
and debuggable; it is intended for private Alpha testing.

## Next slices after device acceptance

1. Device audio/HDMI lifecycle findings and long-session tests.
2. Native search/Gacha/favorites services and remaining Host feature parity.
3. Background media lifecycle, interruptions and reconnection.
4. Platform build jobs, signed distribution and a unified desktop/mobile release.

Keep using `-preview.N` for preview tags until version parsing and release detection
are deliberately extended; "Android Alpha" is the feature maturity label.

## Acceptance is separate from compilation

An APK or ARM64 shared library is not evidence of working login, TLS, Remote
serving, playback, HDMI, background operation or iOS compatibility. Those require
their own integration/device checks. Native desktop integration now verifies
the real Host listener and shared browser pages with generated H.264/AAC fixtures;
an opt-in test additionally requests a public BV, downloads through Rust and
decodes both actual media tracks. Android HTTPS uses bundled Mozilla certificate
roots with normal certificate/hostname validation, avoiding an uninitialized
JNI platform verifier. Validate 16 KB alignment for every shipped
native library, not just the Rust crate. The Android linker explicitly requests
16 KB max/common page sizes, including when using NDK r27; this does not replace
a 16 KB device test. See [Android's page-size guidance](https://developer.android.com/guide/practices/page-sizes).
Do not silently restore desktop CLI tools as mobile fallbacks.

### Repeatable native acceptance harnesses

```text
cd rust-runtime
cargo test --locked --features native-host
cargo build --locked --features native-host --example native_host_alpha
cd ..
node tests/live_native_host_alpha.js <native_host_alpha-exe> <new-private-dir> <H264-mp4> <AAC-m4a> <chrome-exe>
node tests/live_native_bilibili_alpha.js <native_host_alpha-exe> <another-new-private-dir> <BV> <chrome-exe>
```

Playwright must be available to Node (the test runner may set `NODE_PATH`). Use
90-second generated media for the fixture test; its Remote control exercise seeks
and switches songs. Each private directory must be new/disposable and absolute
paths are passed to Rust by the runner. The network test makes real Bilibili
requests, generates but does not scan a login QR, and never uses an existing user
profile or contacts D1. It is opt-in, not part of routine unit tests. Browser tests
are not equivalent to Android WebView or real output-device validation.
