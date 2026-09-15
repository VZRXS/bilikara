# No-media-CLI experimental bundle

Branch: `codex/experiment-no-media-cli`, based on `745c837` from the current clean
`work/v0.8.0` tree. This is an experiment, not a release or a claim that every
FFmpeg operation has a libav replacement.

## Current behavior (2026-09-16)

The desktop experiment now excludes only FFmpeg/ffprobe programs. Build scripts
use `--disable-programs`; the companion build reads version/configuration from
selected libav shared libraries directly, without ffprobe. Dependency collection
starts at the companion, and extracted-package validation rejects any FFmpeg or
ffprobe executable. The legacy `ffmpeg-runtime.json` filename is retained with
`kind: libav` for the library closure; legacy CLI manifests/helpers remain usable
by retained source tests.

BBDown, yt-dlp and aria2c are allowed again. Downloader startup no longer prepares
FFmpeg in this mode; single-stream downloader commands omit its CLI path, and
existing Runtime/libav operations handle media inspection and normalization.
FFmpeg compatibility requests fail explicitly. This does not claim every provider
input or every external downloader has been tested live.

Test with a fresh extracted package and uncached media. Default experiment data
remains isolated in `runtime-no-media-cli` (Windows) or
`~/Library/Application Support/bilikara-no-media-cli` (macOS), preserving existing
experiment data across this update. Android remains part of CI. Branch runs do
not create Releases or deploy the public Remote.

## Historical evidence before the 2026-09-16 policy change

- Unit tests cover real audited spawn attempts, frozen enforcement despite an
  opt-out environment, renamed tool paths, early preparation failures, status,
  terminal failure classification and no version-probe processes.
- Local source smoke with `BILIKARA_DISABLE_MEDIA_CLI=1` uses the existing trusted
  same-build Linux companion. Actual FFmpeg/ffprobe/BBDown/yt-dlp/aria2c process
  attempts are rejected, while real Runtime/libav metadata, validation and packet
  scan complete on the existing synthetic FLAC fixture.
- CI retains the full baseline release gate. After building and extracting each
  desktop archive, it runs `scripts/check_no_media_cli_bundle.py` against the real
  frozen backend with the opt-out environment deliberately set. Both macOS
  backend copies are checked. Artifacts upload only after this proof passes.
- Android APK builds on this branch as on other CI branches. The desktop CLI
  experiment does not exclude Android. No tag, GitHub Release or R2 mirror
  publication is created by a branch workflow run.

Local release-gate and Actions results are recorded in the task report. Automated
checks establish only their fixture scope; manual playback is still required.

## Validation commands

