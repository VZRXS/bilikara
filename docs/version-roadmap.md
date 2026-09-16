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
- Preview stabilization also includes Rust-authoritative BBDown prepare
  routing. This focused policy is not a new "Phase 3" and does not begin the
  full stateful-core migration.
- v0.7 is not the final Rust runtime architecture.

### v0.8.0 — Rust Core Convergence / Preview

The confirmed objective is to make the Rust runtime the authoritative
application core instead of using Rust only as a library of deterministic
rules. The first AppState cutover is now established:

- One process-wide Rust `AppState` owns mutable session, playlist, current-item,
  player-setting, history, and playlist-item cache projection state under one
  serialized lock, with monotonic revision and generation fields.
- Python `PlaylistStore` is now a strict AppState/FFI and persistence adapter.
  Its projection is read-only and all persisted semantic state is derived from
  Rust snapshots.
- The Python HTTP/SSE Host, external-tool orchestration, filesystem I/O, and
  compatibility payload adapter remain packaged. Python is not an alternate
  application core.
- Rust AppState capability and initialization are startup requirements. There
  is no whole-application Python Core fallback, no startup selection between
  Rust and Python state authorities, and no per-operation stateful fallback.
- The D0 compiled-only desktop build/launch contract remains separate work;
  this cutover does not remove Python or rewrite the release launch contract.
- The current application-service slice in `rust-runtime` owns the Bilibili
  QR-login state machine and generation guard, Bilibili WBI/DASH and redirect
  I/O, Rust Native cache queues/retries/cancellation/validated publication,
  Gacha task status plus repository/network refresh, Cloudflare request
  execution and bounded background append scheduling, update transfer and
  installation preparation, diagnostics assembly, and network selection.
  Python still supplies configuration facts, commits external-worker cache
  events through AppState, starts explicit external-tool workers, and adapts
  the temporary C ABI.
- Continue converging application services behind the Rust authority. The
  default product retains Python HTTP/SSE transport. The explicitly authorized
  desktop Step 1 development opt-in below reuses the merged native Rust Host;
  it does not switch the default backend or finish distribution retirement.
- Do not permit split-brain state or reintroduce a Python state authority.
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
- Media backend: S1–S3, M1–M3 and M5 MP4/FLAC capabilities are accepted. Current
  M6 integrates default libav-first metadata, packet traversal, single-track
  H.264/AAC MP4 copy/fast-start and FLAC-in-MP4 extraction in supported same-build
  packages. Rust owns routing; Pure Rust and operation-specific same-build CLI
  compatibility remain. `BILIKARA_MEDIA_BACKEND=legacy` at startup restores the
  previous routes without libav. DownKyi timestamp remux, BBDown's own explicit
  FFmpeg workflow and operations outside accepted profiles retain their paths.
  Linux trusted-prefix integration is locally testable; Windows x64 package
  execution needs Actions after review/push. Code review, Actions evidence and
  deferred manual playback are separate gates. No ARM64/macOS or historical
  Hi-Res acceptance is claimed. CLI stays packaged; original M7 removal is a
  later-version decision. Mobile production must not depend on CLI executables.

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


## Desktop Rust Host takeover — Step 1 local handoff

### Position and scope

Desktop comes first. This is the first executable development slice on top of
merged PR109, not another PR109 merge or an Android/iOS completion milestone.
The starting tree was clean at `95b4742` (`test: persist smoke evidence for
windowed desktop bundles`); no remaining-WBI local edits existed to preserve,
and no remaining-WBI task was repeated or made a prerequisite.

The opt-in keeps Tauri's backend-process boundary. The new
`bilikara-desktop-host` binary owns one Runtime/AppState and reuses native Host
HTTP/SSE, capability authentication, LAN/Internet dispatch, media ranges,
native checkpoint storage and Native cache. P04 metadata/binding, P02 QR login
and desktop BBDown.data parsing/publication, shared catalog search (including
its accepted Sheets fallback), player FIFO/head-ACK/incarnation/relative AV
rules, and desktop P03 export remain their existing Rust services. No C ABI,
Python Host, Python worker, or separately loaded runtime cdylib serves this path.

### Run the opt-in

From the repository, build the separate debug backend once, then launch the
existing desktop shell with the single explicit opt-in:

```sh
cargo build --manifest-path rust-runtime/Cargo.toml --locked --features native-host --bin bilikara-desktop-host
BILIKARA_DESKTOP_RUST_PREVIEW_DIR=/absolute/path/to/new-preview cargo run --manifest-path src-tauri/Cargo.toml --locked
```

