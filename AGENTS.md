# AGENTS.md - Bilikara Agent Development Guide

This document provides operational guidance, architectural rules, and validation standards for automated coding agents working on the Bilikara codebase.

## 1. Scope and Precedence

- **Repository-Wide Default**: This root `AGENTS.md` applies across the entire repository.
- **Nested Instructions**: Before modifying files in a sub-directory, agents must search for any nested `AGENTS.md` files within that subtree.
- **Precedence Rule**: The closest applicable `AGENTS.md` file takes precedence over root guidance.
- **User Instruction Precedence**: The user's explicit task instructions take precedence over general repository guidance.

## 2. Current Architecture

Bilikara is a Bilibili-based Karaoke system consisting of a Host (PC display & desktop application) and a Remote (Mobile controller).

The architecture consists of the following primary layers:

- `static/`: Frontend Host and Remote user interfaces built with vanilla JavaScript, HTML5, and CSS3. UI components use state-driven re-rendering and subscribe to real-time state updates via Server-Sent Events (SSE) at `/api/events`. Bundled and served by the Host server or packaged into the Tauri desktop shell.
- `bilikara/`: Python Host transport and compatibility adapter. Handles HTTP/SSE routing (`http.server.ThreadingHTTPServer`), persistence I/O derived from Rust snapshots, trusted tool configuration, BBDown preparation and retained yt-dlp orchestration/source-mode media CLI compatibility, version checks/updates, and frozen Python compatibility references. `PlaylistStore` is an AppState/persistence adapter, not a mutable state authority.
- `rust/`: Shared typed Rust domain core crate (`bilikara_rust`), compiled as both `cdylib` (for CFFI loading in Python) and `rlib` (for native Rust crate callers). Implements pure, deterministic business logic domains.
- `rust-runtime/`: Typed Rust runtime and application-services crate (`bilikara_runtime`), compiled as both `cdylib` and `rlib`. Owns the process-wide authoritative `AppState`, Rust Native cache/runtime services, operational I/O such as the independent HTTP media downloader, and a temporary C ABI for the Python Host adapter.
- `src-tauri/`: Tauri 2 desktop shell providing native windowing, system tray integration, and cross-platform desktop application packaging.
- `tests/`: Project test suite using standard Python `unittest`. Includes direct unit tests, integration tests enforcing native library loading (`BILIKARA_REQUIRE_RUST_LIB=1`), and tests that launch Node.js scripts to evaluate frontend JavaScript behavior.

## 3. Backend Ownership After Phase 2

Phase 2 is complete. Its existing Python reference implementations may remain
frozen for compatibility and historical equivalence testing, but its rule of
creating a complete Python fallback for each Rust migration no longer applies
to new work.

For all **new backend or business functionality** from this point forward:

- Rust is the authoritative implementation.
- Do not add an equivalent Python business-rule implementation or a new
  `_py_*` mirror of a new Rust capability.
- Python may adapt objects, transport FFI payloads, validate native results,
  and perform the current v0.7 I/O/orchestration listed in Section 4. That glue
  must not independently recompute the new policy.
- A new Rust-only capability must fail explicitly or report itself unavailable
  when Rust cannot execute it. Do not silently add a Python semantic fallback.
- New stateful backend features must extend the authoritative Rust `AppState`;
  they must not create Python-owned state or a parallel authority.
- This boundary is not a new "Phase 3." The current architectural milestone is
  **v0.8 Rust Core Convergence / Preview**.

Pure deterministic policy remains a good small Rust-domain boundary when all
of the following criteria are met:

1. **Immutable Input**: It receives a complete, self-contained, immutable value model.
2. **Deterministic**: Given the same inputs, it always produces the exact same output.
3. **Pure Arithmetic / Policy**: It performs **no** network, filesystem, subprocess, environment variable, system clock, thread, mutex lock, or mutable state access.
4. **Structured Decision**: It returns a structured decision, calculation result, or candidate ranking.
5. **Canonical Policy**: It represents canonical application policy or is useful across multiple host environments.