From each of `rust/`, `rust-runtime/`, `src-tauri/`:

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
```

From the repository root:

```sh
task_app_home=$(mktemp -d /tmp/bilikara-no-cli-tests.XXXXXX)
BILIKARA_HOME="$task_app_home" BILIKARA_BILIBILI_COOKIE= BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -v
python -m unittest discover -s tests -p test_media_cli_disabled.py -v
python -m unittest discover -s tests -p test_tool_asset_workflows.py -v
node --test tests/android_release.test.mjs
python -m compileall -q bilikara
python -m py_compile start_bilikara.py build_bundle.py scripts/check_no_media_cli_bundle.py
npm ci
npm run build
git diff --check
```

Local real-libav experiment (existing same-build Linux test artifacts, disposable
app home):

```sh
task_app_home=$(mktemp -d /tmp/bilikara-no-cli-smoke.XXXXXX)
BILIKARA_HOME="$task_app_home" BILIKARA_DISABLE_MEDIA_CLI=1 BILIKARA_LIBAV_COMPANION=/tmp/bilikara-all-platform-libav/prefix-final/bin/libbilikara_media_libav.so BILIKARA_LIBAV_FFMPEG_PREFIX=/tmp/bilikara-all-platform-libav/prefix-final BILIKARA_MEDIA_BACKEND=default python start_bilikara.py --tool-smoke no-media-cli
```

Local outcome: all listed gates passed. Rust domain: 218 tests; Runtime: 225
passed and 15 pre-existing provisioned-media tests ignored; Tauri: 79 tests.
Python discovery: 1650 tests, 15 pre-existing platform/provisioning skips, no
failures. The final focused prohibition suite passed 7 tests (including the
additional Windows audit-event regression); workflow tests passed 9 and Android
release contract tests passed 3. Real Linux companion smoke completed all three
libav operations with all five media process types blocked. YAML parsing and an
AST check of every live cache subprocess site also passed.

`npm ci` and `npm run build` passed and produced local DEB/RPM/AppImage outputs.
The existing Tauri bundler emitted warnings about the `.app` identifier and
missing `__TAURI_BUNDLE_TYPE`; those are not fixed or reclassified by this
experiment. Windows/macOS packaged results must come from the dispatched Actions
run; Linux tests are not substituted for those results. No manual-device or
independent-review acceptance is claimed.

## Fullscreen, native caption and status follow-up

This follow-up changes Host/UI and native window-shell adaptation only. The
Python addition transports the existing Runtime loaded flag as
`bbdown.native_runtime_ready`; it adds no media policy or mutable authority.
The native Host's existing `ready` DTO remains supported. Optional login / QR
expiry is a yellow reminder and cannot change service health to red. An
unavailable selected Runtime or an enabled failing tool still reports red.
The Bilibili login badge is the sole account indicator inside the menu.

Host, Remote and presentation status dots share an 18 px outer disk / 8 px
center and a four-color palette. Waiting is gray, ready/running green,
non-blocking reminders yellow and operational failure red. Former tests tied
to literal check/cross glyphs were updated to the requested visual contract;
connection state, error copy, locale and dimensions assertions remain.

Fullscreen now disables the Windows undecorated shadow, DWM border and rounded
corners, and restores normal window treatment on exit. Existing viewport-filling
CSS remains intact. The fullscreen exit keeps its accessible label without a
text tooltip. Maximize retains a native hit surface above WebView2, but caption
messages and hit testing are handled by the top-level HWND / DWM, rather than
synthetic maximize clicks. The custom HTML hover bubble is removed. The OS owns
Windows 11 Snap Layouts versus earlier Windows caption behavior; no OS-version
string guessing or simulated Snap menu is added. References:
[Microsoft Snap Layouts guidance](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-snap-layout-menu)
and [DWM custom frames](https://learn.microsoft.com/en-us/windows/win32/dwm/customframe).

Changed files in this batch: `bilikara/cache.py`; `src-tauri/src/platform.rs`,
`window_chrome.rs`, `window_lifecycle.rs`; `static/app.js`, `index.html`,
`styles.css`, `remote.html`, `remote.js`, new `status-indicators.css`;
`tests/live_host_ui_browser.js`, `runtime_settings_status.cjs`,
`test_host_build_review_repair.py`, `test_remote_header_refinement.py`,
`test_window_chrome_frontend.py`; this document.

Validation: the release-gate commands listed above passed again (domain 218,
Runtime 225 passed / 15 ignored, Tauri 79; Python 1652 tests / 15 skipped).
`npm ci`, `npm run build`, Python compilation and `git diff --check` passed.
Additional focused commands passed:

```sh
node --check static/app.js
node --check static/remote.js
node tests/runtime_settings_status.cjs
node tests/android_login_action.cjs
python -m unittest discover -s tests -p test_host_build_review_repair.py -q
python -m unittest discover -s tests -p test_remote_header_refinement.py -q
python -m unittest discover -s tests -p test_window_chrome_frontend.py -q
```

Browser plugin unavailable: Playwright used the existing
`tests.live_host_ui_browser.main` temporary-app-data server harness with
`BROWSER_DRIVER=/tmp/chrome-status-browser.cjs`. The real Host and Remote pages
loaded their normal scripts/styles. Synthetic account states and intercepted
QR-start responses tested expiry/reopen without live login. Checks passed for
1280x900 / 600x900 viewport coverage, no exit tooltip or custom maximize bubble,
account-indicator removal, four colors, three-theme Host/Remote agreement, and
no page script errors. The final palette/tooltip edits were rechecked with this
browser flow and the focused tests; they did not change Rust/Python execution.

Full local Windows cross-build was attempted with
`cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --locked`
and blocked by missing `llvm-rc`. Both Windows x64 and ARM64 production
`window_chrome.rs` / `platform.rs` modules subsequently passed `cargo check
--offline --target <target>` in a temporary crate against real Tauri and Win32
bindings, stubbing only unrelated authorization plumbing. This is type-checking,
not native UI execution. Windows 10/11 Snap hover, click/restore, full-screen
physical monitor edges and macOS devices still require actual device testing.
Independent review is not claimed. CI dispatch and amended commit are reported
in the task response; no Release or deployment is authorized by this follow-up.

CI asset-sync correction (2026-09-15): run 34951843040 failed on all three
platforms because the Remote sync allowlist omitted `status-indicators.css`.
Added the stylesheet to `scripts/sync_internet_remote_assets.ps1` and the matching
`.github/workflows/internet-remote-sync.yml` push filter. Strengthened
`tests/test_internet_remote_deployment.py` to check CSS dependencies without
requiring PowerShell; retained the real sync/copy assertions. No production
Python/Rust logic changed in this correction.

The previous local Python gate skipped the PowerShell sync test because `pwsh`
was absent from PATH. Revalidation explicitly put the existing temporary
PowerShell installation on PATH:

```sh
PATH=/tmp/bilikara-m6-ci-repair/pwsh:$PATH python -m unittest tests.test_internet_remote_frontend tests.test_internet_remote_deployment -v
PATH=/tmp/bilikara-m6-ci-repair/pwsh:$PATH BILIKARA_HOME="$task_app_data" BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest discover -s tests -v
git diff --check
```

Passed: 55 focused tests, including actual PowerShell asset copying; full Python
suite 1652 tests / 12 skipped using temporary app data. Earlier Rust, Tauri,
build and browser checks above remain applicable to unchanged application code.
This correction does not claim device validation or independent review. The
amended commit, push and replacement CI outcome are reported in the task response.

Android CI correction (2026-09-15): removed the unauthorized experiment-branch
exclusion from `ci-bundle.yml`. Run 34956264664 succeeded only for desktop tests
and bundles; it did not validate or produce Android. The existing Android
workflow contract test now rejects a job-level condition that excludes branches.
Local checks: `node --test tests/android_release.test.mjs` (4 passed),
`python -m unittest tests.test_windows_libav_preview -q`, and `git diff --check`.
This is a workflow/test/documentation correction with no production Python/Rust
logic changes. Full application checks from the preceding run remain applicable;
the replacement workflow must also build, verify and upload the Android APK.


## UI and bundle follow-up (2026-09-16)

- All contextual info bubbles use the browser top layer and content-sized widths
  bounded by the viewport; no 260px fixed width. Switches return to the 30px pill
  button height (24px thumb). Dropdowns remain 34px: 30px is feasible, but was
  researched rather than imposed as an additional visual change.
- Reminder badges regain the theme accent. Service indicators use green check,
  red cross, yellow exclamation and gray waiting disks. Warning yellow is Carbon
  Yellow 30 (`#f1c21b`), with a dark glyph for contrast.