The directory must be empty/new or carry a valid marker from an earlier preview
launch. A nonempty unmarked directory is refused, without import/conversion or
cleanup of its contents. Credentials (`BBDown.data`), native checkpoints,
preferences, local library files, media and export scratch stay under that root.
No configured production cookie or legacy records are automatically imported.
Preview geometry never reads the default product's configuration. Persisted
startup diagnostics require the existing explicit development log override;
otherwise preview diagnostics stay on the launcher's output stream.

Removing the environment variable preserves the normal launcher, its features
and its release packaging. The preview binary is feature-gated and is not added
to default bundles. This does not claim any Python files have left distribution.

The current shared Host and Remote assets are served directly. The native
backend marker, desktop/Android platform marker, and Android layout are separate.
Desktop keeps its work rail/window controls and uses P03 through the existing
export hook and Tauri/browser download paths. Android navigation, visibility
pause, installer, and Kotlin export hooks do not activate on desktop. Android's
renderer remains intact. Native restart-choice UI is shared without activating
Android navigation.

Preview scope: Native downloading, session users, metadata and automatic/manual
binding, queue/player/SSE, read-only shared search, Internet Remote dispatch, and
CSV/PNG/multi-page ZIP exports. Unsupported tool/update/maintenance/catalog-write
operations explicitly report preview unavailability; Host-only admission still
runs first. External links, full diagnostics-package UX, updater/maintenance,
existing-record import, codec/tool preference parity, distribution cutover and
remaining desktop parity stay for the next slice. Physical desktop multi-display
and native save-dialog platform matrices are not claimed by this slice.

### Lifecycle and transport findings

The parent receives a base URL and a separately validated same-origin bootstrap
capability. Only the private child pipe carries the capability; diagnostics
record the base address. Tauri retains the Host cookie internally for its
existing restricted native export transport, never accepting it from JS.

The native path uses HTTP Content-Length framing. Python's existing write-half-
close convention is retained only for the default path: Hyper otherwise treats
that half-close as a disconnected caller before dispatch. Both actual Tauri
window-close paths now reap their backend and close the listener.

Stopping signals cancellation, bounds asynchronous connection draining, retires
and joins the listener/runtime and cache/login/library workers, then shuts down
AppState. Late metadata completion cannot commit after stop. Unix signals and
loss of the desktop parent also enter cleanup. A drain deadline is not shutdown
proof: process/thread joins and refused subsequent connections provide that proof.

### Python ownership distinction

- Bypassed by the preview serving path: `start_bilikara.py`, `bilikara/launcher.py`,
  `bilikara/server.py`/AppContext, `store.py`/PlaylistStore, `cache.py`/CacheManager,
  `bilibili.py`, `playlist_export.py`, Python login/catalog/Internet adapters and
  `rust_backend.py`/`rust_runtime.py` C-ABI loading.
- Still required by the default desktop product: its Python launcher/HTTP/SSE,
  persistence adapters, operational tool/updater/maintenance code and current
  bundled compatibility modules. The default product retains all current paths.
- Intentionally retained: historical `_py_*` and legacy task/test references,
  external-tool implementations, accepted S/M harnesses, and Android Kotlin
  rendering. Nothing was mass-deleted, retired from distribution, or relabelled
  as obsolete solely because preview bypasses it.
- New/modified Python code in this slice is test orchestration/fixtures only.
  Rust changes are Host runtime I/O/lifecycle, transport projections and existing
  service integration; no new Python policy mirror or separate state authority.

### Local validation and evidence

Local status: **DESKTOP_RUST_HOST_STEP1_LOCAL_VALIDATED_REVIEW_DEFERRED**.
Browser evidence is Playwright WebKit at
1440×1000 (Host) and 375×812 CSS pixels (Remote). The installed Chromium lacks
H.264/AAC support (`canPlayType` returns empty), so it was not used to claim media
success. Browser plugin was unavailable. Separate Linux Xvfb/Openbox checks launch
the real Tauri/WebKit desktop and close its actual window. Browser interaction
coverage is not represented as a Tauri save-dialog or physical-device matrix.

Network fixtures reuse P02 TLS trust/QR helpers and synthetic metadata/media;
they forward no external requests, submit no catalog/rating writes and do not
scan D1/Sheets. Protocol simulation uses the real dedicated Internet dispatch
and LAN HTTP against the same Host. Real DataChannel and physical cross-network
checks are not claimed. No Windows/macOS/mobile build, Actions run, deployment,
signing change, commit, push, merge, rebase, stash, branch or worktree was made.
Independent review is deferred to a later batch.

#### Commands and results (Ubuntu, 2026-09-15)

Commands below run from the repository root unless a working directory is
specified. Output redirection to `/tmp/desktop-step1-*.log` is omitted.

