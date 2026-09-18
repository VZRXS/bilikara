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
- The `src-tauri/src/main.rs` split is done: the entry point is now a thin
  binary, with desktop shell responsibilities in `backend_process.rs`,
  `backend_download.rs`, `window_lifecycle.rs`, `window_chrome.rs`,
  `presentation.rs`, `desktop_diagnostics.rs`, `platform.rs` and `android.rs`.
- Replacing external command-line dependencies is under way rather than
  pending: Rust Native is the default download source, and the packaged media
  route is in-process libav, so release bundles no longer carry an `ffmpeg` or
  `ffprobe` executable. BBDown stays vendored, and DownKyi/aria2c remain
  explicit opt-in transition fallbacks.

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
  Hi-Res acceptance is claimed. The packaged CLI is now BBDown only: libav is
  built with `--disable-programs` and release bundles carry no `ffmpeg` or
  `ffprobe` executable, so `legacy` needs a user-supplied binary via
  `FFMPEG_PATH`. Original M7 removal is a later-version decision. Mobile
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

## Desktop Rust Host preview

The desktop preview keeps Tauri's backend-process boundary and runs
`bilikara-desktop-host` with one authoritative Rust AppState. It reuses the
native HTTP/SSE/media service, login, catalog, cache, player and export services.
The default launcher and release distribution still use Python; opting into
this preview does not remove Python from the product or complete desktop parity.

### Launch and storage

```sh
cargo build --manifest-path rust-runtime/Cargo.toml --locked --features native-host --bin bilikara-desktop-host
BILIKARA_DESKTOP_RUST_PREVIEW_DIR=/absolute/path/to/new-preview cargo run --manifest-path src-tauri/Cargo.toml --locked
```

Use an empty/new directory or a valid marked preview directory. An unmarked
nonempty directory is refused without converting or deleting its contents.
Credentials, checkpoints, preferences, local library, media and export scratch
remain inside this isolated root. Production credentials, records and window
geometry are not automatically imported. Remove the preview environment variable
to return to the default launcher. The preview binary is not in default bundles.

The parent receives a same-origin bootstrap capability over its private child
pipe. Tauri retains the Host cookie for restricted native export transport;
JavaScript cannot supply that cookie. Shutdown cancels work, retires the listener,
joins workers and reaps the backend. Native HTTP uses Content-Length framing;
the default Python transport retains its existing write-half-close convention.

### Import existing desktop records

Choose both paths explicitly. The destination must not exist, its parent must
exist, and source/destination cannot overlap. Source files and path components
cannot be symlinks.

```sh
BILIKARA_DESKTOP_RUST_PREVIEW_DIR=/absolute/new-native-destination \
BILIKARA_DESKTOP_RUST_IMPORT_FROM=/absolute/legacy-app-home \
./src-tauri/target/debug/bilikara
```

The direct backend equivalent is:

```sh
./rust-runtime/target/debug/bilikara-desktop-host \
  --data-dir /absolute/new-native-destination \
  --import-from /absolute/legacy-app-home \
  --static-dir /absolute/bilikara/static --port 0 --headless --no-browser
```

The Rust importer reads the desktop split files or an explicit unified legacy
layout into the existing native checkpoint format. Split files take precedence.
It preserves current/queued items, user order, global/played history, archives,
repository configuration and supported settings. Names do not grant Host/Remote
capabilities. A valid `BBDown.data` takes precedence over the configured cookie
fallback. No source scan, upload or refresh starts merely because credentials
were restored.

Source data is never changed. Destination records are written before publishing
the preview marker without replacement. A failed import leaves an unmarked
unusable destination for inspection. Marked destinations restart from their
native checkpoint without re-importing, even if the old source is absent.
The existing continue/new-session choice still applies.

Missing optional files are allowed; malformed present records and credentials
fail explicitly. Missing referenced played files produce warnings. Legacy split
files did not persist transient `session_history`; this cannot safely be inferred
from played records. Explicit unified session history is retained when present.
Unknown settings stay under `retained_settings` in `native-preferences.json`,
are not applied, and are excluded from public snapshots. Browser-local language
and the default Tauri app-config window geometry are not imported.