- The casting icon uses a rectangle and lower-left broadcast arcs. Windows still
  uses custom SVG caption glyphs, now square and closer to native proportions.
  The child HWND tracks its own hover, captures clicks, and posts exactly one
  maximize/restore command on an in-bounds release. DWM retains Snap hover.
- Remote QR containers center their content. Inline SVG replaces data-image URLs
  to work with the public Worker's strict CSP. Read-only inspection of
  `kevinx96/bilikara-internet-remote-worker` found `img-src` without `data:`.
  The earlier missing-script inference inspected the landing `public/index.html`;
  the actual `public/remote.html` does load the encoder. Updated assets still need
  synchronization there; no public deployment was performed in this task.
- Android uses `setup-android@v4` (Node 24). Windows uses the installed Visual
  Studio `VsDevCmd.bat` through `scripts/setup_msvc.ps1`, removing the
  Node-20-only MSVC Action. Existing Node 24 workflow configuration is preserved.

Implementation-coupled assertions updated: required packaged FFmpeg/ffprobe,
blanket downloader prohibition, data-URL QR rendering, and banning native posted
caption commands. Dependency, signature/provenance, archive, error and downloader
checks remain. No Python media parser or new Rust application-state authority was
introduced; Python changes are Host tool admission/Runtime adaptation and build I/O.

