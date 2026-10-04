# Native desktop launch and bundles

The desktop shell starts one `bilikara-desktop-host` process by default. The
backend owns the Rust AppState and native HTTP/SSE/media services. No Python,
Cargo, source checkout or preview environment variable is needed by an installed
product. Python remains a dependency-preparation/test tool and the legacy source
Host remains available for compatibility tests; neither is included in the native bundle.

v0.8.0-preview.2 has been released with this architecture. Stabilization uses
that desktop behavior baseline, including approved Preview 1 behavior and later
changes. Remaining Python maintenance does not reopen the runtime migration or
alter published Preview 2 tags/assets, storage paths or update contracts.

LAN Remote links and QR codes use `http://<LAN address>:<port>/remote` without
an invitation parameter. Opening `/remote` (also `/remote/` or `/remote.html`)
establishes a Remote device cookie and then shows username registration, matching
the Python Host's direct-entry flow. An existing device cookie is reused; a stale
cookie can rejoin after a Host restart. Registered singer bindings are stored as
token digests in the private AppState checkpoint and survive “continue previous
session”, including reconnecting phones that keep the page open. Starting a new
session, removing a singer or resetting runtime data revokes those bindings.
Historical visitors do not consume a ten-device admission quota. SSE streams
receive commit notifications and do not share a twelve-stream admission quota;
slow/disconnected streams still time out. This does not grant Host management or
media access: those still require the private loopback Host session. Public-room
passwords and signaling are separate and unchanged.

The native Host checks local network interfaces every five seconds without
Internet probes. Changed LAN addresses and their QR image are published together
through AppState; unchanged addresses do not regenerate the QR or advance the
state revision. Host polling updates all entry surfaces automatically. With no
LAN address, entry links and copy actions are disabled until one returns.
The HTTP Host check accepts the advertised addresses, including public campus,
link-local and CGNAT IPv4 addresses, and loopback. Other addresses, hostnames and
cross-origin requests remain rejected.

Addresses come from the OS interface and routing tables: IP Helper on Windows,
`getifaddrs` with sysfs and `/proc/net/route` on Linux and Android, and
`PF_ROUTE` on macOS and iOS. Physical links come first, ordered by default
gateway and route metric, so the QR code follows the phone-hotspot or LAN
adapter as v0.7.2 did even when a VPN owns the Internet route. Virtual, VPN, VM,
container and Bluetooth adapters are a single last resort when no physical link
exists. Loopback and cellular addresses are never offered. A PC's Mobile Hotspot
or an iPhone's Personal Hotspot is listed after the upstream link. The legacy
Python Host ranks addresses with the same Rust policy.

## Build and development

Use the repository's Node.js 24 and Rust toolchains. From the repository root:

```sh
npm ci
npm run dev
```

Tauri's development hook and `npm run prepare:desktop` run the independent Rust
build tool:

```sh
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- prepare-desktop
```

This builds both `bilikara-desktop-host` (with `native-host`) and
`bilikara-updater`, then stages them with the existing resources in `_internal/`
beside the shell output. The tool does not link the application Runtime or need
libav to compile. The preparation path, including the hook used by `npm run dev`
and `dev:rust`, invokes no Python. It consumes prepared tool/libav inputs; it
does not rebuild or download them.
The development hook explicitly waits for preparation to finish before starting
the shell, including on a first build or with a shared Cargo output directory.
For direct `cargo run --manifest-path src-tauri/Cargo.toml --locked`, run
`npm run prepare:desktop` first. There is no runtime search through the checkout
or fallback to Python. A development layout may report external tools/libav as
unavailable until explicitly configured.

`--target TRIPLE` (also `npm run prepare:desktop -- --target TRIPLE`) takes
precedence over `CARGO_BUILD_TARGET`; foreign tool/libav targets are rejected.
Cargo metadata resolves output directories, including `CARGO_TARGET_DIR`.
The outer Cargo `--target host-tuple` builds the tool for the current machine,
so a backend target override cannot cross-compile the tool itself; the tool's
`--target` follows `prepare-desktop` and selects the backend/shell output.
The Tauri target hint keeps its existing native-target behavior.
`TAURI_ENV_DEBUG=false` or `0` selects release-profile adjacent preparation and
requires the same complete prefix, BBDown execution/version check and macOS
portability checks as before. Other values retain debug preparation. The
Android/iOS development hook returns without building or staging desktop code.
Source macOS development retains the adjacent `_internal` layout; final macOS
bundle assembly/signing is a separate release step.

For a product build, prepare the existing pinned BBDown vendor on a matching
native runner with Rust and curl, then prepare a matching libav-only prefix with
the documented `media-libav` scripts:

```sh
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- prepare-bbdown /absolute/generated/bbdown-vendor
```

The optional `--platform` / `--arch` retain the existing target aliases. The tool
verifies the unchanged six archive pins before selecting one safe executable,
then checks `--help` in private staging with a 30-second bound. GitHub is tried
before the existing mirror only on transport failure; an integrity mismatch
fails immediately.
`bin/BBDown[.exe]` and the six-field `metadata.env` retain their existing meanings.
Metadata is published last; failed preparation preserves existing output where
possible and never recursively clears the vendor tree. CI sets up the pinned
Rust toolchain and native MSVC environment before this command. It requires no
product build, libav prefix, Python or application Runtime.

Set `BILIKARA_LIBAV_PREFIX` to its absolute path, consume `metadata.env` as build
environment values, and put the prepared BBDown on the **build** PATH, then run:

```sh
npm run build
```

`npm run build` invokes `xtask build-desktop`: release Host and updater, shared
resource/libav staging, compliance materials, Tauri, then final assembly.
macOS signs nested code and the backend, embeds it with `ditto`, preserves
signature metadata and seals the outer app last. No project Python is executed
in this construction path. Release commands always select the release profile
and complete prepared inputs, independent of Tauri's debug/mobile environment.
`--target TRIPLE` supports an explicit matching runner target; foreign tool/libav
architectures fail closed. Cargo metadata resolves `CARGO_TARGET_DIR` and targets.

CI preserves its split backend/tool checks and shell compilation:

```sh
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- build-backend
# Existing npm/Tauri shell build and platform checks.
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- assemble-desktop
```

Assembly consumes the existing release shell output without recompiling it;
`--shell PATH` can supply that compiled executable/app explicitly. All three
release entries share the same rules. Generated outputs default to `dist/`;
`--dist-dir PATH` is limited to repository `dist/` or an isolated subdirectory
of ignored `.tmp/`. Cleanup replaces only the named generated product and
rejects links, input overlap and user-data directories.

The libav prerequisite chain is also Rust-owned. The retained
`media-libav/build-{posix,windows}-libraries.sh` recipes verify the signed pinned
FFmpeg 9.0.1 source, then run the existing configure/make/native compiler recipe.
They use `xtask libav-cache key/snapshot/restore`; schema 3 rotates the former
Python cache identity once. Keys cover the selected C recipe, native target,
compiler/SDK, flags and prefix, without depending on Runtime/companion/UI edits
or the entire xtask executable/lockfile. Only upstream C libraries/headers and
source/license/recipe records enter that cache. Restore validates hashes, paths,
relative links, permissions, provenance and actual library facts before use.

`xtask libav-companion --prefix PATH --out PATH [--test] [--sanitize]` probes the
selected libraries directly and compiles the existing C shim. Windows rejects
sanitizers; POSIX retains ASan/UBSan. `libav-finish --prefix PATH` builds fresh
release `libav_metadata` and Runtime test executables from Cargo compiler-artifact
records, collects native dependencies and writes the prepared manifests. Windows
also supplies the selected `--redist PATH --system PATH` and retains its installed
MSVC licence collection in PowerShell. `libav-collect` shares that collector.
The full POSIX/Windows wrappers compose these stages; Linux CI keeps its lighter
library-plus-companion prerequisite. No project Python runs in either cold or
warm-cache production path. A local `BILIKARA_LIBAV_SOURCE_DIR` may supply the
three pinned archive/signature/key files; signature verification is still required.