When adding such a Rust-authoritative rule:
- **Frozen Compatibility Surface**: Leave pre-existing Python references unchanged unless the task explicitly requires modifying them; do not create a new one.
- **Output Validation**: Validate native Rust outputs before applying decisions to application state.
- **Semantic Error Handling**: Distinguish valid domain-level empty/`no_match` decisions from backend, JSON, or FFI execution failures.
- **Separation of Concerns**: Keep pure typed domain logic separate from `serde`, JSON adapters, and FFI wire exports.
- **ABI Compatibility**: Keep additive FFI exports ABI-compatible unless a deliberate FFI ABI migration is requested.

## 4. Rust AppState Authority and Retained Host/UI Responsibilities

The process-wide Rust `AppState` is the only authoritative mutable application
state. Playlist, session, current-item, player-setting, history, and playlist
item cache projections are committed under its single serialized lock. Python
may cache defensive read-only projections and persist Rust snapshots, but it
must not independently mutate or recompute this state.

Rust AppState availability and initialization are startup requirements. There
is no whole-application Python Core fallback. The default desktop launcher uses
one supervised `bilikara-desktop-host` Rust process. Native desktop bundles ship
no Python runtime, PyInstaller payload or temporary Python FFI libraries.
Windows desktop builds keep application data in `runtime/data/`, media cache in
`runtime/data/cache/`, and shell logs, window preferences and WebView storage
inside the installation's `runtime/` by default. Do not rename these user-facing
directories merely to reflect the backend implementation language. Do not scan or
automatically reopen AppData records; explicit data/import overrides remain
available for isolated tests or a deliberate import.
`BILIKARA_NATIVE_DATA_DIR` (and the earlier preview-directory alias) overrides
the native data root; it does not select a different backend. See
`docs/native-desktop.md` for layouts, builds, storage and explicit legacy import.
Packaged Windows/macOS update installation uses the shared Rust installer and
private shell lifecycle boundary. These contracts do not establish full Preview 2
feature parity or release acceptance.

The retained legacy Python Host has the following adapter responsibilities.
They are not dependencies of normal native desktop launch or packaging; the
native product uses the shared Rust services and native Host adapters. Keep UI
and shell responsibilities in their existing layers:

- DOM event handling, button states, modal behavior, toast notifications, and UI rendering (`static/`).
- HTTP request/response routing, SSE connection lifecycle, cookies, URL fetching, and API endpoints (`bilikara/`).
- Retained Host filesystem I/O, archive extraction, and system paths. Export font discovery/rendering and archive assembly belong to Rust Runtime.
- Retained subprocess execution and management for `yt-dlp` and existing source-mode media CLI compatibility. BBDown and DownKyi/aria2c download execution is shared Rust-owned. Python retains BBDown preparation and trusted configuration/login/status transport; aria2c preparation also belongs to Rust. Packaged FFmpeg/ffprobe executables remain retired.
- Host runtime capability detection and environment variable evaluation.
- Real-time clock acquisition and timestamping.
- Atomic state-file reads/writes, legacy-shape loading, backup/archive file handling, and persistence-error reporting. All semantic data written by Python is derived from Rust snapshots.
- Retained cache scheduling, retries, cancellation, and execution for explicit yt-dlp and its existing media CLI compatibility. Its projections are committed through Rust AppState. Native, BBDown and DownKyi admissions, execution and publication are owned by shared `rust-runtime` services.
- Tauri application lifecycle, native menus, and OS shell integrations (`src-tauri/`).

These are retained adapter and I/O responsibilities, not Python application-core
ownership. Existing operational code may be maintained for release safety, but
new stateful backend capabilities belong in Rust AppState.

P03 releases only the former `bilikara/playlist_export.py` subsystem freeze.
CSV/image interpretation, layout, font discovery/fallback/cache/prewarm, PNG and
multi-page ZIP encoding now belong to Rust. Python retains the public entry
signatures, configured asset-root transport, native output validation and HTTP
responses. The renderer and prewarm share Rust font resources; there is no
Pillow renderer or Python semantic fallback. All other frozen references and
public-interface retention decisions remain unchanged.