Validation details and platform gaps are recorded below and in the task response.

Validation actually run (2026-09-16):

- Each of `rust`, `rust-runtime`, `src-tauri`: `cargo fmt --check`,
  `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`,
  `cargo build --release --locked` passed. Domain 218; Runtime 225 / 15 ignored;
  final Tauri 80, including the captured-caption gesture regression.
- `BILIKARA_REQUIRE_RUST_LIB=1 PATH=/tmp/bilikara-m6-ci-repair/pwsh:$PATH python -m unittest discover -s tests -v`:
  1653 tests / 12 skipped passed; subsequent added downloader-command regression
  and related tests passed (`python -m unittest tests.test_media_cli_disabled tests.test_tool_asset_workflows -q`, 18 tests).
- `node --test tests/android_release.test.mjs`, `node --check static/app.js`,
  `node --check static/remote.js`, `python -m compileall -q bilikara`,
  `python -m py_compile start_bilikara.py build_bundle.py media-libav/build.py`,
  `npm ci`, `npm run build`, shell/PowerShell parser checks and `git diff --check` passed.
- Existing Playwright `tests.live_host_ui_browser.main` harness, temporary
  `/tmp/refinements-browser.cjs`: actual Host/Remote, 1280x900 and 600x900 Host,
  390x844 Remote, three themes, green/check red/cross yellow/exclamation gray/disk,
  30px switch/pill agreement, content-dependent top-layer bubbles and centered
  QR under the Worker's exact CSP passed. Identity was a synthetic unrelated
  fixture; QR generation used the real encoder/DOM. Screenshots in
  `/tmp/refinements-remote.png` and `/tmp/refinements-hints.png`; no app errors.
  Browser plugin unavailable, so the existing Playwright installation was reused.
- `python media-libav/build.py --prefix /tmp/bilikara-libav-only-check --out /tmp/bilikara-libav-only-check/bin --test`
  and `python -m scripts.libav_bundle collect /tmp/bilikara-libav-only-check` passed
  after removing both CLI executables from a copy of the accepted library prefix.
  This reuses the earlier library build, and directly tests companion compilation
  and closure collection without ffprobe; it is not a fresh Windows/macOS build.
- `python /tmp/build-local-libav-only.py` built a real temporary frozen Linux
  package. `python scripts/check_no_media_cli_bundle.py /tmp/bilikara-all-platform-libav/package-workspace-libav-only/dist/bilikara/bilikara`
  passed: no FFmpeg/ffprobe files, both actual spawns blocked, actual bundled BBDown
  `--help` succeeds, and real Runtime/libav metadata/validate/packet_scan succeed.
  Existing synthetic video/FLAC-in-MP4 fixtures also passed the changed DownKyi
  adapter through actual Runtime normalization and libav validation.
- `cargo +1.97.0 check --offline --target x86_64-pc-windows-msvc` and the ARM64
  equivalent passed in the existing temporary Tauri/Win32 type-check harness,
  including production window modules. A first default-toolchain attempt lacked
  its Windows target; the repository-pinned toolchain has both targets.

Platform gaps: Windows 10/11 actual pointer/Snap behavior, macOS device UI and
Android device execution remain untested locally. Platform-specific/provisioned
Python skips remain; live provider downloads were not run. Independent review
is not claimed. Replacement CI and amend/push outcome are reported separately.