The Python BBDown vendor preparer and its dedicated Python tests are retired;
independent pin, archive, HTTP failure and native executable coverage belongs to
xtask, with CI bootstrap/caller coverage in Node. Python remains required by
standalone verification/test drivers in CI, plus independent publication tooling
and legacy/source-mode compatibility adapters.
The replaced Python desktop construction, embedding, libav companion,
cache and collector references and their dedicated tests are retired.
`build_windows.bat` and `build_macos.command` install the locked npm tooling
and invoke `npm run build`; they require the already prepared native inputs,
repository Rust toolchain and native compiler/linker environment.
`scripts/libav_manifest.py` retains the Python
manifest/closure interface for legacy diagnostics and compatibility consumers;
`bilikara.ffmpeg_vendor` forwards to it. Prepared same-build libav provenance,
the pinned BBDown checks and native release artifact gates remain required.

On Linux, the third-party Tauri CLI optionally probes the system's
`lsb_release` before invoking the hook; some distributions implement that command
in Python. This is separate from project-owned preparation. A complete Tauri
development startup also works with Python and that optional utility excluded
from PATH; the system utility and the upstream CLI remain unmodified.

The Rust tool preserves the development preparation contract: version
provenance, `native-desktop.json`, the single vendor tree, Signalsmith notices,
prepared libav manifest/closure/provenance checks, binary import inspection and
rebuild materials. Python source files included as compliance materials are
copied, not executed. `npm run test:desktop-build` runs the Node entry and
construction contracts, using the current Cargo compiler-artifact-selected xtask
and compiled native command fixtures. Complete independent expected inventories
check preparation/full and split release paths, resource bytes, metadata, modes,
links, compliance, failure and preservation cases; the superseded Python drivers
and construction-expectation module are retired. `xtask` also tests foreign
descriptors and macOS tool/signature order. These fixtures do not constitute
native Windows/macOS acceptance. Real Linux release construction and backend
execution are locally exercised; Windows/macOS binary/signature/startup/archive
qualification remains required on native runners.

Real Linux cold source construction, warm restore, companion/shim sanitizers,
reference output comparisons and release consumption cover this prerequisite
slice. Process traces with Python excluded cover the producing chain. Foreign
command/PE fixtures do not qualify Windows MSVC/DLL loading or macOS signing;
their native CI gates remain required. The compliance source kit includes the
locked independent xtask sources and [rebuild instructions](../media-libav/REBUILD.md)
so migrated library/companion wrappers remain usable without the application Runtime.

Replaced Python construction references and the native desktop package gate
are retired, along with desktop construction and libav prerequisite test drivers.
Media-operation and native business drivers now use Node and native artifacts;
remaining legacy Host/FFI consumers are being retired while preserving coverage. Remaining Python verification and publication
entries stay explicit; these cutovers do not publish Preview 3 or retire all CI
Python requirements.

`start_bilikara.py`, `server.py`, `python -m bilikara` and their source launch
scripts still support Source development: Python HTTP/SSE transport around Rust
AppState, yt-dlp orchestration and explicit media-CLI compatibility routing.
The native Host disables yt-dlp and ships no media CLI, so replacing those Source
entries with the native launcher would change their supported behavior.
`scripts/dev_smoke_test.py` exercises these Source routes;
`scripts/libav_manifest.py` still serves `bilikara.ffmpeg_vendor`.
Source HTTP/FFI, loader/result-validation and media-routing tests remain active
Python consumers until their faithful replacements are covered. These are
separate from desktop launch, construction and native package verification.
The retired package gate is implemented independently in xtask. Native business
regressions use `npm run test:native-host` and the test-only Node HTTP/startup
transport, which performs no package inspection. It executes the current locked
host-native Cargo artifact, or the explicitly supplied native Host, with private
data and local providers. Source/queue/login-cancellation media checks require the
real Linux prepared companion and restricted local TLS trust fixture; missing
declared inputs fail. Foreign platform checks remain separate. Historical PyInstaller/Python-runtime
construction helpers and tests solely for those retired interfaces are removed;
native version metadata is unchanged.

`requirements-packaging.txt` remains in the source/FFI test job:
`certifi`/`truststore` serve retained Python HTTPS adapters/tests. The bundle job
does not set up Python. The unused
`pefile` dependency is removed with the Python collector; xtask reads PE imports.
Their presence in the build environment does not put them in native products.

`test:native-images`, `test:native-qr` and `test:native-login` run current Cargo
test/Host artifacts through Node with isolated data and local TLS providers.
The Rust test-only independent QR decoder verifies exact UTF-8/M-level payloads;
full PNG/ZIP decoding, local time, copied fonts, archived-session isolation and
login generations/credentials remain checked. The former Python image/login
suites and Pillow/ZXing requirements are retired. A few live source-adapter
failure guards remain in the source/FFI suites. Linux SSL_CERT_FILE fixtures do
not qualify Windows/macOS trust or GUI behavior.

Release selection, media-page ordering and audio-binding policy regressions run
directly in the Rust Core test suite, with independent expected decisions and
input-permutation checks. Their duplicate Python policy suites are retired;
the still-used Source adapters retain separate validation/failure tests.

`npm run test:native-ratings` runs the current native Host, typed Internet
dispatch and rendered Host/Remote rating controls against a non-forwarding local
TLS fixture. Install its pinned test-only Chromium with
`npm exec -- playwright install chromium`; Linux CI installs the browser and
its system prerequisites before this required gate. It checks authorization,
eligibility, retries, duplicate guards, bounded Catalog contributions and late
completion after reset/shutdown. Synthetic played records qualify these
contracts, not media playback or foreign native window/signature behavior.

`npm run test:native-transport` runs actual Host HTTP and Chromium/WebRTC with
isolated data, verified local TLS and synthetic VP8 test media. It covers LAN/
Internet control queues and ACKs, generation/revision races, slow metadata and
catalog reads, AV adjustment, timeout/reconnect without mutation resubmission,
and room rebuilding. CI runs it once after native inputs and Chromium setup.
`node tests/run_native_transport.mjs --output /isolated/evidence` keeps the
browser receipts. Local SDP signaling does not qualify public STUN/TURN/NAT or
phones. The Python transport/browser drivers are retired; the frontend Node
suite separately verifies failed ACK retry without replaying the seek.

`npm run test:native-media` runs the current native Host and real libav companion
with a restricted local TLS fixture, synthetic FFmpeg-generated test media and
WebKit. Set `BILIKARA_TEST_LIBAV_COMPANION` to the actual native prepared library;
missing, malformed or foreign inputs fail. Install the pinned test browser with
`npm exec -- playwright install webkit`. Playback clocks, login/binding,
LAN/Internet controls, PNG/CSV/ZIP, restart, cache policy/cancellation and a
compiled BBDown command fixture remain exercised. FFmpeg is a test-only generator;
the fixture does not qualify a real provider download. Linux CI runs this gate
after preparing the prefix and installing browser/system prerequisites.

`npm run test:native-shared -- /isolated/evidence --shared-ui` retains the full
shared desktop/Android-profile browser regression, including media/DSP/node
identity, drafts, asynchronous actions and session countdown/restart. A
codec-capable browser and real audio service are required; Firefox is the default,
and `BILIKARA_TEST_BROWSER` can select another installed browser.
`BILIKARA_TEST_ACTIVE_PITCH=1` requires completed real Signalsmith DSP.
This browser profile does not qualify Android devices or native windowing.
An audio/engine failure is a failed validation, not a reason to stub DSP.
`--bbdown-real` instead requires the explicitly supplied pinned
`BILIKARA_TEST_BBDOWN_PATH`; synthetic provider responses alone do not establish
real BBDown/provider compatibility. The Python desktop browser orchestrator is
retired; source Host UI/FFI harnesses remain separate consumers.