## 5. UI Asynchronous-Action Policy

For UI actions that trigger asynchronous operations or backend side-effects:

1. **Immediate Feedback**: Disable the clicked button immediately.
2. **Accessibility**: Set `aria-busy="true"` on the active element.
3. **Loading Label**: Show an existing translated loading label where appropriate (e.g., `t("gatcha.adding")`, `t("search.adding")`).
4. **Duplicate Protection**: Reject repeated clicks or activations while the Promise is in flight.
5. **Clean Restoration**: In a `finally` block, restore the original disabled state, remove `aria-busy`, and restore original button text.
6. **No Fixed Timers**: Do **not** use short `setTimeout` timers to prematurely re-enable controls while the backend request is still active.

*Exemption*: Do **not** apply busy guards to immediate UI actions such as modal open/close, accordion expand/collapse, tab switching, fullscreen toggle, mute, or local-only view toggles.

### Desktop Baseline for Shared Host Work

- Use the shipped **v0.8.0-preview.1 Python desktop Host** as the behavior baseline, together with the user's subsequently approved changes. The Rust/Android preview implementation is not a replacement acceptance baseline.
- Android should reuse established desktop components, actions and base styles. Adopt a more complete Android implementation into the shared component only when it preserves desktop workflows and adds a demonstrated improvement (for example, accessible touch actions alongside desktop dragging).
- Treat available space, input method and platform capabilities separately. A narrow desktop viewport must not acquire Android-only workflow restrictions, lose mouse/keyboard operations, or hide supported desktop features. Touch-target rules must not overflow native desktop window chrome.
- Share layout definitions without copying whole platform screens. Keep essential platform adaptations narrow, preserve existing media nodes and state, and retain user-approved responsive navigation and Host/Remote styling changes.
- Validate shared changes against desktop behavior first, including narrow windows and mixed mouse/touch input, then validate Android adaptations. Record intentional behavior changes explicitly; do not remove desktop functionality merely because an Android or Rust preview omitted it.

### Shared Host / Remote Visual Rules

- Floating panels use the shared `static/ui-surfaces.css` surface: **18px corners**, a theme-aware translucent fill, shadow, and background blur confined to the panel. Keep opacity in the shared token; do not add per-dialog or per-client opacity overrides.
- Host dialogs do not dim or blur the surrounding page or source card. Remote's large modal panels (identity/room entry, details, ratings, selection/export dialogs and playback sheet) use a theme-aware page-wide dimmed backdrop with opacity fade-in/fade-out and no surrounding-page blur to distinguish them from its stacked cards. Small anchored controls such as menus, tooltips and volume editors use shadow without an additional dimmed or blurred layer. Remote modals and the playback sheet lock background scrolling, including scroll anchoring caused by background updates (the top menu is exempt); the playback sheet slides up from the bottom. Landscape uses a complete 18px rounded card inset on all sides beyond the safe area. In narrow portrait layouts the panel background extends into the bottom safe area with rounded bottom corners there, while controls remain above that area; without a bottom inset it may meet the bottom edge with square corners. Keep these client-specific backdrop rules in `static/ui-surfaces.css`; preserve keyboard focus, Escape/close behavior, and protection against clicks reaching the page beneath an open modal.
- Where a panel has an icon close action, place its single close button inside the panel's upper-right corner. Use the shared opaque, contrasting close surface so it remains recognizable over cover art without hovering. Clicking must not scale the button; Remote close buttons have no hover effect. Preserve keyboard focus indicators and existing non-dismissible entry gates.
- Keep motion consistent within each component type and respect reduced-motion settings. Panel entry/exit motion is separate from button feedback; do not add button scaling to emphasize a close action.
- Request navigation on Host and Remote shares `static/request-tabs.css`, including typography, selected states, spacing, and theme colors. Wide Host layouts may retain primary and secondary rows; portrait layouts use the compact contextual row with a back action. Reuse the same visual rules in both arrangements.
- These presentation changes must not recreate or reparent media elements, rebuild the pitch graph, reset drafts, or attach duplicate event handlers.