Files in this follow-up:
- `.github/workflows/ci-bundle.yml`
- `bilikara/cache.py`
- `bilikara/ffmpeg_vendor.py`
- `bilikara/media_cli.py`
- `bilikara/media_cli_smoke.py`
- `build_bundle.py`
- `docs/experiment-no-media-cli.md`
- `media-libav/PACKAGING.md`
- `media-libav/build-posix.sh`
- `media-libav/build-windows.sh`
- `media-libav/build.py`
- `scripts/check_no_media_cli_bundle.py`
- `scripts/libav_bundle.py`
- `scripts/windows_libav_preview.py`
- `src-tauri/src/window_chrome.rs`
- `static/app.js`
- `static/index.html`
- `static/remote.css`
- `static/remote.js`
- `static/status-indicators.css`
- `static/styles.css`
- `tests/android_release.test.mjs`
- `tests/test_build_bundle.py`
- `tests/test_internet_remote_frontend.py`
- `tests/test_media_cli_disabled.py`
- `tests/test_tool_asset_workflows.py`
- `tests/test_window_chrome_frontend.py`
- `tests/test_windows_libav_preview.py`
- `scripts/setup_msvc.ps1`


CI correction: run 34989634628 passed all platform tests, Android and macOS ARM64,
but the Windows ARM64 runner's installed PowerShell wrapper rejects ARM64 hosts.
The MSVC setup now invokes the official `VsDevCmd.bat` with explicit native host
and target, imports its Unicode environment output and verifies both architecture
variables. This replaces only shell initialization; the Node Action remains removed.

## CI caching, smaller macOS archives and Remote follow-up (2026-09-16)

The libav cache contains only upstream C libraries, headers, source/license and
verification records. Its exact key includes OS/architecture, runner image,
compiler/SDK, relevant flags, install prefix and build-script hashes. Restore
checks file contents; no broad restore-key fallback is used. Companion, Rust
application/driver and test executables are excluded and rebuilt every run.
Both cache misses and hits retain existing companion and extracted-package gates.
Pip/npm/Gradle dependency caches use Node-24-capable Actions. Android and all
three test/four desktop matrix entries remain enabled, with the same test gate.

The macOS archive previously duplicated the 152 MB backend. The standalone
`bilikara.app` entry now uses a relative symlink to the signed backend inside
`Bilikara-Desktop.app`; it remains a browser-mode entry when fully extracted.
The README explains installation and standalone copying. Both existing startup
paths and nested signatures are verified after archive extraction. Repacking the
previous ARM64 artifact locally measured 215,913,237 -> 129,610,415 bytes; this is
size evidence, not macOS launch/signature acceptance. Actual new bundles require
CI evidence. No source/license notices or runtime libraries were removed.

Remote shared/local search now reuses the existing covered-card/detail renderer
and the same taller browsing area as other card views. The primary/secondary
navigation cross-fades without delaying selection or permitting duplicate input;
reduced motion disables it. Modal motion uses the existing center-scale/fade
pattern. Rating overlays the playback sheet, makes it inert while active, and
restores it without dropping its scroll lock. Lock/volume SVG geometry is shared
with Host; dock text has descender space. Warning glyphs use yellow-family color
on a translucent yellow disk. Windows captions use installed Segoe Fluent Icons,
with Segoe MDL2 Assets fallback, and reflect native focus; no font is redistributed.

Public Remote investigation: the last successful sync/deployment was sourced
from work/v0.8.0 at 745c837, not the experiment's 55e2241. The upstream sync
workflow intentionally watches dev/work, and the Worker's configured production
ref is work/v0.8.0. The actual public/remote.html includes the QR encoder, but
public/remote.js still assigns a data:image/svg+xml URL blocked by public/_headers.
The landing index.html is not the Remote app and must not be used to infer missing
QR dependencies. Current local real QR generation passes the Worker's strict
CSP. Pushing the requested work fast-forward will enter the existing sync flow;
no separate manual Worker modification is needed. Its deployment result must be
reported separately from CI & Bundles.