| Working directory | Exact command | Result |
| --- | --- | --- |
| `rust/` | `cargo fmt --check` | Pass |
| `rust/` | `cargo clippy --all-targets --locked -- -D warnings` | Pass |
| `rust/` | `cargo test --locked` | Pass: 218 tests |
| `rust/` | `cargo build --release --locked` | Pass |
| `rust-runtime/` | `cargo fmt --check` | Pass |
| `rust-runtime/` | `cargo clippy --all-targets --locked -- -D warnings` | Pass |
| `rust-runtime/` | `cargo test --locked` | First run: 224 passed, one HTTP downloader failure, 15 ignored; see retest below |
| root | `cargo test --manifest-path rust-runtime/Cargo.toml --locked http_downloader::tests::large_range_capable_response_uses_concurrent_segments` | Pass: isolated retest |
| root | `cargo test --manifest-path rust-runtime/Cargo.toml --locked -- --test-threads=2` | Pass: 225 tests, 15 existing ignored tests |
| root | `cargo build --manifest-path rust-runtime/Cargo.toml --release --locked` | Pass |
| root | `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --lib --locked -- --test-threads=2` | Pass: 261 tests, 15 existing ignored tests |
| root | `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --features native-host --locked -- -D warnings` | Pass, repeated after final Host-only admission correction |
| root | `cargo build --manifest-path rust-runtime/Cargo.toml --locked --features native-host --bin bilikara-desktop-host` | Pass |
| root | `python tests/run_native_host_http.py` | Pass: real HTTP regression, zero forwarded external requests |
| `src-tauri/` | `cargo fmt --check` | Pass |
| `src-tauri/` | `cargo clippy --all-targets --locked -- -D warnings` | Pass |
| `src-tauri/` | `cargo test --locked` | Pass: 80 tests; separate native integration explicitly run below |
| `src-tauri/` | `cargo build --release --locked` | Pass |
| root | `cargo test --manifest-path src-tauri/Cargo.toml --locked desktop_rust_entry_uses_authenticated_tauri_export_transport -- --ignored` | Pass: real native executable, Tauri CSV/PNG transport and shutdown |
| root | `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -v` | Initial run: 14 extracted-JS-helper failures; corrected without changing assertions |
| root | `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -p test_split_player_sync.py -v` | Pass: 111 tests after correction |
| root | `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -p test_export_download.py -v` | Pass: 12 tests after correction |
| root | `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -p test_native_host_frontend.py -v` | Pass: one test |
| root | `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -p 'test_tauri*py' -v` | Pass: eight tests |
| root | `BILIKARA_HOME=/tmp/bilikara-desktop-step1-python-home BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -v` | Final full gate: 1651 tests, OK, 15 platform/artifact skips |
| root | `python -m compileall -q bilikara` | Pass |
| root | `python -m py_compile start_bilikara.py build_bundle.py` | Pass |
| root | `npm ci` | Pass |
| root | `npm run build` | Pass; final rerun builds normal Linux deb/rpm/AppImage, no default backend or packaging configuration change |
| root | `python tests/run_desktop_launcher.py /tmp/bilikara-desktop-step1-launcher-final` | Pass: real Tauri default Python and opt-in Rust launches, window rendering, normal close, child reap and listener closure |
| root | `python tests/run_desktop_rust_host.py /tmp/bilikara-desktop-step1-final-evidence` | Pass: real executable and shared browser UI, local TLS/media fixtures, zero console errors |
| root | `cargo fmt --manifest-path rust-runtime/Cargo.toml --check` | Pass on final source tree |
| root | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Pass on final source tree |
| root | `git diff --check` | Pass |

The first default runtime test run reported a network error in the existing
concurrent-range fixture under concurrent build/test load. Its isolated retest
and the complete two-thread suite passed; no assertions or downloader policy
were changed. Frontend extraction tests caught a helper dependency introduced
by this slice; self-contained platform predicates fixed it before the final
full Python gate. Early browser setup attempts could not decode H.264 in the
installed Chromium; the final interaction suite uses WebKit with actual media
decoding. Early Linux window automation lacked a window manager; final launcher
evidence uses Openbox and normal Alt+F4, including the corrected native shutdown
framing contract.

The browser run exercises synthetic QR login and isolated BBDown.data, actual
user/add controls, automatic and manual binding, Native cache/media playback,
pause/play, track switching, next/stale-next, shared search and SSE updates.
LAN HTTP and dedicated Internet protocol simulation share one Host: relative
seeks of 7 and 11 seconds survive delayed metadata, premature/out-of-order ACK
does not remove the FIFO head, and control responses remain available while
metadata waits. A Remote update request remains forbidden. CSV, PNG, two-page
ZIP and browser download pass. Relaunch restores synthetic records/credentials;
in-flight login and an incomplete authenticated request cannot prevent confirmed
process exit/listener closure. The native child has no Python child, libpython,
or separately loaded runtime cdylib.