`BILIKARA_TEST_TAURI_EXE=/absolute/generated/bilikara/bilikara-desktop npm run
test:native-launcher` executes the assembled Linux shell under test-only Xvfb,
Openbox, xdotool and scrot. It relocates a clean candidate with links preserved,
then checks default storage, an explicit data override, import/restart, real WM
close, supervised Host reaping and listener closure. It rejects a candidate
containing `runtime/` user data. `BILIKARA_REQUIRE_NATIVE_LAUNCHER=1` makes absent
inputs an error; an optional local run explicitly skips without a candidate.
The driver writes screenshots/logs with
`node tests/run_desktop_launcher.mjs /isolated/evidence-directory` using the
same declared executable. Linux execution does not qualify foreign windowing.

`npm run test:desktop-build` exercises native construction with a controlled PATH
without Python, including missing dependencies/provenance, BBDown version
rejection and no application Runtime linkage. CI runs that same command once
after pinned host-native xtask checks and Node setup. `npm run test:libav-wrapper`
checks the actual Bash helper from external source directories and independent
rebuild kits using a recording Cargo command. `npm run test:libav-prerequisites`
requires `BILIKARA_TEST_LIBAV_COMPANION` pointing to a real native prepared
prefix's `bin/` companion; missing, invalid or incompatible input fails. It builds
the current host-native xtask from compiler-artifact output and independently
loads actual libraries with a small C probe. Repeated companion/shim construction,
POSIX sanitizers, Linux ELF collection and C-only cache failure/preservation checks
run without Python. CI runs that required suite after preparing/exporting the
Linux prefix, rather than in the earlier desktop fixture entry. Foreign native
execution remains separate. The remaining
`test_native_build_isolation.py` checks only the legacy manifest adapter.
Explicit media-operation comparison uses `npm run test:media -- ...` with the
same-build **test-only** FFmpeg/ffprobe prefix and documented finite corpus in
`media-libav/COMPARISON.md`, `PACKET_SCAN.md`, `COPY_REMUX.md` and
`FLAC_NORMALIZATION.md`. It selects current locked host-native Cargo artifacts,
executes the real companion and Rust lifecycle tests, and fails on missing
declared inputs. `node media-libav/generate_fixtures.mjs` retains the synthetic
fixture formats; `test:media-fixtures` requires `BILIKARA_TEST_MEDIA_PREFIX`.
These Node drivers replace the Python media comparison/generator. The ordinary
prepared product prefix still disables programs and ships no media CLI.

`npm run test:frontend` runs the current Node VM/command fixtures and frontend
source contracts, including split-player synchronization, SSE ordering, export,
update actions, shared layouts and permissions. Their Python drivers are retired;
these checks do not certify native window geometry or real-device rendering.
`npm run test:remote-sync` checks the production Remote workflow and executes its
PowerShell asset copy into a private destination when available. That workflow
requires the real copy check and no longer sets up Python. Push/deployment filters
and dispatch behavior are unchanged.
`npm run test:auxiliary` covers Signalsmith vendoring, aria2 metadata and offline
publication/workflow failures, including native matrices, prerequisite/assembly
ordering and tag-only uploads. Signalsmith's pinned resource bytes are unchanged.
The macOS aria2 recipe and bundle metadata/README gates use Node; native compiler,
signature and public archive round-trip gates remain required on macOS. AWS CLI
still uses third-party Python for the independent R2 publication jobs. The broader
CI Python setup stays while source/FFI and other live verification consumers remain.

`npm run test:native-http` runs the current Rust HTTP integration binary with
diagnostic requests terminated by a local rejecting proxy. `test:remote-load`
checks the read-only Node SSE load tool, its deadlines/reconnections and native
authorization refusal. Invoke it as `node tools/load_test_remote_sse.mjs BASE_URL
--clients 20 --duration 15`; it sends no credentials and cannot provision access.
The former manual title-cleanup checks are independent Rust unit assertions.

`test:native-catalog` exercises both native catalog adapters and shared caches
with isolated HTTP fixtures. `test:native-smoke` uses compiled native process
fixtures for pipe/deadline/group cleanup and checks the locked Tauri configuration.
Its actual macOS GUI check requires a native app; a foreign runner explicitly
skips it. CI runs `tests/macos_tauri_smoke.test.mjs` as a required gate against
the extracted macOS shell, using private copies and test-owned HOME/data for
both shell and Finder-like launches. Existing signature/architecture/archive
and native backend checks remain separate. The obsolete Python packaged-FFmpeg/
Python-FFI smoke expectations are retired; the native verifier rejects those
payloads instead of requiring them.

Validate an already-produced release package from the pinned repository root:

```sh
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- verify-native-desktop PATH_TO_NATIVE_HOST
BILIKARA_TEST_NATIVE_PACKAGE=/absolute/extracted/PATH_TO_NATIVE_HOST cargo test --manifest-path xtask/Cargo.toml --locked --target host-tuple native_package::installed:: -- --ignored --nocapture
```

The verifier never builds or repairs its input. `BILIKARA_EXPECT_RELEASE_VERSION`
requires that exact release label. It copies the supplied installation, preserving
relative links/modes and omitting portable user data, into owned temporary storage.
The actual Host runs with private data locations, empty PATH and offline proxies;
bootstrap cookies/tokens stay private. Its JSON success report follows layout,
independent-window authentication, resource/HTTP/SSE, capability, successful
shutdown/listener closure and reopening checks. Installed tests also cover legacy
import preservation, platform discovery policy, checkpoint/cache recovery and
invalid-input refusal. Installed tests are marked `ignored` with the actual-artifact prerequisite by
default. Explicitly running them with `--ignored` requires the supplied artifact
and fails if it is absent; omitted tests are not installed-package acceptance. The mandatory verifier fails on absent or
unexecutable inputs. CI supplies the actual extracted Windows/macOS artifact to
both entries, retaining native architecture/signature/archive gates. Linux actual
execution and native fixtures do not replace target-platform bundle acceptance.

The Windows archive keeps the `bilikara/` directory. Its only top-level executable
is `bilikara-desktop.exe`; `_internal/` contains `bilikara-desktop-host.exe`, `static/`,
`vendor/`, `APP_VERSION` and `native-desktop.json`. Licenses, notices, rebuild
sources and guides are together in `license/`. macOS installs `bilikara-desktop.app`;
its `Contents/Frameworks/bilikara-backend.app` contains the backend under
`Contents/MacOS/`, static/version resources under `Contents/Resources/`, and
native libraries/tools under `Contents/Frameworks/` with relative resource
links. Its documentation lives in the embedded backend's `Contents/Resources/license/`.
The archive exposes that directory through a relative `license/` link and keeps
`README-macOS.txt` outside the app; it has no separate backend app shortcut.
The Linux local development layout follows the Windows directory shape,
without `.exe`; this does not establish a new supported release target.

The private `vendor/` is the single third-party resource directory: Signalsmith,
BBDown, libav and its dependency inventory. macOS keeps signed executable code
in `Frameworks/` and exposes it through safe relative links in that resource
`vendor/`; there is no second `Frameworks/vendor/` or `static/vendor/`. The
backend serves only Signalsmith's frontend files from `/vendor/`; native tools
and libraries are not HTTP assets. Own frontend files remain under internal
`static/`, which is not a top-level package directory.

