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
changes as part of the Host bootstrap. Native Local Remote serving comes later;
Tauri IPC alone cannot serve another device's browser.

## Slice 1: native bootstrap, not a playable Alpha

- Tauri's library entry excludes the desktop process/window adapters on Android.
- The Android shell links `bilikara_runtime` directly and initializes its existing
  process-wide AppState. Re-entering initialization does not reset live state.
- A local-only, read-only command verifies that AppState returns a typed snapshot.
- The packaged startup page explicitly reports that Host API, persistence and
  playback are **not implemented**. No song mutations or external listeners exist.
- State is ephemeral in this slice. No existing library is imported or overwritten.
  Before enabling mutations, implement loading and atomic persistence of Rust
  snapshots and honor all returned persistence effects.
- The foreground Activity keeps the display awake for cable-mirror testing. This
  is not a background service, wake-lock workaround or lock-screen guarantee.
- iOS is intentionally not enabled by this Android bootstrap.

This small startup page is a temporary diagnostic, not a replacement Host UI.
Replace its launch URL with the shared Host when the compatible native server
can provide the required services. Desktop continues using its current backend.

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

## Next slices

1. Native Host lifecycle, configuration, cookie loading and atomic persistence.
2. Compatible Rust HTTP/SSE/static/media-Range service with Host/Remote auth boundaries.
3. Login, browsing, request admission and native cache/download through shared services.
4. Shared Host player on Android, media-library packaging, audio routing and HDMI recovery.
5. Background media lifecycle, interruptions, reconnection and long-session device tests.
6. Platform build jobs, signed distribution and a unified desktop/mobile release.

Keep using `-preview.N` for preview tags until version parsing and release detection
are deliberately extended; "Android Alpha" is the feature maturity label.

## Acceptance is separate from compilation

An APK or ARM64 shared library is not evidence of working login, TLS, Remote
serving, playback, HDMI, background operation or iOS compatibility. Those require
their own integration/device checks. The current reqwest Android TLS platform
verifier integration and native-media dependency closure must be checked before
enabling network/download operations. Validate 16 KB alignment for every shipped
native library, not just the Rust crate. Do not silently restore desktop CLI tools
as mobile fallbacks.