Local evidence (outside the repository; no cookies, tokens or capability URLs
in these summaries/screenshots):

- `/tmp/bilikara-desktop-step1-final-evidence/browser-summary.json`
- `/tmp/bilikara-desktop-step1-final-evidence/fixture-summary.json`
- `/tmp/bilikara-desktop-step1-final-evidence/desktop-playing.png`
- `/tmp/bilikara-desktop-step1-final-evidence/remote-375x812.png`
- `/tmp/bilikara-desktop-step1-final-evidence/desktop-queue.png`
- `/tmp/bilikara-desktop-step1-launcher-final/launcher-summary.json`
- `/tmp/bilikara-desktop-step1-launcher-final/rust-webview.png`
- `/tmp/bilikara-desktop-step1-launcher-final/default-webview.png`
- `/tmp/desktop-step1-python-final.log`
- `/tmp/desktop-step1-tauri-native-export.log`

#### Unavailable and intentionally separate checks

The 15 Python skips are: PowerShell asset sync (1), missing packaged macOS
backend executable (1), macOS-only packaged BBDown/FFmpeg/HTTPS/runtime/Tauri
checks (5), explicit aria2 package-download gate (1), accepted live media
companion/fixture tests (3), Win32 module enumeration (2), and PowerShell MSVC
license/smoke-wrapper checks (2). This Ubuntu environment cannot provide the
macOS/Windows platform checks. No Actions run was requested or triggered.

The 15 existing Rust ignored cases require separately provisioned accepted
same-build/old/fault companions, M1/M3/M5 artifacts, extracted packages,
generated live media, an explicit loader C-compiler harness, or the explicit
extended-AAC fixture export. They remain accepted S/M references and were not
reopened for this transport slice. The new Tauri native-export integration is
ignored by the default suite because it requires the separately built preview
binary; it was explicitly executed and passed here.

Real DataChannel, physical cross-network/device operation, Windows/macOS preview
execution, Android/iOS builds, multi-display behavior and the native save-dialog
matrix remain untested. Browser playback evidence and actual Tauri rendering/
launcher/export-transport evidence are reported separately above.

#### Complete file list and architectural classification

Added:

- `rust-runtime/src/bin/bilikara-desktop-host.rs`
- `rust-runtime/src/native_host/desktop.rs`
- `tests/live_desktop_rust_host.js`
- `tests/run_desktop_launcher.py`
- `tests/run_desktop_rust_host.py`

Modified:

- `AGENTS.md`
- `docs/version-roadmap.md`
- `rust-runtime/Cargo.toml`
- `rust-runtime/src/app_state/native_session.rs`
- `rust-runtime/src/desktop_login.rs`
- `rust-runtime/src/native_host/api.rs`
- `rust-runtime/src/native_host/cache.rs`
- `rust-runtime/src/native_host/files.rs`
- `rust-runtime/src/native_host/internet.rs`
- `rust-runtime/src/native_host/library.rs`
- `rust-runtime/src/native_host/login.rs`
- `rust-runtime/src/native_host/mod.rs`
- `rust-runtime/src/native_host/preferences.rs`
- `src-tauri/src/backend_download.rs`
- `src-tauri/src/backend_process.rs`
- `src-tauri/src/desktop_diagnostics.rs`
- `src-tauri/src/window_lifecycle.rs`
- `static/android-export.js`
- `static/android-host.css`
- `static/android-host.js`
- `static/android-platform.js`
- `static/app.js`
- `static/remote.css` (one-line local change included during the 2026-09-16 integration)
- `static/styles.css`
- `tests/login_service_fixture.py`

No files removed. Runtime Rust owns the preview entry, transport/lifecycle,
isolated storage setup, desktop capability projections and direct reuse of
P02/P03/P04/cache/catalog services. Tauri Rust remains process/window/download
I/O and owns no AppState. Python changes are exclusively test fixtures and
process/browser orchestration; no production Python business logic was added
or changed. JavaScript/CSS changes only separate desktop capability/platform
behavior and preserve default rendering. The initial validation created no
commit. Remote push: **No**.

### 2026-09-16 integration onto the updated local branch