Preview 1 already used `_internal/static/` and `_internal/vendor/`. Its
`_internal/rust/bilikara_rust.dll` and `bilikara_runtime.dll` were Python FFI
libraries; the native backend links the Rust crates directly and does not load
those DLLs. The Python/PyInstaller payload and its app-local API-set/UCRT copies
are not restored. Native packaging retains the actual private DLL dependency
closure in `vendor/` and uses Windows system API sets/UCRT. The pinned Windows
downloader keeps the published filename `vendor/BBDown.exe`, independent of
`PATH`/`PATHEXT` capitalization during discovery.

`_internal/` groups installed program files with the native Rust backend and no
Python payload. Windows again creates a writable `runtime/` beside it, with
native records/cache/managed tools in `runtime/data/`, shell startup logs
in `runtime/logs/`, WebView browser storage in `runtime/webview/`, and window
preferences in `runtime/main-window-geometry-v1.json`. This directory is created on use, never shipped in an update
archive. macOS retains the system user-data directory outside the signed app.

Desktop audience video geometry is recorded as `presentation_video_geometry` in
the shell's `desktop-startup.log` (Windows: `runtime/logs/desktop-startup.log`).
Records contain the presentation generation and per-window video sequence,
intrinsic `videoWidth`/`videoHeight`, video/frame DOM bounds in CSS pixels,
WebView inner/outer sizes and device pixel ratio, plus native window inner/outer
physical sizes and scale factor. Media URLs, titles and credentials are excluded.
Mount/metadata, intrinsic-video resize and viewport/element resize trigger
frame-coalesced, deduplicated snapshots; playback-clock updates do not poll or log
geometry. Native writes use the existing bounded, nonblocking diagnostic queue.
The audience Grid has one `minmax(0, 1fr)` track on each axis, and the video has
zero minimum dimensions with `object-fit: contain`, so portrait media cannot
inflate the track beyond the output viewport. Resizing does not replace media.

The offline regression `node tests/browser/presentation_video_geometry.cjs`
uses test-only Playwright and browser-recorded portrait/ultrawide fixtures with
the real audience page. It covers 1280x720, 720x1280 and 1600x600 viewports,
DPR 1.5, source changes, geometry payloads and log failure isolation. The original
portrait failure expanded a 1280x720 stage's video element to about 1280x2276;
the fixed element stays within the stage. Physical multi-display/WebView device
acceptance remains separate from this browser regression.

Fixture recording paints twelve changing frames over approximately 1.2 seconds
and waits for the final recorder data before releasing its tracks. Each WebM
must be nonempty and decode a frame at its expected intrinsic dimensions in a
separate video element before entering the audience layout checks. The bounded
preflight reports fixture dimensions, byte count and the decoder error directly;
it never retries or skips the unchanged geometry assertions. This replaces the
short single-frame recording that intermittently failed in Edge before any layout
assertion. It adds no application dependency, bundled media or production change.

Fixture follow-up validation (2026-10-02, Windows / Edge 154.0.4258.53):

- `node --check tests/browser/presentation_video_geometry.cjs`: passed.
- `node tests/browser/presentation_video_geometry.cjs`: ten consecutive complete
  runs passed using the existing Playwright installation (`NODE_PATH` configured).
- `python -m unittest tests.test_controller_frontend tests.test_presentation_tauri_source -v`:
  27 passed.
- `git diff --check`: passed.
- Read-only, in-memory Node fault injection confirmed that empty WebM, corrupt
  WebM and incorrect expected dimensions all fail explicitly before layout
  assertions. A source comparison confirmed that all original geometry and
  lifecycle assertions remain unchanged.

This test/documentation-only follow-up changes no Python or Rust production
logic. The full release gate, bundle builds and physical-display/device acceptance
were not rerun; these checks do not establish a new application release result.

Bundles contain no Python interpreter, PyInstaller payload, temporary Python
FFI libraries, FFmpeg or ffprobe executables. BBDown stays pinned and vendored.
aria2c uses the existing Rust preparation and managed-tool policy; macOS carries
the pinned download manifest rather than making aria2c a required bundled file.
Libav is discovered from the installed resources and configured through typed
Rust services before workers start. Broken packages fail explicitly.

## Build identity and update channels

The displayed version and updater both use the bundled `APP_VERSION`, not the
numeric version in Cargo, npm or the Tauri package. Clean release/preview tag
builds retain labels such as `v0.8.0` or `v0.8.0-preview.1`. Local branch builds
and CI branch checkouts use `<branch>-g<12-character commit>`, for example
`work/v0.8.0-gabcdef123456` or `dev-gabcdef123456`. Modified tracked files,
staged changes or untracked non-ignored files append `-dirty`. Even a dirty tag
checkout gets the commit/dirty suffix. A local branch pointing at a release tag
still remains a branch build. Detached untagged checkouts use `dev-g<commit>`;
missing Git provenance uses `dev-gunknown` rather than inventing a release.

`BILIKARA_VERSION` remains an explicit trusted build/launcher override and takes
precedence; setting it to a release label deliberately changes the updater's
classification. Ordinary builds should leave it unset. Build labels are bounded
to 80 ASCII characters; unsupported branch-name characters are replaced by `-`
and long branch names are truncated while preserving the commit/dirty suffix.

The shared Rust release policy accepts only `v?MAJOR.MINOR.PATCH` and
`v?MAJOR.MINOR.PATCH-preview.N` as release versions. Branch names, `dev`, Git
suffixes and dirty suffixes are development versions: they offer switching to
the latest stable release, or to a preview when the preview channel is enabled.
This can select a numerically older published release than the branch's package
version. A numeric `0.8.0` build would instead be treated as stable and suppress
that switch when the latest published stable is `0.7.2`.

OS metadata stays numeric and does not include a commit hash. The staging
manifest's `development` flag still describes the debug/incomplete resource
layout; it is independent of the updater's development-version classification.
A complete release-profile build from `work/…` can therefore have
`development: false` and still correctly report a development version.

## Data and import

Default writable native roots are:

| Platform | Native root |
| --- | --- |
| Windows | `runtime\data` beside `bilikara-desktop.exe` |
| macOS | `~/Library/Application Support/bilikara/data` |
| Linux | `$XDG_DATA_HOME/bilikara/data`, or `~/.local/share/bilikara/data` |

New Windows installations select `runtime/data` beside the launcher and keep media
in `runtime/data/cache`. macOS/Linux keep their existing application-home location
and use its `data/` child. An existing earlier native preview's `native/` root is
still reopened when `data/` has no native checkpoint; data is never silently
merged or discarded. With the application closed, that native-format directory
can be renamed to `data/` if the destination does not exist. Its old `media/`
cache is renamed to `cache/` under the storage lock on desktop startup.

New installations do not create `.bilikara-desktop-rust-preview`. The versioned
`host-state.json` checkpoint identifies native data and is strictly validated
before startup; old preview markers are accepted only for compatibility.
`desktop-import.pending` exists only during explicit import. An interrupted
import is rejected, and successful import removes it. Legacy split-file records
still require explicit read-only import into a new destination.

Keep the installation in a writable directory and move its complete `runtime`
directory with it. Read-only installations fail rather than falling back to
AppData. macOS retains its user-data location outside the signed app.
The application controls these data paths; Windows and the installed WebView2
runtime may still maintain their own system-level files.

Use an absolute `BILIKARA_NATIVE_DATA_DIR` for isolated development.
The earlier `BILIKARA_DESKTOP_RUST_PREVIEW_DIR` remains a data override alias;
it no longer switches backends. Trusted `BILIKARA_HOME` is also accepted as a
native root override. The direct backend's `--data-dir` takes precedence. For an
explicit Windows shell override, WebView storage uses an adjacent `<native-directory>.desktop`
directory so it cannot contaminate a new import destination before enrollment.
Existing native checkpoints remain valid; the old preview marker is no longer required.