## 6. Change Discipline

- **Context Inspection**: Inspect the latest branch HEAD and `git status` before editing files.
- **Minimal Changes**: Make the smallest coherent change necessary to accomplish the user request.
- **Domain Boundaries**: Do not begin work on an unrelated business domain or migration area.
- **Behavior Preservation**: Preserve existing fallback behaviors and user-visible functionality unless explicitly directed to alter them.
- **Test Quality**: Never weaken, disable, or delete assertions to force a passing build.
- **Reviewability**: Each business-rule domain change should remain independently reviewable and revertible.
- **Git Hygiene**: Do not create unexpected branches, worktrees, tags, release builds, or remote pushes unless requested. Never rewrite published history without an explicit request and backup.

## 7. Validation Standards

Run targeted checks during feature development, and execute the full release-quality gate before completing cross-layer work or release preparation.

### Full Release Validation Gate

```bash
# 1. Rust Domain Checks
cd rust
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cd ..

# 1b. Rust Runtime Infrastructure Checks
cd rust-runtime
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cd ..

# 2. Python Test Suite (forcing native library verification)
BILIKARA_REQUIRE_RUST_LIB=1 \
python -m unittest discover -s tests -v

# 3. Python Compilation Checks
python -m compileall -q bilikara
python -m py_compile start_bilikara.py build_bundle.py

# 4. Tauri Shell Checks
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cd ..

# 5. Frontend & Asset Build
npm ci
npm run build

# 6. Formatting & Diff Check
git diff --check
```

*Development Guidance*: Narrow unit tests (e.g. `cargo test` in `rust/` or targeted `unittest` files) may be used for rapid feedback during development. However, full release validation must pass cleanly before finalizing tasks.

## 8. Final-Report Requirements

When completing a task, agents must report:

1. **Files Changed**: Complete list of modified, added, or removed files.
2. **Architectural Classification**: Classification of any newly added or modified Python/Rust logic.
3. **Validation Commands Run**: Exact commands executed and their pass/fail status.
4. **Skipped / Unavailable Validation**: Any checks that were skipped along with exact technical reasons.
5. **Commit Details**: Commit SHA and message if a git commit was created.
6. **Push Status**: Confirmation of whether any remote push occurred (must be "No" unless requested).

## 9. Directory and Module Map

### Python Host Layer (`bilikara/`)
| File | Purpose |
| :--- | :--- |
| `server.py` | HTTP Server, API endpoints, SSE event hub (`AppContext`). |
| `store.py` | `PlaylistStore` AppState/FFI adapter, defensive read-only projection, and atomic JSON persistence derived from Rust snapshots. |
| `bilibili.py` | Bilibili API querying, metadata parsing, media-page selection wrapper; DASH is a thin adapter to the Rust Bilibili service for DownKyi too. Shared Gatcha/maintenance WBI helpers remain. |
| `cache.py` | Rust CacheRuntime configuration/state projection plus BBDown preparation/login adapters, retained yt-dlp orchestration and existing source-mode media CLI compatibility. |
| `rust_backend.py` | Native FFI loader, JSON payload validation, frozen compatibility fallbacks for older domains, and fail-closed adapters for new Rust-authoritative capabilities. |
| `updater.py` | GitHub release checking, semver comparison, update asset resolution. |
| `config.py` | Global settings, path resolution, runtime tool discovery. |
| `models.py` | Python data models (`PlaylistItem`, `VideoPage`, etc.). |