Restored the Step 1 stash onto `feb27ec` on `work/v0.8.0`, preserving both new
commits (`f96257f` desktop/Remote UI refinement and `feb27ec` CI/bundle caching).
The only textual conflict was at the end of `static/styles.css`: retain the
new window-caption, focus and SVG-control styles together with the preview-only
styles. Automatic merges in `static/app.js` and
`src-tauri/src/window_lifecycle.rs` preserve the new tool-status/tooltip/icon
behavior and Windows frame synchronization alongside preview platform/data
isolation.

The pre-existing unstaged change in `static/remote.css` is included unchanged:
the playback sheet uses `scrollbar-gutter: auto`. The complete file list above
now contains 30 files. No additional production Python or Rust policy was
introduced during conflict resolution; architectural classifications and the
default-backend boundary remain as described above.


#### Integration validation

All commands below passed on the combined tree. Rust domain: 218 tests;
default Runtime: 225 passed, 15 existing ignored; native-host Runtime: 261
passed, 15 existing ignored; Tauri: 81 passed, with its one separately invoked
native-export integration also passing. Python: 1658 tests, OK with the same
15 platform/artifact skips described above. No assertions were weakened and
no implementation changes beyond the recorded conflict resolution were needed.

| Directory | Exact command | Result |
| --- | --- | --- |
| `rust` | `cargo fmt --check` | Pass |
| `rust` | `cargo clippy --all-targets --locked -- -D warnings` | Pass |
| `rust` | `cargo test --locked -- --test-threads=2` | Pass |
| `rust` | `cargo build --release --locked` | Pass |
| `rust-runtime` | `cargo fmt --check` | Pass |
| `rust-runtime` | `cargo clippy --all-targets --locked -- -D warnings` | Pass |
| `rust-runtime` | `cargo test --locked -- --test-threads=2` | Pass |
| `rust-runtime` | `cargo build --release --locked` | Pass |
| `src-tauri` | `cargo fmt --check` | Pass |
| `src-tauri` | `cargo clippy --all-targets --locked -- -D warnings` | Pass |
| `src-tauri` | `cargo test --locked -- --test-threads=2` | Pass |
| `src-tauri` | `cargo build --release --locked` | Pass |
| `.` | `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --lib --locked -- --test-threads=2` | Pass |
| `.` | `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --features native-host --locked -- -D warnings` | Pass |
| `.` | `cargo build --manifest-path rust-runtime/Cargo.toml --locked --features native-host --bin bilikara-desktop-host` | Pass |
| `.` | `cargo build --manifest-path src-tauri/Cargo.toml --locked` | Pass |
| `.` | `cargo test --manifest-path src-tauri/Cargo.toml --locked desktop_rust_entry_uses_authenticated_tauri_export_transport -- --ignored` | Pass |
| `.` | `python tests/run_native_host_http.py` | Pass |
| `.` | `BILIKARA_HOME=/tmp/bilikara-pop-python-home BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -v` | Pass |
| `.` | `python -m compileall -q bilikara` | Pass |
| `.` | `python -m py_compile start_bilikara.py build_bundle.py` | Pass |
| `.` | `npm ci` | Pass |
| `.` | `npm run build` | Pass |
| `.` | `git diff --check` | Pass |
| `.` | `git diff --cached --check` | Pass |
| root | `python tests/run_desktop_rust_host.py /tmp/bilikara-pop-browser` | Pass |
| root | `python tests/run_desktop_launcher.py /tmp/bilikara-pop-launcher` | Pass |

Browser plugin not available; reused Playwright WebKit with desktop 1440×1000
and Remote 375×812 CSS pixels. The flow was actual Rust entry → QR/session/add
and binding → Native playback/Remote controls → export → shutdown/restore.
The rendered shared UI, media interactions, absence of blank/error overlays,
and console health passed. Screenshots preserve the latest SVG control icons
and show the Remote playback sheet fitting its viewport with the retained
scrollbar change. The existing LAN/Internet protocol and cancellation cases
passed. Real DataChannel/physical network and other-platform limitations remain
unchanged. Actual Linux Tauri separately passed both backend launch paths,
window rendering, normal close, backend reap and listener closure.

Evidence: `/tmp/bilikara-pop-gate-results.json` and per-command
`/tmp/bilikara-pop-gate-00.log` through `24.log`;
`/tmp/bilikara-pop-browser/browser-summary.json`, `fixture-summary.json`,
`desktop-playing.png`, `remote-375x812.png`;
`/tmp/bilikara-pop-launcher/launcher-summary.json`, `rust-webview.png`,
`default-webview.png`. Network fixtures forwarded zero external requests.
The normal Linux deb/rpm/AppImage build passed without packaging changes.
Windows/macOS/mobile checks remain unavailable here; no remote push was made.
