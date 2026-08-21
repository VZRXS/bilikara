# Version roadmap

This document separates established architectural direction from candidate
scope. Tentative entries are planning inputs, not release promises. No dates
are assigned.

## Confirmed direction

### v0.7.0 — Rust business-rule migration and release stabilization

- Phase 2 is complete at 8/8.
- The typed Rust business-rule core remains behind the current compatibility
  boundary, with native Rust/Tauri build and bundle validation.
- Stabilization includes the global AV-delay lock, split-playback reliability,
  exports, and desktop integration.
- Node.js 24 is a build and CI baseline. It is not an end-user runtime
  requirement.
- Python continues to own v0.7 operational I/O and mutable runtime state.
- That Python ownership is retained release orchestration, not a destination
  for new backend features. New backend/business policy is Rust-authoritative,
  without new equivalent Python semantic fallbacks.
- The AV-delay state machine is an additional typed Rust policy introduced
  during stabilization. It is not a ninth Phase-2 domain.
- Preview stabilization also includes Rust-authoritative playback-selector mode
  policy and BBDown prepare routing. These focused policies are not a new
  "Phase 3" and do not begin the full stateful-core migration.
- v0.7 is not the final Rust runtime architecture.

### v0.8.0 — Rust Core Convergence / Preview

The confirmed objective is to make the Rust runtime the normal execution path,
instead of using Rust only as a library of deterministic rules.

- Introduce Rust runtime/application services and Rust `AppState` ownership for
  stateful store, session, playlist, and cache behavior.
- The current application-service slice in `rust-runtime` owns the Bilibili
  QR-login state machine and generation guard, Bilibili WBI/DASH and redirect
  I/O, Rust Native cache queues/retries/cancellation/validated publication,
  Gacha task status plus repository/network refresh, Cloudflare request
  execution and bounded background append scheduling, update transfer and
  installation preparation, diagnostics assembly, and network selection.
  Python still supplies configuration facts, projects cache events into the
  compatibility store, starts explicit external-tool workers, and adapts the
  temporary C ABI.
- Make the Rust server/runtime the normal path. Retain Python only as a desktop
  compatibility/startup fallback during the transition.
- Select one stateful core mode at startup: Rust Core mode for the process, or
  Python compatibility mode only when Rust initialization or migration fails.
- Do not use per-operation Rust-to-Python fallback for stateful operations and
  do not permit split-brain state.
- Reduce repeated JSON FFI transport and duplicate Python recomputation in
  normal Rust mode.
- Retain transactional fallback only where temporary output can be cleaned up
  and final publication is atomic.
- Split `src-tauri/src/main.rs` into focused modules before adding substantial
  runtime responsibilities.
- Begin replacing external command-line dependencies.

External-tool direction:

- BBDown: port only the behavior bilikara needs. Use the final known/current
  BBDown behavior as a golden compatibility oracle, do not recreate unrelated
  features, and retain explicit fallback for unsupported or special cases
  during transition.
- Downloader: implement an independent Rust downloader without porting or
  linking aria2 source. Initial scope is HTTP/HTTPS, headers and cookies, URL
  fallback, progress, cancellation, timeout/retry, temporary files,
  response-length validation, and atomic publication. Range requests,
  segmentation, resume, validators, proxy support, and crash recovery may
  follow incrementally. Keep aria2c as an explicit transition fallback until
  the Rust path is proven.
- The `rust-runtime` downloader implements concurrent range transfer and is
  wired into the desktop host through a temporary C ABI. Rust Native stream
  resolution, selection, probing, and MP4/FLAC normalization are Rust-owned.
  BBDown, yt-dlp, aria2c, and FFmpeg CLI remain explicit desktop alternatives
  or compatibility fallbacks rather than hidden per-operation fallbacks.
- Media backend: introduce a `MediaBackend` abstraction. Prefer direct FFmpeg
  libraries, primarily the required `libavformat`/`libavutil` functionality;
  remove ffprobe CLI use where the library backend covers current metadata
  inspection. Keep FFmpeg CLI only as a desktop transition fallback. Mobile
  production must not depend on CLI executables.

Casting foundation:

- Produce or remux the selected audio and serve it over HTTP with Range support
  and stable local media URLs.
- Introduce `CastSession`, `CastTarget`, and `CastController` abstractions.
- Build an SSDP/DLNA discovery proof of concept and prove this flow:

  ```text
  current song
  -> selected audio
  -> Rust media output
  -> local HTTP URL
  -> DLNA renderer
  ```

DLNA media casting is not operating-system screen mirroring.

### v1.0.0 milestone

v1.0.0 is a product-maturity milestone, not a deadline tied to a small number
of intermediate releases. It requires a nearly complete intended feature set,
a coherent and unified UI, stable desktop and mobile Host behavior, mature
casting, acceptable migration and compatibility behavior, and release-quality
reliability. Versions such as v0.10.0, v0.11.0, and later before v1.0 are
explicitly acceptable.

## Tentative plans subject to revision

### v0.9.0 candidate direction

- Android Host Alpha capable of complete Host operation without a computer.
- Local playback, Remote serving, download/cache operation, a foreground
  service, notification and MediaSession integration, and Android local-network
  permissions.
- No Python and no sidecar CLI dependencies.
- Production-grade DLNA discovery/control, including seek, volume, media
  switching, session recovery, renderer profiles, and device testing.

The exact v0.9 scope must be re-evaluated from actual v0.8 results and must not
be artificially constrained to a small release.

### v0.10.0 candidate direction

- Android Host stabilization and Google Cast.
- iOS Host Alpha, AirPlay integration, and iOS lifecycle/background-server
  investigation.

This allocation is provisional and may move across v0.9, v0.10, v0.11, or
later releases.
