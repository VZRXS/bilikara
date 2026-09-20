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

The default Python Host retains its update responsibilities:
`bilikara/updater.py` owns update checking, downloading, installation and
restart; `bilikara/server.py` routes `/api/app/update/*`;
`bilikara/config.py` resolves `APP_VERSION`; and `build_bundle.py` and the
packaging scripts produce the Python bundle. The native check/status loop
does not replace those installation, restart or packaging responsibilities.

### Android PR #110 local integration and correction

Preview 1 is already released; development remains on `work/v0.8.0`. Accepted
desktop Step 1–2B and desktop update-check work remain closed.
This is a bounded Android integration, not a restart of mobile completion or
the desktop migration queue. Default backend/distribution policy, retired
FFmpeg/ffprobe executables and retained libav/BBDown/aria2c sources are unchanged.
No Python production responsibility exits here.

On 2026-09-19, PR #110 was still open: `kevinx96/bilikara:dev` at `d3062ec`,
targeting `VZRXS/bilikara:work/v0.8.0` at `150f00d`. Local HEAD was `c83648d`,
including the accepted desktop updater/test work. History-preserving local
merge `226252d` has parents `c83648d` and `d3062ec`; it required no conflict
resolution. The independent uncommitted `native_host_storage.rs` lock change
was preserved byte for byte and excluded from both this merge and the separate
Android corrective commit. GitHub was not merged and no push was performed.

- **Concern A — CONFIRMED.** The exported, resizable single-task Activity is
  not confined to display 0. Android's launch policy permits secondary-display
  launch/movement, and Presentation discovery is based on display capability,
  not the calling Activity's location. The former `targets()` excluded only 0;
  session/controller projections also hardcoded 0. The correction uses the
  Activity WindowManager's associated display for projections, recommendation,
  filtering and activation revalidation, and rechecks window moves through the
  lifecycle and existing watchdog. Default-off, generation checks and normal
  phone-plus-output behavior remain intact.
- **Concern B — CONFIRMED.** AOSP `SharedPreferencesImpl.commit()` first calls
  `commitToMemory()`, then waits for the disk result; it does not roll memory
  back on failure. The old snapshots reread that memory and each setter only
  replaced one field. The JS consumer accepts the entire pair on a later
  successful response. Native confirmed-pair snapshots, full-pair writes and
  explicit recovery now prevent the failed field entering the next operation.
  Failed orientation saves return before either normal or fullscreen-exit
  orientation changes. Recovery failure stays explicit; no crash-durability
  guarantee is made after an unsuccessful recovery.

Validation is implementation self-testing, not independent approval. Seven
Kotlin/JUnit tests passed using the Android SharedPreferences interface and a
faithful memory-before-disk double, without adding a new test framework. The
same tests against extracted pre-fix selection/read/write statements failed
six cases, including both cross-field persistence sequences. That baseline
exercise is extracted-code evidence, not an executed old APK. Existing
Python/Node Android/layout/audience/player checks passed 176 tests. `npm ci`,
`npm run build` (local Linux artifacts only), Python compilation and diff checks
passed. Exact commands, complete file lists and logs are under
`.tmp/pr110-integration/`.

Android Gradle compilation stopped at missing generated `tauri.settings.gradle`;
this environment also lacks an Android SDK, full JDK and adb. No APK compilation,
instrumentation, emulator, physical display/audio, CI or release evidence is
claimed. The existing offline Chromium layout harness timed out waiting for
playback, including a separate temporary probe using the visible Start button;
diagnostics confirmed this Chromium has no H.264/AAC support (`canPlayType()`
empty, media error 4 / `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`). Its later
layout/media assertions remain unverified. The accepted Rust and
desktop evidence above is reused rather than reopening their full gates or
the unrelated Tauri/bootstrap, updater-installation and storage/test-flake work.
No external service write, production-data access, deployment, tag or release
mutation was performed.

### Configured-source Gatcha refresh

The default Host's public background-refresh entry marshals trusted paths,
credential snapshots, keywords and observer callbacks to a Rust-owned task.
Callers include manual HTTP refresh, settings-triggered refresh, Internet
Remote's Host effect, startup with restored login credentials and the
login-success callback. The first startup/login invocation is nonblocking and
can rebuild an old schema; later invocations use the manual wrapper. The
`upload_default_uids_to_lark` compatibility argument remains accepted without
policy effect.

`gatcha_refresh` and the existing repository/status services own task admission,
worker execution, result interpretation, completion indexing and cancellation.
Python transports configuration and DTOs, holds C callback lifetimes and
delivers observer notifications; no callback is necessary to finish repository
or Catalog work. The additive C ABI preserves existing ABI-v1 services and
snapshot DTOs without starting a native Host or creating another AppState.
Each default Host has a Rust resource-owner token so an old Host's shutdown
cannot stop its replacement.

The native Host calls the same typed Rust service directly. Manual
authorization/cooldown, automatic-login eligibility and status text remain
Host-specific. Native desktop automatic bulk refresh is disabled, and native
refresh does not upload completion records. Aggregate repository errors with
no UID success mean `failed` in the default Host and `partial` in the native
Host; these are distinct projections of the shared result.

Normal default-Host completion queues only newly added UID records through
the existing bounded Catalog append facility. Startup schema rebuilding uses
Rust repository fetches, temporary/checkpoint paths, UID/folder resume and
per-file atomic publication; it indexes only favorite entries. Repository page
retries are bounded. Rebuild publication is not an atomic three-file
transaction. This task service does not perform monthly or account-wide scans.

Network requests run outside AppState locks. Cancellation is cooperative at
repository operation/page/retry and publication boundaries. In-flight Bilibili
work can finish, including WBI key acquisition and its signed request. Stopped
or replaced tasks cannot publish a late status or enqueue new completion work.
Already accepted Catalog jobs retain the queue's independent delivery lifetime;
queue acceptance is best effort, not a delivery guarantee.

Source-add and favorite-specific public adapters, synchronous repository
refresh, frozen `_py_*` references and their tests, and WBI/monthly consumers
remain. The default Python Host transport, launcher and release packaging
remain in use; the native Host is still opt-in.
