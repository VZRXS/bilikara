# Version roadmap

This roadmap records current confirmed direction and future product goals.
Individual changes are scoped from actual validation results; no release dates
or provisional version allocations are assigned. Current desktop setup,
storage and migration details belong in [native desktop launch and bundles](native-desktop.md).

## Current direction

### v0.8.0 — Rust core convergence and release stabilization

- v0.8.0-preview.2 has been released. The desktop runtime migration is complete;
  current work stabilizes that release, preserving approved Preview 1 behavior
  and subsequent changes rather than starting another migration.
- Native desktop bundles use the Rust HTTP/SSE Host and one authoritative Rust
  `AppState`. They include no Python runtime, PyInstaller payload or Python FFI
  libraries. Python remains scoped to remaining verification/tests, auxiliary
  preparation/publication tooling, legacy compatibility and source development
  workflows.
  Replaced desktop/libav/BBDown Python construction producers are retired.
- Delivered: native packaging no longer imports the legacy Python application;
  build-time manifest validation lives in the tooling layer.
- Preview 3 preparation: the independent Rust `xtask` now handles desktop
  development preparation (`prepare:desktop` and the Tauri development hook),
  including backend/updater compilation and existing resource/tool/libav
  staging. Linux execution and contract comparisons qualify this slice;
  Windows/macOS native GUI validation remains separate.
- Ordinary release construction/assembly now uses the same tool: `npm run build`
  builds Host, updater and Tauri; CI uses `build-backend` and `assemble-desktop`
  around its existing shell build and checks. Compliance and macOS nested signing
  belong to Rust orchestration. Linux native execution and reference comparisons
  cover the local slice; Windows/macOS native signing/startup/archive gates remain
  required in CI. This source change does not publish or qualify a new release.
- Libav build prerequisites now use that tool for upstream C-only cache identity,
  snapshot/validated restore, actual library probing, C companion construction,
  fresh Cargo verification drivers, dependency relocation and prepared manifests.
  The existing signed 9.0.1 C recipes remain; normal Windows/macOS prefix callers
  and Linux CI media prerequisites execute no project Python. Linux cold/warm
  execution and reference comparisons cover the local slice; native Windows
  MSVC/DLL and macOS signing gates remain required. Rebuild kits include the locked
  independent tool sources. This increment does not publish Preview 3.
- Pinned build-time BBDown preparation now uses `xtask prepare-bbdown`; CI sets
  up the pinned Rust toolchain/native linker before invoking it. The redundant
  Python producer and its dedicated tests are removed, with independent Rust
  pin/archive/HTTP/native-help coverage and Node caller/order checks. Pins,
  vendor layout and runtime behavior remain unchanged; native Windows/macOS
  tool and package gates remain required.
- Replaced Python desktop construction, macOS embedding, libav companion,
  cache and collector references are retired. Their useful package, provenance,
  compiler-output and failure coverage directly checks Rust entries with independent
  expectations. Local platform build wrappers also use the existing npm/Rust entry;
  locked Rust rebuild kits no longer need the Python companion reference.
- Native desktop package verification now uses `xtask verify-native-desktop` on
  each actual extracted Windows/macOS artifact. It independently checks layout,
  executes the supplied Host with private data/empty PATH, and checks bootstrap
  roles, HTTP/SSE and authorized shutdown/reopening. The redundant Python gate
  and installed-package test driver are retired; their installed import/recovery/
  refusal checks run in Rust against those artifacts. Linux actual-package execution
  and native verifier fixtures cover the local boundary; foreign native CI gates
  remain required.
- Desktop development/release construction contracts now run through
  `npm run test:desktop-build` in local workflows and CI, using actual xtask and
  compiled native fixtures with independent complete package expectations. The
  Python preparation/release drivers and shared construction expectations are
  retired; useful success, failure, isolation and preservation coverage remains.
  These fixture checks do not qualify foreign native packages or GUI behavior.
- Real-libav prerequisite and shell-wrapper contracts now use independent Node
  entries (`test:libav-prerequisites`, `test:libav-wrapper`); the two Python
  drivers are retired. Required native checks run after CI prepares the Linux
  prefix and fail on missing inputs. Actual library facts, C shim/sanitizers,
  dependency closure, C-only cache and rejected-restore preservation remain
  covered; recording wrapper checks do not qualify foreign packages.
- Explicit media comparison/fixture generation now uses Node with current native
  Cargo artifacts; its Python drivers are retired. Actual Linux corpus, packet,
  remux, PCM and lifecycle checks retain same-build external test oracles and
  independent expectations; those oracles remain outside the product prefix.
- Native Host business HTTP/startup/source/queue/storage/export/admin and
  login-cancellation regressions now use Node and actual native processes;
  seven Python suites and their transport are retired. Linux execution covers
  the local boundary; native foreign package/GUI acceptance remains separate.
- Frontend behavior/source contracts now use `test:frontend`; their Python drivers
  are retired. Remote workflow validation and local asset-copy checks use Node
  and PowerShell. Signalsmith vendoring and aria2 metadata generation/verification
  use Node, with pinned bytes/layouts and offline publication failure coverage.
  Native GUI/signing and actual CI evidence remain separate; AWS CLI publication
  retains its third-party Python dependency.
- Native HTTP orchestration, the read-only Remote SSE load tool and manual
  title checks use Node/Rust; their Python entries are retired without adding
  authentication or mutation capabilities to the load tool.