Media files are not copied or marked ready. Restart invalidates artifact paths
and playback/cache identities; new supported jobs obtain fresh identities.

### Cache, playback and media capabilities

Native caching supports the desktop's five quality choices, cache count 1–5,
Hi-Res audio and reset-on-next. Settings persist atomically. Reset-on-next clears
local delay while preserving global delay. Unknown source/quality/count choices
are retained and reported unavailable, never silently replaced with Native.
Explicit unsupported retries return an explanatory HTTP 501.

Host codec reports are transient AppState facts tied to active player ownership;
Remote cannot overwrite them, and they are not imported or persisted. The shared
quality service applies the reported AVC cap. A report without a useful limit
falls back to 360P; explicit AVC unavailability disables caching/retry. Reported
HEVC support does not add a backend codec capability. Effective quality/Hi-Res
changes replace jobs through the existing scheduler. Cache-window changes use
existing cancellation, reader leases and artifact collection.

Frozen default bundles exclude and deny FFmpeg/ffprobe programs while retaining
in-process libav, its companion and dependency/license assets. BBDown, yt-dlp and
aria2c remain permitted in the default product. `BILIKARA_DISABLE_MEDIA_CLI=1`
exercises that bundle policy in source launches. Unsupported media operations
fail explicitly; missing companion support does not authorize installing or
falling back to a media CLI. Corruption remains distinct from unsupported media.

Update checking is covered below. Update installation, remaining
maintenance/rating/catalog-publication features, external-tool provisioning,
full desktop lifecycle parity, default backend cutover and Python packaging
retirement remain separate work. Physical
multi-display, native dialogs and platform-specific process behavior require
their own Windows/macOS/device validation.

### BBDown in the Rust Desktop Host

The explicit BBDown source supports selected video/audio pages with an existing
compatible BBDown 1.6.3 executable. Startup checks `BB_DOWN_PATH` first; an invalid
override fails closed. Otherwise it checks existing private `tools/bbdown`,
configured `BILIKARA_HOME/tools/bbdown` and installed/bundled executable-relative
locations. It neither searches PATH nor downloads/installs a binary. A bounded
offline help check verifies the version and required arguments. Configure a
trusted executable and restart to change availability. Public requests cannot
supply executable paths or commands. DownKyi/aria2c and yt-dlp are not Rust Host
executors; their default-product behavior remains available.

Each accepted attempt captures its source, effective preferences and P02
credentials. BBDown uses typed arguments, owned staging, separate tracks and
`--skip-mux`; it receives no FFmpeg/ffprobe path. An empty private config, empty
child PATH and a noncredential `;` cookie when logged out prevent accidental
use of adjacent tool configuration or `BBDown.data`. Child output is drained
without logging raw output or cookie arguments. Rust supervises cancellation,
termination and reaping within the existing bounded job concurrency. There is
one invocation per track per attempt; the tool retains its internal retries.

A successful exit alone does not make an artifact ready. Required outputs must
be nonempty regular files inside owned staging and pass the shared Rust media
inspection, normalization and track/duration contracts. Artifact directories
publish through atomic no-replace operations, preserving relative URLs, audio
identities and order. Source changes replace attempts; late results cannot own
a replacement. Reader leases still govern collection. Missing/incompatible
executables and unsupported outputs fail explicitly without Native substitution
or Python/media-CLI fallback.

### Update checking in the Rust Desktop Host

v0.8.0-preview.1 is published and development continues on `work/v0.8.0`. Step
1-2B - settings, legacy import, BBDown/DownKyi execution, tool readiness and the
scoped CI - is closed.

The desktop Host answers `GET /api/app/update/status` and
`POST /api/app/update/check` with a real check-only result instead of the
earlier `unavailable` placeholder. It fetches release metadata and nothing else.
No archive transfer, staging, executable replacement, update helper or restart
belongs to this path, and automatic installation stays unavailable: release
metadata alone does not prove an installable native replacement.

