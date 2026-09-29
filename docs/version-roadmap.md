# Version roadmap

This roadmap records current confirmed direction and future product goals.
Individual changes are scoped from actual validation results; no release dates
or provisional version allocations are assigned. Current desktop setup,
storage and migration details belong in [native desktop launch and bundles](native-desktop.md).

## Current direction

### v0.8.0 — Rust core convergence and release stabilization

- Native desktop bundles use the Rust HTTP/SSE Host and one authoritative Rust
  `AppState`. Python remains a legacy transport/compatibility adapter and is
  not included in native desktop bundles.
- Keep backend state and new business functionality Rust-owned. Preserve
  compatibility through narrow adapters and validated snapshots.
- Stabilize desktop playback, fullscreen, audience windows, updates and
  persistence against the approved desktop behavior baseline.
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