- Native catalog and macOS shell/process regression orchestration use Node and
  actual Cargo/native artifacts. Retired packaged-FFmpeg/Python-FFI product
  expectations are replaced by the existing native package gate. macOS GUI,
  signatures and archive acceptance still require native runners.
- Consolidated Preview 3 retirement continues through remaining auxiliary callers
  and legacy Host/FFI test consumers. Image/QR and login service tests use actual
  native artifacts with independent decoding; their Python suites and image-test
  dependencies are retired. Remaining source-adapter failure guards stay explicit.
  Pure selection/binding policies run directly in Rust; rendered native ratings
  use a required Linux Node/browser gate with isolated providers.
  Useful behavior coverage remains required.
  Native desktop media/browser orchestration also uses Node with real libav,
  synthetic test-only media and compiled tool fixtures; its Python driver is
  retired. Shared-profile DSP and foreign native acceptance remain explicit
  separate evidence, not implied by the portable suite.
  Third-party rebuild exceptions and
  remaining Python callers stay explicit; do not hide Python inside Actions/containers.
  The standalone monthly Catalog CLI and Source maintenance execution now belong
  to Rust; the Source Host retains only validated transport. Local fixture tests
  protect its full options without uploading to production services.
  Playlist lifecycle/concurrency regressions run directly against Rust AppState;
  their Python drivers and unused playlist/delay policy bridges are retired.
  Real native Host tests retain persisted roster/queue and restart assertions.
  Transport HTTP/browser regressions use `test:native-transport` with actual
  native Host, Chromium/RTC and local upstream barriers; Python drivers are
  retired. Loopback signaling does not qualify public RTC or foreign platforms.
- Remaining retirement: supported Source HTTP/FFI transport, yt-dlp orchestration,
  explicit media-CLI compatibility and their smoke/failure tests still require
  Python. The native Host deliberately disables yt-dlp; changing the Source
  launcher alone cannot retire those responsibilities without losing behavior.
  Remove those consumers and project-owned CI
  Python dependencies while preserving useful coverage. The long-term target
  is development/build/verification/CI without project-owned Python requirements;
  rewriting every Python test or legacy adapter is not a v0.8 release gate.
  Retire code only after checking consumers; preserve bundle/storage layouts,
  update contracts and public APIs.
- Keep backend state and new business functionality Rust-owned. Preserve
  compatibility through narrow adapters and validated snapshots.
- Stabilize desktop playback, fullscreen, audience windows, updates and
  persistence against the approved desktop behavior baseline.
- Preview 3 concentrates safely completed migration and source retirement
  alongside Preview 2 desktop experience fixes; keep product/build changes
  limited during subsequent stabilization. Stable v0.8 requires reliable desktop
  behavior, preserved data/layout and an accurately described upgrade path.
- Share frontend components, actions and layout definitions across desktop
  and Android Host, local Remote and public Remote, with narrow platform
  adapters and separate role privileges. See [shared Host UI](shared-host-ui.md).
- Continue device validation for the Android Host preview. Desktop release
  acceptance remains separate from mobile and casting maturity.

### Downloading and media

- Rust Native is the default downloader. Keep download scheduling, retries,
  cancellation, media validation and final publication in shared Rust services.
- Maintain and validate the independent Rust HTTP/HTTPS downloader, including
  concurrent range transfers, bounded retries and atomic publication. Extend
  resume, proxy support and crash recovery as actual use cases require.
- Use in-process libav for packaged media operations. Native desktop bundles
  carry no FFmpeg/ffprobe executables; retained source-mode compatibility
  routes remain explicit.
- Replace only the BBDown behavior bilikara needs, using existing BBDown
  behavior as a compatibility reference. BBDown and DownKyi/aria2c remain
  explicit transition alternatives while the native path is validated.
- Mobile production uses shared Rust services without Python or sidecar CLI
  dependencies.

### Casting and mobile

- Build casting around Rust media output served through stable local HTTP URLs
  with Range support.
- Introduce shared `CastSession`, `CastTarget` and `CastController` abstractions,
  then validate SSDP/DLNA discovery and playback on actual receivers.
- Preserve local Host playback and Remote serving while improving mobile
  lifecycle, background operation and local-network permissions.
- DLNA media casting and operating-system screen mirroring are separate
  capabilities. Broader mobile/casting scope is set from validated results.

### UI rules and shared-component consistency

Refine bilikara's own UI rules and shared components using official design
guidance in this reference priority order:

1. [Apple Human Interface Guidelines (HIG)](https://developer.apple.com/design/human-interface-guidelines)
2. [Microsoft Fluent](https://fluent2.microsoft.design/)
3. [Google Material Design](https://m3.material.io/)

- Audit component roles and action hierarchy, typography, control geometry,
  spacing, alignment, nested corners, surfaces and visual layering.
- Review hover, pressed, focus, selected, disabled and busy states, search and
  dismissal behavior, keyboard/touch input, accessibility and reduced motion.
- Keep Host, local Remote and public Remote consistent across languages,
  themes and viewport sizes, while preserving desktop and touch workflows.
- Apply the reference order where guidance fits the actual use case. Existing
  approved UI behavior remains the baseline; proposed visual changes receive
  a before/after comparison, and approved decisions are recorded by component
  role in `AGENTS.md` and implemented through shared definitions.

## v1.0.0 milestone

v1.0.0 is a product-maturity milestone. It requires a nearly complete intended
feature set, a coherent and unified UI, stable desktop and mobile Host behavior,
mature casting, acceptable migration and compatibility behavior, and
release-quality reliability. The number of intermediate releases is determined
by actual progress.
