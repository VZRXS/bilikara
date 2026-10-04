# Version roadmap

This roadmap records current product direction and ownership. It is not a build receipt or a release announcement. Releases require their own artifact and device acceptance; no dates are assigned. User instructions belong in [quick start](quick-start.md) and [upgrading](upgrading.md); implementation commands belong in [native desktop](native-desktop.md).

## v0.8 — convergence and release stabilization

**Preview 2 has shipped. Preview 3 is in preparation**, concentrating safe engineering retirement and desktop experience fixes before a quieter stabilization period. Preserve approved Preview 1 behavior and subsequent fixes. A source commit or an Actions development artifact is not a public release.

### Delivered ownership

- Native desktop products use the Rust HTTP/SSE Host, shared services and one authoritative `AppState`. No Python interpreter, PyInstaller payload or Python FFI library is shipped. The runtime migration is complete.
- Independent `xtask` owns development preparation, Host/updater release construction, Tauri assembly, compliance and macOS nested signing. Normal entries are `prepare:desktop`, `npm run build`, and CI's split `build-backend` / `assemble-desktop`.
- Libav prerequisites, C-only verified caches, actual-library probes, C companion construction and dependency collection use Rust plus pinned shell/MSVC recipes. Pinned BBDown build preparation uses `prepare-bbdown`. Replaced Python producers and construction references are deleted.
- Extracted-package qualification uses `verify-native-desktop` and actual installed Host execution. Construction, media, frontend and native business/HTTP/browser regressions use existing Rust/Node entries; replaced Python drivers and unused policy copies are deleted. Real-library checks run after their required prefix is prepared.
- Windows/macOS bundle jobs retain native architecture, signing, extraction/round-trip, Host and updater checks. Linux local/native fixtures do not substitute for foreign platform execution, physical displays, Android devices or user acceptance.

### Preview 3 experience and acceptance

- Current additions include native YouTube single-video quick requests and stable-ID session-user editing, with synchronized device names and immutable historical request labels. Shared components serve Host, local Remote and public Remote.
- Preserve queue rotation, priority/manual placement, stale command rejection, archived-session export, authentication and data recovery. Stabilize playback, fullscreen and audience-video geometry against the released desktop baseline.
- Updates include the external updater's readiness acknowledgement, recovery and restart-failure reporting. Validate actual installed packages; describe the one-time full-package transition from published older versions honestly.
- Preview 3 remains unpublished until the development artifacts are tested and release is explicitly approved. Passing CI does not establish venue audio/video, physical dual-screen behavior or every network/provider condition.

### Remaining Python and retirement

Supported Source development still executes Python for HTTP/FFI transport, yt-dlp orchestration, explicit media-CLI compatibility, their smoke/failure tests and source launchers. These are concrete consumers, not native product dependencies; simply redirecting the launcher would lose supported Source behavior. Keep their dependencies and regression gates until a faithful replacement exists.

Third-party rebuild toolchains and AWS CLI publication may have Python dependencies. Do not hide them inside Actions/containers or claim all CI is Python-free. Continue retirement by current consumers and protected contracts; test-language/file counts alone do not establish completeness. A zero-Python test repository is **not** a stable v0.8 release gate.

### Stable v0.8 requirements

Reliable desktop behavior, preserved data and layouts, recoverable upgrades and accurate platform limits determine readiness. Keep state/new business functionality Rust-owned. Avoid new UI/default/storage/codec changes during final stabilization unless a concrete defect requires them. Android remains a preview and does not redefine desktop acceptance.

## Downloading and media

Rust Native remains the default downloader; shared Rust services own scheduling, retries, cancellation, validation and atomic publication. BBDown and DownKyi/aria2c remain explicit alternatives with accepted pins. Packaged media uses in-process libav, without FFmpeg/ffprobe programs; external test oracles remain test dependencies. Resume/proxy/crash-recovery work follows validated needs rather than a new engine or source-policy rewrite.

## Shared UI, mobile and casting

Host, local/public Remote and Android share components, actions and layout definitions, with narrow platform/role adapters. Compact desktop retains desktop navigation; Android phone navigation is platform-specific. Refine component roles, typography, geometry, surfaces, focus, motion and asynchronous guards while preserving media nodes and drafts. Reference Apple HIG, Microsoft Fluent, then Google Material where they fit the existing product; record approved component rules in `AGENTS.md`.

Continue Android lifecycle, background playback, local-network and external-display device validation. Future casting uses stable Rust-served HTTP media and shared session/target/controller abstractions, with actual receiver checks. DLNA playback, system mirroring and an independent audience display are separate capabilities; none is certified by an emulator or a desktop screenshot.

## v1.0 milestone

v1.0 requires a nearly complete intended feature set, coherent UI, stable desktop and mobile Host behavior, mature casting, acceptable migration/compatibility and release-quality reliability. Intermediate releases follow actual progress; these requirements are not lowered by engineering retirement.
