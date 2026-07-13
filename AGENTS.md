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
- `bilikara/`: Python Host application engine. Handles HTTP API routing (`http.server.ThreadingHTTPServer`), state management (`AppContext`), persistence (`PlaylistStore`), download management (`BBDown`, `FFmpeg`), version checks/updates, and Python reference fallbacks for migrated business logic.
- `rust/`: Shared typed Rust domain core crate (`bilikara_rust`), compiled as both `cdylib` (for CFFI loading in Python) and `rlib` (for native Rust crate callers). Implements pure, deterministic business logic domains.
- `src-tauri/`: Tauri 2 desktop shell providing native windowing, system tray integration, and cross-platform desktop application packaging.
- `tests/`: Project test suite using standard Python `unittest`. Includes direct unit tests, integration tests enforcing native library loading (`BILIKARA_REQUIRE_RUST_LIB=1`), and tests that launch Node.js scripts to evaluate frontend JavaScript behavior.

## 3. Rust Migration Decision Boundary

Before implementing new Python-side business logic, apply this classification rule to decide its target layer.

A business rule should normally be implemented in the typed Rust domain (`rust/`) first when **all** of the following criteria are met:

1. **Immutable Input**: It receives a complete, self-contained, immutable value model.
2. **Deterministic**: Given the same inputs, it always produces the exact same output.
3. **Pure Arithmetic / Policy**: It performs **no** network, filesystem, subprocess, environment variable, system clock, thread, mutex lock, or mutable state access.
4. **Structured Decision**: It returns a structured decision, calculation result, or candidate ranking.
5. **Canonical Policy**: It represents canonical application policy or is useful across multiple host environments.

When migrating a rule to Rust:
- **Reference Fallback**: Retain the complete Python implementation as a reference fallback.
- **Output Validation**: Validate native Rust outputs before applying decisions to application state.
- **Semantic Error Handling**: Distinguish valid domain-level empty/`no_match` decisions from backend, JSON, or FFI execution failures.
- **Separation of Concerns**: Keep pure typed domain logic separate from `serde`, JSON adapters, and FFI wire exports.
- **ABI Compatibility**: Keep additive FFI exports ABI-compatible unless a deliberate FFI ABI migration is requested.

## 4. Logic Outside the Pure Rust Domain Core

Keep the following operations in their respective Host (Python / Tauri) or UI (JavaScript) layers:

- DOM event handling, button states, modal behavior, toast notifications, and UI rendering (`static/`).
- HTTP request/response routing, SSE connection lifecycle, cookies, URL fetching, and API endpoints (`bilikara/`).
- Filesystem I/O, archive extraction, font discovery, and system paths.
- Subprocess execution and management for `BBDown`, `yt-dlp`, `aria2c`, `FFmpeg`, or `ffprobe`.
- Host runtime capability detection and environment variable evaluation.
- Real-time clock acquisition and timestamping.
- Mutable `PlaylistStore` state mutations, disk persistence, locks, queue ordering, cache scheduling, retries, and cancellation logic.
- Tauri application lifecycle, native menus, and OS shell integrations (`src-tauri/`).

*Note: The presence of Python production code does not by itself imply Rust migration debt. Operational, I/O, and stateful logic belong in the Python/Host layer.*

## 5. UI Asynchronous-Action Policy

For UI actions that trigger asynchronous operations or backend side-effects:

1. **Immediate Feedback**: Disable the clicked button immediately.
2. **Accessibility**: Set `aria-busy="true"` on the active element.
3. **Loading Label**: Show an existing translated loading label where appropriate (e.g., `t("gatcha.adding")`, `t("search.adding")`).
4. **Duplicate Protection**: Reject repeated clicks or activations while the Promise is in flight.
5. **Clean Restoration**: In a `finally` block, restore the original disabled state, remove `aria-busy`, and restore original button text.
6. **No Fixed Timers**: Do **not** use short `setTimeout` timers to prematurely re-enable controls while the backend request is still active.

*Exemption*: Do **not** apply busy guards to immediate UI actions such as modal open/close, accordion expand/collapse, tab switching, fullscreen toggle, mute, or local-only view toggles.

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
| `store.py` | `PlaylistStore` managing JSON state persistence (`data/state.json`). |
| `bilibili.py` | Bilibili API querying, metadata parsing, media-page selection wrapper. |
| `cache.py` | Orchestration of `BBDown` downloads and `FFmpeg` audio extraction. |
| `rust_backend.py` | Native FFI loader, JSON payload validation, Python reference fallbacks. |
| `updater.py` | GitHub release checking, semver comparison, update asset resolution. |
| `config.py` | Global settings, path resolution, runtime tool discovery. |
| `models.py` | Python data models (`PlaylistItem`, `VideoPage`, etc.). |

### Typed Rust Core (`rust/`)
| File / Module | Purpose |
| :--- | :--- |
| `src/lib.rs` | Domain API exports (`rlib`) and FFI C-ABI entrypoints (`cdylib`). |
| `src/media_page_selection.rs` | Pure matching and ranking algorithm for video pages. |
| `src/audio_binding.rs` | Dual-audio and instrumental variant pairing policy. |
| `src/release_selection.rs` | Semantic version sorting and release filtering rules. |
| `src/asset_selection.rs` | Update package scoring by platform and architecture. |
| `src/ffi.rs` | FFI wrapper utilities, memory safety helpers, panic containment. |

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
