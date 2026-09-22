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
backend with `native-host`, and stages its resources beside the debug shell.
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

The Windows archive keeps the `bilikara/` directory, with
`bilikara-desktop.exe`, `bilikara-desktop-host.exe`, `static/`, `vendor/`,
`APP_VERSION` and `native-desktop.json`. macOS installs `Bilikara-Desktop.app`;
its `Contents/Frameworks/bilikara-backend.app` contains the backend under
`Contents/MacOS/`, static/version resources under `Contents/Resources/`, and
native libraries/tools under `Contents/Frameworks/vendor/` with relative resource
links. The Linux local development layout follows the Windows directory shape,
without `.exe`; this does not establish a new supported release target.

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
| Windows | `%LOCALAPPDATA%\bilikara\native` |
| macOS | `~/Library/Application Support/bilikara/native` |
| Linux | `$XDG_DATA_HOME/bilikara/native`, or `~/.local/share/bilikara/native` |

Use an absolute `BILIKARA_NATIVE_DATA_DIR` for isolated development.
The earlier `BILIKARA_DESKTOP_RUST_PREVIEW_DIR` remains a data override alias;
it no longer switches backends. Trusted `BILIKARA_HOME` is also accepted as a
native root override. The direct backend's `--data-dir` takes precedence.
The existing native marker/checkpoint format remains valid.

Existing native records take precedence. An unmarked nonempty or malformed
native directory is refused, never treated as an empty library. Known legacy
data without native records produces an explicit import instruction. The
installer does not silently merge, overwrite or delete legacy files.

Choose a **new, nonexisting** destination with an existing parent. It cannot
overlap the legacy source. From the installed backend's directory:

```sh
./bilikara-desktop-host --data-dir /absolute/new-native-root \
  --import-from /absolute/legacy-app-home
```

On Windows use `bilikara-desktop-host.exe`; on macOS use the executable inside
the embedded backend app. Packaged assets resolve automatically, independent of
the working directory. For shell launch, set `BILIKARA_NATIVE_DATA_DIR` and
`BILIKARA_DESKTOP_RUST_IMPORT_FROM` to those paths. Import reads the old source
only, preserves supported records/settings and uses the existing continue/new
session choice. Media is re-cached through fresh native identities. Subsequent
launches reopen native records without reimporting, even if the old source has
changed or disappeared. No login, catalog upload or automatic refresh is caused
by import. More elaborate automatic upgrade selection remains separate work.

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
Native data remains in its separate application-data directory. An explicit
native data override inside the installation makes automatic update unavailable.
The audience window, Remote and ordinary HTTP cookies cannot initiate or commit
a desktop installation. Manual release links open a validated web URL through
the shell, without navigating the player away.

Preview 1's Windows Tauri archive extraction/relaunch names remain compatible
with the native archive; legacy data still requires the explicit import above.
Preview 1's macOS extractor does not preserve bundle symlinks, so that transition
requires manual replacement with the intact native app and explicit data import.
Native-to-native macOS updates preserve safe relative bundle links. Real package
installation and platform acceptance remain necessary before a Preview 2 release;
this launch/update contract does not establish full product parity.