The check reuses the shared `decide_release_update` channel policy and the
shared update-asset scoring, which `bilikara_rust` now exports as a typed rlib
API rather than only through its JSON/FFI adapter, so there is no
Rust-to-JSON-to-Rust round trip. Desktop keeps its own established source order,
the GitHub API first and then the mirror, matching `bilikara/updater.py`; it
does not adopt Android's mirror-first `releases.json` or its APK selection.
Stable checks read the `/latest` document and preview checks read the release
list. Release I/O is bounded to 1 MiB with a 10 second timeout per source, runs
outside the AppState lock, and uses the shared TLS/trusted-source client. A
release is accepted only when its tag is a bounded ASCII tag and its page is the
published release page, and the page URL is then reconstructed from that
validated tag.

Version eligibility, compatible-asset availability and installation capability
remain three separate facts - `eligible_update`, `asset_available` and
`auto_update_supported`, the last always false here. A network or schema failure
becomes `failed`, never an up-to-date success. The deliberate preview-to-stable
switch is preserved, including when the stable version is numerically lower.
Windows/macOS descriptors are never confused with the Android APK in the same
release, because the shared scoring accepts only platform-matched `.zip`
packages.

The current version, platform and architecture come from trusted local
configuration: the launcher's `BILIKARA_VERSION` override first, then the
`APP_VERSION` file the bundle build writes beside the shared assets. An
unresolved version stays empty and the shared policy then treats the build as a
development build; nothing is taken from an HTTP payload, a published tag or a
crate version. A source checkout without `APP_VERSION` therefore checks as a
development build unless `BILIKARA_VERSION` is set.

The desktop application-operation guard was narrowly replaced, not lifted. Only
the status and check routes are admitted; Android install/finish, shutdown,
external-link, maintenance and rating operations still report unavailable,
`/api/app/*` is not broadly exposed, and Host-only authorization is unchanged,
so Remote clients cannot acquire update control. Requests cannot select an
endpoint, path or destination, and no Bilibili cookie, bootstrap credential or
shutdown token reaches a release endpoint or appears in status or logging.
Repeated checks are bounded by the existing busy guard, a superseded check
cannot overwrite a newer result, and a completion after shutdown cannot mutate a
stopped Host.

The `app_update` capability now reports available on desktop as well, so the
capability projection no longer contradicts the working route. Automatic startup
checking is still skipped on a native Host without the Android platform bridge,
which is what keeps desktop checking manual.

The Host UI is unchanged. Its existing update control already renders a
check-only result: with `auto_update_supported` false it offers to view the
version and shows the backend message, which carries the release page URL
because this preview has no external-link integration. Automatic startup
checking stays off on desktop and this increment adds no periodic background
check. Only the native path's corresponding Python update-check orchestration is
bypassed; the default Python updater, its install/restart path, transport,
launcher, FFI/DTO/persistence and packaging consumers are untouched.

#### Independent review of the desktop update check (scoped PASS)

An independent reviewer session, separate from the implementation author,
inspected the code and tests rather than the implementation summary, and
re-ran the checks itself. Scoped result: PASS. A PASS authorises neither a
release nor the default backend cutover.

State of this increment: implementation complete; implementation self-tests
complete; independent review complete with the evidence below; committed
locally only. Not pushed. No Actions run was dispatched, no tag or release was
touched, `v0.8.0-preview.1` is unchanged, and there is no physical Windows,
macOS or Android device evidence for this delta.

Reviewer-executed commands, all against the current working tree:

| Command | Result |
| :--- | :--- |
| `cd rust && cargo fmt --check` | PASS |
| `cd rust && cargo clippy --all-targets --locked -- -D warnings` | PASS |
| `cd rust && cargo test --locked` | PASS, 220 tests |
| `cd rust && cargo build --release --locked` | PASS |
| `cd rust-runtime && cargo fmt --check` | PASS |
| `cd rust-runtime && cargo clippy --all-targets --locked -- -D warnings` | PASS |
| `cd rust-runtime && cargo clippy --all-targets --locked --features native-host -- -D warnings` | PASS |
| `cd rust-runtime && cargo test --locked` | PASS, 228 tests |
| `cd rust-runtime && cargo test --locked --features native-host --lib` | PASS, 283 tests, 9 consecutive clean runs |
| `cd rust-runtime && cargo build --release --locked --features native-host` | PASS |
| `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests` | PASS, `Ran 1668 tests`, `OK (skipped=18)` |
| `python -m compileall -q bilikara`, `python -m py_compile start_bilikara.py build_bundle.py` | PASS |
| `git diff --check` | PASS |