Local validation uses the existing release-gate commands above and temporary app
data. Added `python -m unittest tests.test_libav_cache -q` exercises real cache
round-trip, omission of application binaries, corruption and traversal failures.
A restored copy of accepted Linux libraries also completed the actual cache-hit
`media-libav/build-posix.sh` path, including current companion C tests and Rust
validation-driver compilation/collection. This reuses the accepted upstream
library build; it does not substitute for Windows/macOS cache validation.

Existing `python -m tests.live_host_ui_browser --mode remote-request-workspace
--screenshot /tmp/remote-refined-workspace.png` passed at mobile, wide, three
languages/themes and 200% text scale. `/tmp/current-refinement-browser.cjs` using
the same temporary server exercised real card/detail navigation, active fade
animations, centered lock SVG, rating-close/remaining sheet ownership and dock
text space. `/tmp/refinements-browser.cjs` revalidated actual QR SVG generation
under public CSP, top-layer hints and status colors. Synthetic identity/provider/
rating responses prevent live writes. The obsolete emoji assertion was replaced
with visibility checks of both SVG states across all four backend lock decisions;
the old shorter list-height assertion now requires matching card-browser height.
Other assertions remain. Browser plugin unavailable; existing Playwright reused.

Architectural scope: UI presentation and packaging/cache I/O only; no new Python
business rules, Rust AppState authority or provider fallback. Existing experimental
app-data isolation remains unchanged. Windows font appearance/Snap interaction,
macOS Finder launch and Android real devices require device testing; independent
review remains deferred. Exact stable-gate counts, two final commits, work
fast-forward, push and CI outcomes are reported in the task response.

Files changed in this follow-up:
- `.github/workflows/ci-bundle.yml`
- `README-macOS.txt`
- `docs/experiment-no-media-cli.md`
- `media-libav/build-posix.sh`
- `media-libav/build-windows.sh`
- `scripts/libav_cache.py`
- `static/app.js`
- `static/index.html`
- `static/remote.css`
- `static/remote.html`
- `static/remote.js`
- `static/status-indicators.css`
- `static/styles.css`
- `tests/live_remote_request_workspace_browser.js`
- `tests/test_av_delay_frontend.py`
- `tests/test_libav_cache.py`
- `tests/test_remote_playback_dock.py`

Stable local outcomes: full Python discovery 1658 tests / 12 existing skips,
Rust domain 218, Runtime 225 / 15 provisioned-media ignores, Tauri 80. All fmt,
clippy, release builds, Python compilation, Android's 4 Node contract tests,
`npm ci`, `npm run build`, workflow YAML/shell parsing and diff checks passed.
The first full Python run found only the obsolete emoji assertion described
above; the corrected full run passed. No platform or valid assertion was removed.

After the work push, read-only checks of https://rtc.kevinx96.icu/remote.js
confirmed the deployed source equals the local file after CRLF normalization;
its inline SVG path replaces the blocked data URL. The live /remote page includes
the QR encoder, status stylesheet and card-browser markup. Existing production
sync handled this update; no separate Worker edit/manual deployment was made.

The first work-branch CI's macOS ARM64 archive passed its real signature and
extracted-backend gates at 129,617,226 bytes (previously 215,913,237 bytes).
The final follow-up run includes the modal-owner correction below and validates
warm caches against the same build scripts; final per-platform outcomes belong
in the completion report.

A final modal-owner regression was found during self-check: if the playback
sheet closes while rating still owns the page, releasing its shared scroll lock
would make the page scroll behind the rating. Unlock now waits until sheet,
rating and native export owners are all closed. Real browser coverage verifies
both retaining the lock during that transition and releasing it after the last
owner closes. The superseded warm run was cancelled before final validation.

After that correction, full native-required Python discovery passed again (1658
tests, 12 existing skips); the actual browser owner-transition check and
`npm run build` also passed. Rust sources were unchanged, so the successful Rust
release gates above were reused.