Desktop windows initially load the script-free `desktop-startup.html`, then
navigate to the authenticated Host once its ready event arrives. The full Host
UI only initializes at that backend origin. Export font discovery/prewarming
runs as a supervised background worker; immediate image exports share its font
cache, while CSV and ordinary Host use do not depend on successful prewarming.
An unselected aria2 downloader is also probed in the background without installing
anything. A saved DownKyi selection still prepares its required tool before cache
scheduling begins. Both background workers are joined during Host shutdown.

Existing native records take precedence. A nonempty directory without a native checkpoint (or an old valid preview marker),
or a malformed checkpoint, is refused, never treated as an empty library. On macOS/Linux,
known legacy data without native records produces an explicit import instruction.
Windows starts independently in its portable directory; importing older records
is optional. The installer does not silently merge, overwrite or delete legacy files.

Choose a **new, nonexisting** destination with an existing parent. It cannot
overlap the legacy source. From the installed backend's directory:

```sh
./bilikara-desktop-host --data-dir /absolute/new-native-root \
  --import-from /absolute/legacy-app-home
```

On Windows run `_internal/bilikara-desktop-host.exe` from the installation root;
on macOS use the executable inside
the embedded backend app. Packaged assets resolve automatically, independent of
the working directory. For shell launch, set `BILIKARA_NATIVE_DATA_DIR` and
`BILIKARA_DESKTOP_RUST_IMPORT_FROM` to those paths. Import reads the old source
only, preserves supported records/settings and uses the existing continue/new
session choice. Media is re-cached through fresh native identities. Subsequent
launches reopen native records without reimporting, even if the old source has
changed or disappeared. No login, catalog upload or automatic refresh is caused
by import. More elaborate automatic upgrade selection remains separate work.

### Optional Windows import from an earlier installation

Normal startup does not require importing AppData. If older records should be
retained, choose their location explicitly. For an old
`%LOCALAPPDATA%\bilikara` root, open PowerShell in a **new extracted installation**
whose `runtime/data` does not yet exist:

```powershell
$env:BILIKARA_NATIVE_DATA_DIR = Join-Path (Get-Location) "runtime\data"
$env:BILIKARA_DESKTOP_RUST_IMPORT_FROM = Join-Path $env:LOCALAPPDATA "bilikara"
try {
    Start-Process -FilePath .\bilikara-desktop.exe -Wait
} finally {
    Remove-Item Env:BILIKARA_NATIVE_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:BILIKARA_DESKTOP_RUST_IMPORT_FROM -ErrorAction SilentlyContinue
}
```

The source is read-only. Afterwards, double-click the launcher to reopen the
portable records without overrides. If the source is another installation's
`runtime`, substitute that absolute source path. Source and destination must
not overlap. Existing native checkpoints can instead be copied, with both
applications closed, into a new installation's `runtime/data`; never merge
them with another native directory.

This engineering guide stays in the source repository. It is not shipped in
`license/`, and startup errors do not direct users to a bundled copy.

The private bootstrap capability is delivered only over the supervised child
pipe. Direct backend execution prints that private readiness message for a
trusted caller; it does not launch a browser. Normal desktop users launch the
Tauri application.

Packaged Windows/macOS applications support explicit update/download/restart
from the existing update controls. Version/channel eligibility is separate from
package compatibility: an archive needs a bounded size and published SHA-256,
the matching native layout/version/architecture, all required resources and
libav dependencies. macOS also verifies the candidate's code signature before
activation. An older Python/PyInstaller package is refused even when the
preview-to-stable policy selects that release. Linux and source-development
launches offer checks and a release-page link for manual updates.

Download and preparation can be cancelled. Once the main desktop window commits
replacement through its private shell capability, cancellation is unavailable.
Replacement is performed by the external updater, `bilikara-updater`, which
every Windows/macOS package ships beside its backend
(`_internal/bilikara-updater.exe`, or `Contents/MacOS/bilikara-updater` inside
the embedded backend app). After validating the downloaded package, the Host
copies the installed updater into the update workspace, writes `plan.json`
there and starts it detached: on Windows it inherits no handles and leaves the
Host's kill-on-close job; a denied breakaway fails the update instead of
starting a helper that would die with the Host. On macOS it starts a new
session. An installation
without an updater offers manual updates only. Already installed releases
predating the updater still execute their own generated CMD/shell helper;
downloading a new package cannot repair that old executable's update logic.
For published Preview 2, see the one-time replacement instructions below.

Before the shell tears down presentation or exits, the updater reads and
validates its plan, opens its workspace log and prepares to wait for the owned
backend and shell (pinning their process handles on Windows). A private,
attempt-bound readiness/acknowledgement exchange in that workspace is bounded
to ten seconds at the Host. A launch error, early exit or readiness timeout
keeps the application running and reports a retryable failure. The Host stops
only the updater it just created on failure. An updater without the Host's
acknowledgement cannot replace files, even if the user later closes the app.
The shell's activation request allows thirty seconds for startup, failure
cleanup and the Host response; other private requests retain their timeouts.
These are private handoff files; the `--plan` entry, plan schema, public APIs,
package layout and release metadata contracts remain unchanged.

After acknowledgement, the updater waits for the owned backend and shell to
exit (without ever terminating one), stages a sibling installation, moves the old one aside
as `.previous-update-*`, moves the new one into place and opens it. A file or
folder still held open is retried for about 30 seconds, including the final
replacement and rollback renames. File changes run only after both owners
exit. A failure before commit restores or retains the old installation and
reopens it when restoration succeeds. If restoration itself fails, both the
previous installation and staged package remain for manual recovery, with
their paths in the log; the missing installation is not launched. Portable
Windows recovery logs stay with the data in the previous installation, and
the workspace remains available; logging does not recreate an empty install
directory that would obstruct restoring the backup. An owner
that never exits leaves everything
unchanged and nothing is reopened. Before reopening, the updater keeps its
timestamped log as `update-logs/<operation>.log` under the data root and writes
`update-logs/last-result.txt` (`installed`, `failed` or `owners_running`).
`installed` means that files were replaced, not that the new application became
ready. If automatic reopening fails, the installed files and backup remain;
the next manual launch reports that restart failure with the kept log path.
The next Host consumes the result once and cleans an owned workspace only
after the updater finishes; recovery workspaces and older workspaces without
completion evidence remain available. The log stays. The relaunched application does not inherit the old
shell's private Host variables. This is not a general crash-rollback guarantee.
After checking the new installation, the user may remove that previous
application directory.
Data remains separate from immutable program resources. On Windows the helper
preserves the existing `runtime/` only after both processes exit; its own
workspace stays outside the installation being replaced. An archive containing
`runtime/` data is rejected. External application-data roots remain in place.
Inside the Windows installation only the documented `runtime/data` root is
supported for automatic updates; other nested data overrides require manual
replacement with explicit data preservation.
The audience window, Remote and ordinary HTTP cookies cannot initiate or commit
a desktop installation. Manual release links open a validated web URL through
the shell, without navigating the player away.

Preview 1's Windows Tauri archive extraction/relaunch names remain compatible
with the native archive; legacy data still requires the explicit import above.
Preview 1's macOS extractor does not preserve bundle symlinks, so that transition
requires manual replacement with the intact native app and explicit data import.
Native-to-native macOS updates preserve safe relative bundle links. The current
native installer recognizes the current `_internal/` layout and the earlier
flat and `backend/` Windows native layouts. Earlier development candidates
whose validator rejects `_internal/` as a Python directory require manual
replacement to reach this layout; they cannot acquire new validation rules
before installing it. Their existing native data can reopen
without importing it again. Preview 2 has been released. Subsequent updater
changes still require real package installation and platform acceptance;
Linux fault-injection tests do not verify Windows Job behavior or macOS signing
and relaunch behavior.

### One-time full-package replacement from published Preview 2