Endpoint and state integration was exercised against the real
`bilikara-desktop-host` executable, not only through helper tests. A reviewer
harness ran the production binary behind the repository's own non-forwarding
TLS fixture, with `api.github.com` deliberately absent from the fixture
certificate, and confirmed over real HTTP: the idle projection, the trusted
`BILIKARA_VERSION` current version, `capabilities.app_update` and `app.version`
agreeing with `/api/state`; `/api/app/update/check` agreeing byte for byte with
`/api/app/update/status` and with `/api/state`'s `app_update` on every
transition; the primary-to-mirror source fallback actually occurring; a request
being unable to redefine the trusted version or platform; the release page URL
reconstructed from the validated tag; stable and preview channels; the three
separate facts `eligible_update`, `asset_available` and `auto_update_supported`;
`400` on a missing or non-boolean channel; `403` for a client without the Host
capability; `501` for install, finish, rating, external-link and
`GET /api/app/update`; `403` for shutdown, which its own token guard rejects
before the desktop guard; no `libpython` mapping and no child process in the
serving process; and no archive, package or installer written anywhere under the
preview data directory. 39 of 40 reviewer assertions passed; the single
mismatch was the reviewer's own expectation of `501` rather than `403` for
shutdown, which is the stricter outcome, not a defect.

Limits of this review, stated rather than inferred:

- The browser-rendered assertions added to `tests/live_desktop_rust_host.js`
  were NOT executed. That script fails earlier, at its existing
  `[data-action="toggle-audio-variants"]` click on the Remote page, because the
  variant list fits inline at the Remote viewport width and
  `syncAudioVariantLayout` then hides the toggle. The reviewer reproduced the
  identical failure from an unmodified `HEAD` checkout, so it pre-dates this
  increment and belongs to the accepted UI work in `150f00d`, not here. The
  backend contract those assertions would check was verified directly instead;
  the rendered button text itself remains unverified.
- No packaged-platform evidence. Windows and macOS package selection is
  exercised only with synthetic descriptors on Linux, where the shared policy
  correctly reports no compatible package.
- No live release or account service was contacted; all release metadata came
  from local fixtures.
- `src-tauri` checks and `npm run build` were not rerun, because no `src-tauri`
  or `static/` file changed in this increment.
- `rust-runtime/tests/native_host_http.rs` fails intermittently (2 of 7
  reviewer runs) on `/api/diagnostics/markdown`. Its client timeout of 5 s
  races the 5 s connectivity-probe timeout in `diagnostics.rs`; both values are
  unchanged at `HEAD` and no file in this increment touches that path. It is a
  pre-existing environment-dependent flake, filed separately.
- `rust-runtime/src/native_host_storage.rs` is modified in the working tree by
  separate flake-fix work and was deliberately EXCLUDED from this increment's
  commit. The reviewer confirmed the increment does not depend on it: with that
  file reverted to `HEAD`, the native-host library suite still passed 283 tests
  in 4 consecutive runs.

Remaining Python consumers, unchanged by this increment: `bilikara/updater.py`
still owns the default desktop update check, download, install and restart
path; `bilikara/server.py` still routes `/api/app/update/*` for the default
Python Host; `bilikara/config.py` still resolves `APP_VERSION`; and
`build_bundle.py` and the packaging scripts still produce the Python bundle.
Completing the native check/status loop does not delete the default Python
install and restart responsibilities or the packaging responsibilities, and it
does not schedule the historical Python groups as blockers.

Next documented action: none is scheduled by this review. Update installation,
the default backend cutover, Python packaging retirement, the pre-existing
Remote audio-variant harness blocker and the `native_host_http` flake remain
separate, individually unauthorized work.
