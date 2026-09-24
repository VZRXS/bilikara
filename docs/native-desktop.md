# Native desktop launch and bundles

The desktop shell starts one `bilikara-desktop-host` process by default. The
backend owns the Rust AppState and native HTTP/SSE/media services. No Python,
Cargo, source checkout or preview environment variable is needed by an installed
product. Python remains a build/test tool and the legacy source Host remains
available for compatibility tests; it is not included in the native bundle.

## Build and development

Use the repository's Node.js 24 and Rust toolchains. From the repository root:

```sh
npm ci
npm run dev
```

Tauri's development hook runs `python build_bundle.py --dev`, builds the native
backend with `native-host`, and stages it and its resources in `_internal/` beside the debug shell.
For direct `cargo run --manifest-path src-tauri/Cargo.toml --locked`, run
`npm run prepare:desktop` first. There is no runtime search through the checkout
or fallback to Python. A development layout may report external tools/libav as
unavailable until explicitly configured.

For a product build, prepare the existing pinned BBDown vendor and a matching
libav-only prefix using `scripts/prepare_bbdown_vendor.py` and the documented
`media-libav` build scripts. Set `BILIKARA_LIBAV_PREFIX` to its absolute path and
put the prepared BBDown on the **build** PATH, then run:

```sh
npm run build
```

`build_bundle.py` is a staging tool, not a freezer. It builds a release Rust
backend, copies static assets/fonts/Signalsmith and version metadata, stages
the libav companion/dependencies and licenses, and builds the Tauri shell.
macOS keeps nested-code signing and seals the outer app after embedding the
backend. `python build_bundle.py` alone prepares the backend/resource layout
used by the existing CI assembly steps. `--target TRIPLE` supports an explicit
matching runner target; foreign tool/libav architectures fail closed.
`CARGO_TARGET_DIR` and the selected debug/release profile are respected.

The Windows archive keeps the `bilikara/` directory. Its only top-level executable
is `bilikara-desktop.exe`; `_internal/` contains `bilikara-desktop-host.exe`, `static/`,
`vendor/`, `APP_VERSION` and `native-desktop.json`. Licenses, notices, rebuild
sources and guides are together in `license/`. macOS installs `Bilikara-Desktop.app`;
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

Bundles contain no Python interpreter, PyInstaller payload, temporary Python
FFI libraries, FFmpeg or ffprobe executables. BBDown stays pinned and vendored.
aria2c uses the existing Rust preparation and managed-tool policy; macOS carries
the pinned download manifest rather than making aria2c a required bundled file.
Libav is discovered from the installed resources and configured through typed
Rust services before workers start. Broken packages fail explicitly.

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
The helper waits for the owned backend and shell to exit, stages a sibling
installation, preserves the previous application as `.previous-update-*`, and
launches the new Tauri entry. A copy/replacement failure retains or restores the
old installation; this is not a general crash-rollback guarantee. After checking
the new installation, the user may remove that previous application directory.
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
without importing it again. Real package
installation and platform acceptance remain necessary before a Preview 2 release;
this launch/update contract does not establish full product parity.

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
Remote commands use the same bounded pending/completed ledger. A result reports
success only after Catalog accepts it; failures release the reservation for an
explicit retry. This is session-local duplicate protection, not durable
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