The published `v0.8.0-preview.2` assets come from `3d5a8c6`, before the external
updater. Its Windows helper passes canonical `\\?\C:\...` paths directly to
CMD directory changes and relaunch commands. This old path can fail before
replacement or reopening; a newer package does not retroactively fix it.
Use a full-package replacement for this Windows transition. The macOS first
transition also needs native platform verification; full-package replacement
is available there without changing existing native data.

1. Close Bilikara's desktop windows and wait for its Host/updater to exit.
   Keep a backup of the complete old installation and all configured external
   data roots. If a previous attempt left `.previous-update-*` or
   `.incoming-update-*` directories, retain them until the recovered session
   has been checked; do not combine competing data copies.
2. Download the complete package for the same OS and CPU architecture from
   [GitHub Releases](https://github.com/VZRXS/bilikara/releases), then extract
   it into a **new sibling directory**, keeping its packaged directory structure.
   Do not overlay immutable files onto the old installation.
3. **Windows:** copy the entire old `runtime/` into the new installation beside
   `bilikara-desktop.exe`, before the first launch. This includes `runtime/data/`,
   caches, credentials, WebView storage, window preferences and logs. Also carry
   over existing top-level `data/` and `updates/` if present. Keep custom data-root
   overrides and any adjacent `<native-directory>.desktop` storage unchanged;
   an override inside the old installation must point to the corresponding
   preserved directory at its final location. Never delete `runtime/` to upgrade.
4. **macOS:** retain the intact new `bilikara-desktop.app`, including nested
   bundles and relative resource links. With the app closed, keep the old app
   as a backup and put the complete new app in its place using Finder (or
   `ditto`). Leave `~/Library/Application Support/bilikara/` and any configured
   external data root intact. Native Preview 2 data needs no legacy import.
5. Open the new desktop launcher, check its displayed version and confirm the
   intended session, queue, settings and cached media. Keep the backup until
   these checks pass. Update shortcuts to the new location if it changed.

New native data roots default to 1080P high frame rate with Hi-Res preferred;
saved or explicitly imported quality preferences remain unchanged. Settings
also offers a Host-only diagnostic ZIP through the existing native save dialog
(or browser download). It uses the shared sanitized diagnostic renderer and
bounded connectivity probes; it does not include login checkpoints or credentials.

## Shared Catalog pagination

The Rust Catalog reader explicitly requests `format=paged` for search,
category-song windows and songs within a selected name/artist group. A compatible
Worker returns `matched_count`, `offset`, `next_offset` and `has_more`; the existing
Host and Remote views use those fields without requesting a separate count or
downloading the entire library. An older Worker may ignore the opt-in and still
return a capped array; the client retains that limited-result behavior and does
not invent a total or treat repeated first-page data as a subsequent search page.

Unselected name/artist group lists stay on the legacy protocol until their
client data loading supports server-side group windows and counts. Enabling song
pagination does not deploy the Worker or apply its database migrations.

## Song ratings and request contributions

Host-selected session users and identity-bound Remote users can rate a current
or played song through the shared Rust rating service. HTTP and typed Internet
Remote commands use the same bounded pending/completed ledger. A `queued: true`
response acknowledges a score held by the Host until playback eligibility;
only Catalog acceptance completes delivery. While an entry is `waiting`, the
same user may replace its score under the AppState lock. Once sending starts,
replacement is rejected; failures release the reservation for an explicit retry.
The `song_ratings` snapshot includes `score` alongside `status` so Remote can
reopen the saved value. Remote always labels its entry “评价” and permits viewing
the dialog; eligibility disables its confirmation button rather than the entry.
This is session-local duplicate protection, not durable
exactly-once delivery across crashes or ambiguous network failures.

Each successfully committed explicit song request can enqueue its seven public
metadata fields through the existing bounded Catalog append worker. Failed,
duplicate or stale adds do not enqueue. A full queue or delivery failure does
not undo the local request. Neither login, startup nor library import triggers
bulk publication. `song_rating` describes this ordinary action.

## Administrator operations and cache diagnostics

The native Host retains review, blacklist restore, tag reset, video/UP deletion
and explicit maintenance routes through the shared Rust Catalog service.
`catalog_write` and `maintenance` describe available operations, not authorization:
requests require the local Host identity and administrator-secret verification.
LAN and Internet Remote identities cannot invoke them, even with an admin secret.
`tagger-yomi` starts the existing Worker job. `monthly-d1-refresh` is a supervised
Rust task: it exports Catalog once, combines configured and exported UP IDs,
probes first pages, skips UPs above 8000 submissions, and uploads only missing
karaoke entries in authenticated batches of at most 500. It reuses probe pages,
waits between subsequent page/UP requests, retries failed pages at most three
times, and rejects duplicate local starts. Shutdown stops further work after
in-flight bounded network calls return; no Python runner is launched. This job
is never scheduled by startup, login or ordinary local-library refresh.
Summary-only progress and outcomes are recorded in `logs/monthly-d1-refresh.log`;
credentials and upstream bodies are excluded.

The separate administrator CLI is `npm run catalog:refresh -- [options]`.
It builds the current host-native `bilikara-catalog-refresh` with the locked
repository toolchain. It preserves the source maintenance command's local/D1/
union UID selection, latest/page-any probe, filtered-page traversal, bounded
upload batches, dry-run and configurable retry limits (zero is unlimited).
Set `BILIKARA_ADMIN_SECRET` in the environment; the secret is never a CLI argument.
The retained Source Host transports this job to Rust, including its process-wide
duplicate-start guard. The native Host's supervised job above keeps its existing
fixed recipe and shutdown policy. Neither command runs automatically or acquires
credentials. `test:catalog-maintenance` checks the CLI against isolated services.

Cache tasks append to `logs/<source>/<item_id>.log` under the data directory,
where source is `native`, `bbdown` or `downkyi`. Lines use local timestamps and
start with the song title. Logs are not merged or truncated at 1 MiB; orphaned
song logs are removed after the item leaves the current song/playlist and its
worker has drained. AppState snapshots and
typed Internet Remote projections include aggregate downloaded/total bytes and
ordered per-track progress. An unknown total remains zero until all track sizes
are known. These transient fields are reset with a new attempt, terminal event
or data reopen; Host and Remote do not reconstruct them from diagnostic text.

Manual cache retry preserves the observed item incarnation and the caller's
`force` flag across local and Internet Remote transport. Ready items require
`force`; only pending, queued, downloading, failed or ready items inside the
current automatic cache window are eligible. Admission rechecks these conditions
under the worker/AppState locks before reserving a replacement attempt. Normal
manual retries enter the front of the normal queue. Only a forced retry of the
current song while a different song occupies the primary worker uses the urgent
lane; `force` does not bypass cache-window or backend capability checks.
An explicit forced repair retires the old playback program immediately; a
failed repair does not republish it. Automatic preference replacements keep
the readable artifact until a validated replacement is published, including
when the replacement attempt fails. The native package tests cover both paths.

### Audit compatibility decisions

Native checkpoints now use schema 3. `host-state.json` atomically publishes a
manifest; growing history, played records, session archives, backup records and
all saved per-user Gacha preferences live in immutable, hash-checked pieces of
at most 1 MiB in `host-records/`. Schema 1 and 2 are read automatically and
converted on the next state write during startup. The original manifest bytes
are saved once as `host-state.v1.backup.json` or `host-state.v2.backup.json`;
record pieces referenced by the schema-2 backup are retained. Older binaries
cannot read schema 3. To roll back, fully exit the app, copy the complete data
directory to a separate backup, then restore the matching old manifest over
`host-state.json` before starting the older version. This restores the state at
the first upgrade, not subsequent edits. A new schema-3 installation has no old
manifest backup. Migration preserves the loaded configuration; it cannot recover
preferences already discarded by an earlier build.
Copy the whole data directory, including `host-records/`, when backing up or moving data.
The queue retains its admission limit; historical collections no longer share
that queue limit. Resetting runtime data preserves played archives and resets
all users' Gacha preferences to defaults.

Gacha weights and exclusions belong to AppState and persist per singer. Host
requests may name the selected singer with `requester_name`; LAN Remote uses its
registered identity, and Internet Remote uses its validated session identity.
Unregistered LAN devices and Internet peers have isolated, temporary preferences;
LAN registration adopts these into the singer's preferences if none exist yet.
Registered device bindings retain up to 256 devices, reclaiming older bindings
without refusing new visitors. An evicted device can register again. Temporary
preferences retain at most 256 keys and do not enlarge the checkpoint. Saved
user preferences are neither evicted by user count nor limited to 64 KiB; they
use the same split-record storage as history. Host requests may select only a
singer in the current session. Registration commits the singer, device digest
and adoption of temporary preferences atomically; a failed commit changes none
of them. Preferences can change during a refresh: newly discovered sources join
the available list, while saved weights and exclusions remain in effect. Sources
temporarily absent from the list retain their exclusions. An explicit pool reset
clears exclusions. On startup the old `gatcha_pool_config.json` is imported into
AppState defaults if missing, then renamed to `gatcha_pool_config.legacy.backup.json`
without overwriting an existing backup. Future writes use AppState only.


A failed or partial manual refresh releases its cooldown immediately. The next
manual refresh prioritizes failed UIDs and still refreshes every configured UID
and favorite folder incrementally, preserving a complete summary; successful scans use
a 60-second cooldown. Source preview/import does not consume that cooldown.
Favorites refresh reads through the prior folder checkpoint, including more
than one page of additions. Its new entries join the existing incremental UID
append; cloud publication remains the existing bounded, best-effort queue.
Explicit source imports also append only additions. Legacy schema rebuilds compare against the published local cache and append
only newly discovered UID/favorite records, without reuploading existing data.
Anonymous users may preview/import public favorites. Restricted favorites still
use Bilibili's access checks. Corrupt source configuration is backed up without overwriting earlier backups,
valid UID/profile entries are salvaged where possible, defaults are restored when
needed, and a Host toast reports recovery. Unknown future versions fail explicitly
without replacing the source file. A newly verified Bilibili account triggers its
initial library refresh even during the previous account's success cooldown;
repeated login refreshes for the same account respect the normal cooldown.

Cloud reads retain two concurrent upstream requests, coalesce identical reads,
and wait within a bounded deadline instead of immediately rejecting overlap.
Bilibili JSON reads share a process-wide four-request limit and 250 ms start
spacing; identical requests share a result within the same credential/header
scope. Queued distinct reads use FIFO admission; refresh pagination waiters
observe cancellation within 50 ms. A request already performing network I/O
still uses its bounded network timeout. Repository page pacing (5 seconds for submissions, 3 for favorites) and
bounded retries remain in force. DownKyi retries transient media validation
failures within its ten-attempt budget; terminal authentication/capability errors
remain terminal.

BBDown and Native can attempt guest downloads; upstream access restrictions still
apply. DownKyi retains its login requirement. BBDown can preserve an EAC3-only
audio track on native desktop too. Its progress reports observed media/temporary
file lengths once per second; total bytes remain unknown until the artifact is
complete (this is not an exact wire-byte counter). yt-dlp interfaces remain,
but both `yt-dlp` and `ytdlp` selections are unavailable: status reports disabled,
and prepare/selection return 501 `cache_source_unavailable`. No native yt-dlp
process is launched. Updates have no fixed total download deadline;
read timeouts, cancellation and size checks remain active. Diagnostic exports
redact OS login names from `USERNAME`, `USER` and `LOGNAME`, as well as singer names.
They include bounded configuration snapshots, tool availability, cache item state,
and the shell startup log passed through `BILIKARA_DESKTOP_STARTUP_LOG`. The shell
log includes backend stderr and diagnostic/export stage timings. Log tails are
limited to 64 KiB each, selected configs to 1 MiB, and symlinks are skipped.
Diagnostic filenames include the local timestamp.
Both HTTP and Internet Remote remove cloud entries only after upstream `-404`;
deletions share a limit of eight distinct videos per minute, deduplicated by BV.

`BILIKARA_BILIBILI_COOKIE` is a launch override, validated with Bilibili before
use. An invalid/unverifiable override leaves saved login intact. Manual Cookie
configuration also validates login and replaces the active credential. Logout
clears the active credential and saved login; logout or a successful QR login
records only the dismissed environment value's digest, preventing that same
value from reappearing after restart. A different environment value is a new
override. Desktop QR credentials remain in `BBDown.data`; active credentials are
passed to BBDown through its `-c` argument. `bilikara_native` is a separate local
Host/Remote browser identity cookie and is never a Bilibili credential.

Zero or missing playback duration is accepted as a transient observation.
Playback commands keep working; history-start and rating-threshold transitions
wait for a positive observed duration. No duration from an earlier observation
is substituted.

Closing the desktop main window or using native menu Quit checks native exports, including Remote export
transfers. While an export is active a native OS dialog offers forced exit or
continuing the export. Forced exit skips the export grace period; normal backend
shutdown still has a bounded cleanup period. On Windows the Host owns a
kill-on-close Job Object and watches the shell process handle. Download children
inherit the job; if shutdown hangs after shell death, a five-second watchdog
exits the Host so the owning Job handle closes. The explicitly detached update
installer can finish after Host exit. Windows process behavior and native dialogs still require platform testing.

The supported HTTP surface follows this repository's Host/Remote callers.
Registered LAN Remote actions include remove/play-now/move-next in the
queue, recent-session listing, and exporting current or archived sessions. Raw
export-data projections and queue-wide clearing remain Host-only; Internet
Remote still does not expose file export.

### YouTube quick-request input

Host, local Remote and public Remote accept YouTube `watch?v=…`, `youtu.be/…`,
`shorts/…`, `live/…`, `embed/…` and legacy `v/…` video URLs, including mobile,
music and privacy-enhanced embed hosts. Scheme-less YouTube links and pasted
share text are accepted. Timestamps, tracking and playlist parameters are
removed when creating the canonical single-video URL.

Share text may contain one distinct YouTube video; repeated links to the same
video are harmless. Multiple different video links prompt the user to keep one.
Playlist/channel-only links and invalid video IDs are rejected. The `live/`
URL form accepts completed recordings; active live streams retain the existing
unsupported status. URL recognition does not bypass video availability or
playback compatibility checks.

Rust owns input normalization; the public Remote transport extracts the same
catalog identity. Both parsers run `tests/fixtures/youtube_inputs.json`.

### Queue ordering rules

The current program is separate from the waiting queue. Queue ordering is owned
by Rust AppState and serialized with admissions and playback transitions; a
successful sort moves existing item IDs and their complete payloads, rather than
reconstructing or removing requests.

| Action | Waiting-queue behavior | Current program |
| --- | --- | --- |
| Ordinary request (`点歌`) | Insert a `cycle` item into the singer rotation, leaving existing items in relative order. | Starts the item only when there is no current program. |
| Queue next (`顶歌`) | Move the selected ID to index 0 as `priority`. Multiple queue-next actions put the most recently committed action first. Repeating an action on the same ID does not duplicate it. | Unchanged. |
| Drag / move to position | Move the selected ID to the requested final zero-based index (clamped to the current queue bounds), mark it `manual`, then rebuild the remaining cycle slots. Moving to its existing index leaves its slot type unchanged. | Unchanged. |
| Default sort (`重新排序`) | Clear every `priority` / `manual` marker, including a queue with just one waiting song, and rebuild singer rotation. Within each singer, preserve the songs' **current** relative order, not their original request order. | Unchanged. |
| Next song | Take waiting index 0 as the new current program, then rotate the remaining cycle slots from that singer. Stale or repeated playback-generation commands are rejected. | Finishes the previous program. |
| Play now (`立即播放`) | Remove the selected waiting ID and make it the current program immediately. | Finishes and replaces the previous program. This is a different action from queue next. |

Singer rotation follows the session seating order, starting after the current
program's singer and wrapping around. For singers A/B/C with A currently singing,
ordinary waiting songs alternate B/C/A, skipping singers with no waiting song.
Only registered singers' `cycle` items participate. During a cycle rebuild,
`priority`, `manual`, and unregistered-singer items keep their occupied slots;
explicit moves, insertions ahead of them, and playback can still shift their
numeric positions. A new ordinary request is inserted after all existing fixed
slots, so a manually moved song near the end can delay an otherwise earlier
singer turn until default sort clears that marker. Removing a singer does not
remove that singer's queued songs.

Cycle counts use currently waiting cycle songs, not historical plays. A singer
with no waiting songs can return after several empty rounds without accumulating
an old turn count. Readding a deleted singer's name makes that singer's retained
cycle songs eligible for rotation again. Changing seating rebuilds cycle slots
without releasing existing priority/manual markers.

For example, with A singing and A1/A2/B1/B2 waiting, topping A2 and then default
sorting yields B1/A2/B2/A1. Default sort restores alternating singers, but keeps
A2 ahead of A1. Repeated priority actions can postpone ordinary requests; there
is no priority quota or automatic timeout.

Concurrency boundaries to keep in mind when interpreting feedback:

- Host, LAN and public Remote bind a drag confirmation to the displayed queue's
  `queue_version`, including item incarnations, singer seats and slot types. Rust
  checks it under the mutation lock. A changed queue rejects the old destination;
  cache progress, metadata and player settings do not invalidate it. Identical
  ordering policy and item incarnations have the same content token.
- Top, positional moves and Play now reject a no-longer-waiting ID with
  `queue_item_missing`; removing an absent ID also fails. A valid move to the
  existing index remains a successful no-op and preserves its slot type.
- Internet Remote projects the full queue and history, without the former 1,000
  item truncation. Positions cover the full 10,000-item core capacity. The shared
  transport splits messages into bounded frames, supports up to 32 MiB per
  transfer and bounds pending receive buffers to 64 MiB. Oversized messages fail
  explicitly; they do not silently hide tail items.
- Finished programs have session-play ledger entries. A program that never
  started can be absent from the eligible history list after Next/Play now, even
  though sorting itself never removed it. Duplicate-request checks cover active
  songs and started songs in this session's history, across all singers. An
  unstarted skipped song can be requested again; repeating an active/recorded
  song requires the explicit repeat confirmation.

Regression coverage in `rust-runtime/tests/native_playlist_stress.rs` checks singleton
marker resets, repeated priority actions, per-singer relative order, concurrent
native callers, and conservation across admissions, moves and playback changes.
The same actual AppState suite adds deterministic random user counts,
seating changes, additions/removals/renames, returning singers, concurrent roster
changes and admissions, empty/full rosters, duplicate/repeat rules, invalid
targets and stale playback commands. `tests/native_host_business.test.mjs` checks
the real persisted roster/queue and fresh incarnations across process restart.
Every successful admission must remain in
the active queue/current program or have an ended session-play ledger entry.
Expected waiting IDs and ended IDs are accounted for from the submitted action,
so an unexpected removal cannot pass merely by being recorded as ended.

The shared AppState bounds the current program plus waiting queue to 10,000
items. Both ordinary and priority admissions enforce this bound under the state
lock, including when the current slot is empty. Desktop Host is exempt from
Native Beta's separate 200-waiting-song HTTP limit. Rejected admissions do not
evict an older song or write an unrestorable oversized backup.

Replay the larger deterministic run (100 random sessions × 500 steps, plus eight
concurrent sessions with eight callers × 96 steps each):

```bash
npm run test:playlist-stress -- --stress
```

`--seeds`, `--steps`, and `--concurrent-sessions` adjust this opt-in run; ordinary
Rust test discovery keeps a smaller regression workload. The Node entry selects
the current locked host-native Cargo test artifact; it needs no Python/FFI adapter.
Successful pressure
tests establish the checked invariants for those runs, not a diagnosis of a
historical user report without its operation trace.

These legacy routes remain unavailable (501 `native_unavailable`):

| Legacy route | Current in-repository workflow |
| --- | --- |
| `/api/playlist/move` | Ordered drag/drop through `/api/playlist/reorder` |
| `/api/backup/restore` | Session-choice continuation; no direct restore caller |
| `/api/player/av-offset` | `/api/player/av-delay-action`, `type: set_persistent` |
| `/api/mode` | Local playback is the supported mode; the old mode button is hidden |
| `/api/player/playback-selector` | Retired playback-selector interface |

Short-link redirects keep complete-domain Bilibili validation. Metadata keeps
`/x/web-interface/wbi/view`; the unsigned request was confirmed to return valid
metadata during this audit, so no speculative endpoint change was made.

### Compatibility environment and exports

| Legacy input | Native behavior |
| --- | --- |
| `BILIKARA_HOST` | Bind to the requested local IPv4 address or IPv4 hostname; an explicit LAN bind retains a separate loopback listener for the shell. Default: all IPv4 interfaces. |
| `BILIKARA_PORT` / `--port` | Standalone native launch accepts 0–65535; an explicit CLI argument wins. The desktop shell continues to pass `--port 0` for automatic allocation. |
| `BILIKARA_MAX_CACHE_ITEMS` | First-run default, clamped to 1–5; saved preferences take precedence. Unset defaults to 3. |
| `BILIKARA_APP_RELEASE_API_FALLBACKS` | Additional stable release metadata URLs. |
| `BILIKARA_APP_RELEASES_API_FALLBACKS` | Additional preview release metadata URLs. Both lists accept comma, semicolon or newline separators and HTTP(S) only. |
| `BILIKARA_UPDATE_DOWNLOAD_PROXY` / `_FIRST` | Restore the existing proxy template and proxy-first ordering, with ordinary download fallbacks. |
| `BB_DOWN_PATH`, `ARIA2C_PATH`, `BILIKARA_TOOL_ASSET_BASE_URL` | Existing tool path / asset source overrides remain supported. |
| `YT_DLP_PATH` | Retained legacy adapter interface only; it does not enable native yt-dlp. |

CSV preserves the raw display title and the historical `播放时间` header. Image
exports keep `bilikara 歌单导出`. Filenames use
`bilikara-{source}-{YYYYmmdd-HHMMSS}` and the actual format extension. One image
page is PNG; multiple pages are rendered sequentially and packaged as ZIP. HTTP
MIME, filename and desktop save-dialog filters all follow that result. The
10,000-row / 16 MiB input and 64 MiB native output cutoffs are removed. A single
export slot still bounds simultaneous rendering/transfers; the desktop download
transport retains its separate 512 MiB response guard. Extremely large exports
remain subject to available memory/disk and are not streamed row-by-row.

In v0.7.2, `bilikara/bilibili.py::resolve_video_reference` recognized `b23.tv` and
`bili2233.cn`, opened them through urllib and used the final response URL. It did
not offer arbitrary third-party short-link input. Native keeps these supported
entry domains and validates redirect targets; share text without a space before
the URL preserves the selected `p` value. The historical urllib implementation
had broader downstream redirect behavior, which is not restored.

Startup owner enrichment is limited to 32 attempts, retries failed records no
sooner than 24 hours later, and persists only hashed URL attempt timestamps.
Untried records precede old failures. Host-header validation uses a read-only
projection of actual interface addresses (refreshed every five seconds), and SSE
clients share serialized state frames per revision and role. Checkpoint writes
still serialize and durably publish under AppState's commit lock; the redundant
whole-state JSON tree has been removed, but history cloning/chunk rewriting is
not an append-only persistence engine.