### Typed Rust Core (`rust/`)
| File / Module | Purpose |
| :--- | :--- |
| `src/lib.rs` | Domain API exports (`rlib`) and FFI C-ABI entrypoints (`cdylib`). |
| `src/media_page_selection.rs` | Pure matching and ranking algorithm for video pages. |
| `src/audio_binding.rs` | Dual-audio and instrumental variant pairing policy. |
| `src/download_candidate_planning.rs` | Pure updater download URL construction, source labeling, ordering, and deduplication policy. |
| `src/media_download_candidate_planning.rs` | Pure DASH and preferred-audio primary/backup URL flattening, identity, and ordering policy. |
| `src/tool_download_candidate_planning.rs` | Pure BBDown, yt-dlp, and aria2c asset fallback construction, labeling, ordering, and deduplication policy. |
| `src/quality_policy.rs` | Pure quality-label/ID normalization plus BBDown and yt-dlp preference intent. |
| `src/video_stream_ranking.rs` | Pure DASH video codec, quality, bandwidth, AVC-cap, fallback, and stable ranking policy. |
| `src/audio_stream_ranking.rs` | Pure regular DASH audio quality ordering, Hi-Res filtering/fallback, and stable ties. |
| `src/preferred_audio_source_binding.rs` | Pure first-regular, FLAC, and Dolby preferred-audio source binding without regular ranking. |
| `src/cache_planning.rs` | Pure cache-window desired, pending, retention, and preemption planning policy. |
| `src/playlist_planning.rs` | Pure playlist ordering and duplicate-identity planning policy. |
| `src/av_delay.rs` | Pure global/local AV-delay transition, clamping, and lock-button state policy. |
| `src/tool_prepare_policy.rs` | Rust-authoritative deterministic tool prepare routing from immutable host-gathered facts. |
| `src/release_selection.rs` | Semantic version sorting and release filtering rules. |
| `src/asset_selection.rs` | Update package scoring by platform and architecture. |
| `src/ffi.rs` | FFI wrapper utilities, memory safety helpers, panic containment. |

### Rust Runtime Infrastructure (`rust-runtime/`)
| File / Module | Purpose |
| :--- | :--- |
| `src/app_state.rs` | Process-wide authoritative mutable application state, strict commands, revision/generation tracking, snapshots, and persistence effects. |
| `src/http_downloader.rs` | Typed HTTP transfer, URL fallback, progress, cancellation, response validation, and atomic publication. |
| `src/cache_runtime.rs` | Rust Native cache queues, primary/urgent workers, retries, cancellation, multi-track validation, and atomic cache-group publication. |
| `src/media_backend.rs` | Native media probing and MP4/FLAC normalization for Rust Native playback artifacts. |
| `src/bilibili_service.rs` | Bilibili WBI signing, DASH resolution, and redirect handling. |
| `src/gatcha_repository.rs` | Gacha configuration, persistence, browsing, candidate selection, and Bilibili refresh operations. |
| `src/cloudflare_service.rs` | Cloudflare API execution, pool-entry normalization, and bounded background append scheduling. |
| `src/status_service.rs` | Bilibili login state and Gacha refresh lease/status ownership. |
| `src/update_installer.rs` | Update extraction, helper generation, and helper launch validation. |
| `src/diagnostics.rs` | Diagnostic sanitization and artifact assembly. |
| `src/playlist_export.rs` and `src/playlist_export/` | Complete CSV/image export service, local-time formatting, reusable fonts, text layout/rasterization, PNG/ZIP and coarse wire adaptation; no AppState lock during rendering. |
| `src/networking.rs` | Native LAN interface discovery and address ranking. |
| `src/ffi.rs` | Temporary C ABI, including the additive schema-v1 AppState request entry used by the Python Host adapter. |

### Tauri Shell Layer (`src-tauri/`)
| File / Module | Purpose |
| :--- | :--- |
| `src/main.rs` | Tauri application entry point and windowing initialization. |
| `tauri.conf.json` | Tauri desktop app configuration, permissions, and build targets. |

### Frontend Layer (`static/`)
| File / Module | Purpose |
| :--- | :--- |
| `index.html` / `app.js` | Host playback view, video/audio sync engine, UI state listeners. |
| `remote.html` / `remote.js` | Mobile controller UI, search, queueing, remote commands. |
| `export-guard.js` | Asynchronous action concurrency guard helper. |
| `styles.css` / `remote.css` | CSS stylesheets for Host and Remote views. |
