# Native desktop launch and bundles

The desktop shell starts one `bilikara-desktop-host` process by default. The
backend owns the Rust AppState and native HTTP/SSE/media services. No Python,
Cargo, source checkout or preview environment variable is needed by an installed
product. Python remains a build/test tool and the legacy source Host remains
available for compatibility tests; it is not included in the native bundle.

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
