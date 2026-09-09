# M6 default routing and Windows x64 package

S1–S3, M1–M3 and M5 are accepted; this patch closes the implemented capability
scope through M6 application/package integration. The inherited M6 work was
uncommitted on `work/v0.8.0` after M5; the maintainer confirmed that status and
authorized one combined M6 commit. Independent code review comes next.
**Windows build/extracted-package execution awaits Actions after push; manual
Windows playback is deferred separately.** Neither is claimed as proven on
Ubuntu. No push or workflow dispatch is part of this implementation handoff.

## Default routing and rollback

The actual Python backend supplies immutable trusted path/mode facts once to
Runtime at startup. Windows x64 discovers `_internal/vendor/ffmpeg-runtime.json`
(or its PyInstaller resource-root equivalent) and the companion beside it.
AppState initialization does not load libav. Ordinary supported calls use libav
first; `windows_libav_preview=true` only selects the artifact to BUILD.

The exact rollback is **`BILIKARA_MEDIA_BACKEND=legacy` before startup**. Unset or
`default` uses libav where provisioned. Legacy never loads libav. There is no UI
selector or mutable configuration service. On Linux the existing
`BILIKARA_LIBAV_COMPANION` and `BILIKARA_LIBAV_FFMPEG_PREFIX` designate the trusted
local acceptance build, not deployable paths. No ARM64/macOS package/loader is
enabled. Unprovisioned builds retain their existing routes; broken provisioned
packages never search system PATH for repair.

| Capability | Normal caller | Required result / libav profile | Eligible compatibility |
| --- | --- | --- | --- |
| Metadata | `CacheManager._probe_original_audio_duration` → Runtime inspect | M1 stream metadata, single expected kind; unknown duration fails the duration consumer. No validation certification. | Retained Pure Rust MP4/M4A probe; same-build ffprobe for other metadata contracts. |
| Packet traversal | `_validate_media_file`, `_validate_demux_file`, pre-DownKyi source check → Runtime inspect | M3 exact expected track and clean complete EOF; S3 moov/mdat and AAC config checks. Source/output checks remain separate; no full-decode claim. | One retained Pure Rust strict probe or same-build FFmpeg selected-track copy/null path for the requested operation. Rust checks CLI metadata/completion facts. |
| MP4 copy/fast-start | Rust `cache_runtime::run_track`; existing Python Native adapter through the same FFI normalizer | `mp4_single_h264_or_aac_faststart_v1`; M5 exact config, traversal, payload/timing bounds, leading moov and finalized no-replace candidate. | Existing Pure Rust normalizer once on an eligible capability failure. |
| FLAC output | Same Native track normalizer after FLAC acquisition | `mp4_single_flac_to_native_flac_v1`; STREAMINFO/config, continuous sample sequence, native FLAC reopen/scan/header. | Existing Pure Rust extraction once on an eligible capability failure. |

Successful libav operations are consumed without CLI repetition. S3 retry and
backend eligibility remain separate. Media/request/contract, I/O, cancellation,
collision, backend and unknown failures never switch backend; compatibility
failure never loops back. M5 timing/changing-configuration layout rejections stay
errors because the retained writer cannot certify that same profile. M5 owns
scratch/finalization/no-replace candidates; AppState alone owns final publication
using the original incarnation, artifact, attempt and generation identities.
Native I/O uses the existing attempt cancellation atomic without worker/AppState
locks. An in-process native crash is not a fallback path.

Retained paths include DownKyi timestamp remux, BBDown's own explicit FFmpeg
workflow, non-profile codecs/containers, and Pure Rust cached-audio refresh checks.
No multi-track muxing, transcoding, decoding or extra formats were ported.
**CLI remains packaged; original M7 removal is a later-version decision.** This
does not establish a historical Hi-Res fix or other-platform acceptance.

## Authorized execution later

Existing workflow: `.github/workflows/ci-bundle.yml` (`CI And Bundles`).
Ref: **`work/v0.8.0`**, input **`windows_libav_preview=true`**.
Jobs: `Test (windows-latest)`, then **`Bundle (Windows x64 libav preview)`**.
Record the run's actual checkout commit when executing; preparation has no run ID.

The downloadable Actions artifact is
`bilikara-windows-x64-libav-preview-<run_id>`, containing
`bilikara-work-v0.8.0-windows-x64-libav-preview.zip`, build diagnostics and
`libav-smoke-result.json`. Failure diagnostics are uploaded with `always()`;
an archive/result may be absent if its build stage was not reached.

Input absent/false preserves the three-OS test job, all four existing bundle
targets (Windows x64/ARM64, macOS ARM64/Intel), Chocolatey on normal Windows,
the macOS pinned assets and existing tag/release behavior. Preview selects
Windows x64 only and explicitly excludes release upload/R2 mirroring even when
manually invoked at a tag. It does not call `tool-assets.yml`, publish stable
tool assets, dispatch another workflow or add permissions. The existing
`internet-remote-sync.yml` push path filter does not match this increment;
earlier unpublished commits must be checked separately before any approved push.

## One Windows build and package

`build-windows.sh` runs **only on Windows Actions**. MSYS2 supplies shell/make,
while the runner's x64 Visual C++ toolchain builds FFmpeg and the companion.
Rust keeps its existing `x86_64-pc-windows-msvc` target. No MinGW runtime,
MSYS2 shell, developer prefix or system FFmpeg is needed by the extracted package.
The documented [FFmpeg MSVC recipe](https://ffmpeg.org/platform.html#Microsoft-Visual-C_002b_002b-or-Intel-C_002b_002b-Compiler-for-Windows)
is used with the accepted 9.0.1 source, not Linux binaries.

The official archive and detached signature are downloaded and verified using
the accepted release signer `FCF986EA15E6E293A5644F10B4322F04D67658D8` in an
isolated keyring. GPG must succeed and report that fingerprint before extraction.
Existing upstream checksum checks for other tool assets/compliance are untouched.
No file/diff hash ledger is introduced.

Target differences from the accepted Linux configure are the prefix,
`--toolchain=msvc --arch=x86_64 --target-os=win64`, and explicit `/MD` for C/C++.
All accepted capability flags remain, including shared libraries, disabled
autodetection/network/avdevice/swscale/x86asm and enabled swresample. No codec or
demuxer whitelist trimming, `--enable-gpl` or `--enable-nonfree` is added.
The current Bilikara FFmpeg corpus uses local-file probe, copy/null validation
and copy/fast-start normalization; these exact shapes are in the smoke. This
does not certify arbitrary network FFmpeg use or a live BBDown download.

CLI and DLLs come from **one configure/build/install**. The companion compiles
against those installed headers and import libraries. `/MD` shares the UCRT
descriptor table with FFmpeg's `fd` protocol; additive companion exports duplicate
a Rust-owned Windows HANDLE into that CRT and close only the owned descriptor.
The existing v1 probe/scan/transform schemas, C allocation ownership, cancellation
and no-replace publication remain unchanged. UTF-8 staging paths are converted
to UTF-16 for Windows file inspection; FFmpeg handles its own UTF-8 file opens.

`prepare-windows.ps1` builds the existing developer example and the Runtime test
binary. `scripts/windows_libav_preview.py` walks real PE normal/delay imports,
requires x64, checks actual shared-UCRT imports and collects only reached FFmpeg
and selected VC redistributable DLLs. Windows system/API-set imports stay OS-owned.
The package retains source/signature/key, LGPL text, installed MSVC terms/list,
configuration/header/build records and actual compiler/SDK/Rust versions.
These are provenance and redistribution materials, not legal certification.
See Microsoft's [dependency guidance](https://learn.microsoft.com/en-us/cpp/windows/determining-which-dlls-to-redistribute).

```text
bilikara/
  bilikara.exe                 existing PyInstaller backend
  bilikara-desktop.exe         existing Tauri shell
  _internal/rust/              mandatory existing Rust DLLs
  _internal/vendor/            same-build ffmpeg.exe, ffprobe.exe, companion,
                              private test companion, required DLL closure,
                              ffmpeg-runtime.json, existing BBDown
  preview/                    libav_metadata.exe, libav-runtime-tests.exe,
                              required VC runtime, build/configuration records
  THIRD_PARTY_SOURCES/         exact FFmpeg source/signature and companion source
  THIRD_PARTY_LICENSES/        existing notices plus selected build materials
  libav-smoke.ps1              explicit developer smoke entry
  WINDOWS_PREVIEW.md
```

Only preview CLI files are passed as PyInstaller data; explicit dependency staging
then prevents PyInstaller from resolving an unrelated runner FFmpeg. The normal
Runtime DLL never imports the optional companion/libav. Application routing loads
the companion from the trusted vendor directory only when an operation needs it.
Compatibility subprocesses use that same package; the existing restore still
copies the complete CLI dependency closure for explicit source workflows.

Windows loader: trusted absolute local drive path, UTF-16 `LoadLibraryExW` with
`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32`. No CWD/PATH
search or loader PATH/SetDllDirectory mutation. Per-load module snapshots reject
already-loaded or newly resolved foreign FFmpeg/companion modules; foreign modules
are not unloaded. ABI/layout/capability/version/configuration checks and result
lifetimes are retained. Microsoft documents the
[flags](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw)
and [loaded-module precedence](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order).

The existing vendor-to-`BILIKARA_HOME/tools/bbdown` restore copies the manifest's
complete CLI dependency closure for preview packages and refreshes it together.
The Actions run/attempt in that manifest is only a restore-generation marker,
not same-build proof; an already restored group is left usable by running CLIs.
Missing dependencies reject preparation before falling back or copying a partial
group. The preview ffprobe lookup also excludes system fallback. Removing only
the companion leaves CLI restoration usable; removing a shared FFmpeg DLL makes
its CLI fail, while mandatory AppState/backend startup must still work.

## Finite artifact smoke and process boundary

Actions archives then extracts outside the checkout/build prefix into a directory
with spaces and `空`. `libav-smoke.ps1` launches the **packaged PyInstaller backend**
only as the explicit smoke orchestrator; no separately installed Python is needed.
Its child environment retains Windows system PATH entries, removes developer/tool
overrides and credentials, and uses a disposable home with synthetic fixtures.
It records the actual PyInstaller DLL directory without changing that setting.

The small `--tool-smoke media-routing` adapter invokes **normal CacheManager and
media FFI calls inside packaged `bilikara.exe`**, using ordinary startup discovery,
first without a routing override and then with `legacy`. Actual backend diagnostics
and observed CLI calls must prove six successful cases and zero CLI repetition
of successful libav work. The adapter does not activate a backend or use the
developer driver to perform application calls. The Runtime test binary also
executes real Native `run_track` with Bilibili acquisition replaced by a local HTTP
fixture, retaining media I/O, attempt paths and stale-publication checks. Legacy
additionally asserts zero optional-library load attempts.

The existing **`libav_metadata.exe` developer comparisons** remain separate
content/configuration oracles. They compare metadata/scan/MP4/FLAC with the restored
same-build ffmpeg/ffprobe, including bounded encoded-content and FLAC PCM/Claxon
checks. The 830-byte synthetic H.264 fixture is media input, not a Linux executable;
it was generated with `ffmpeg -v error -f lavfi -i color=c=black:s=64x48:r=12 -t 0.5
-c:v libx264 -pix_fmt yuv420p -an -f h264 media-libav/fixtures/synthetic.h264`.
The packaged CLI creates the AAC/FLAC fixtures from a short synthetic PCM WAV.

The smoke also checks actual loaded vendor/restored CLI module paths and extracted
x64 PE headers; default backend ready/health/shutdown without a media activation flag;
fresh disposable copies without companion, without shared dependency, and with a
wrong companion, including actual application compatibility/failure outcomes;
both transforms' existing real-write cancellation checkpoint and
before-publish collision sentinel; and existing BBDown offline restore/help.
Required tests execute explicitly: missing artifacts/skips are failures.
Sanitized JSON retains named stages/comparison outcomes on failure, with no raw
stderr, credentials, real-account data, private media paths or payload archives.

## Manual checklist (separate from Actions)

1. Download and extract the complete preview ZIP into a writable folder.
2. Launch `bilikara-desktop.exe`; also check the backend via `bilikara.exe`.
3. Check ordinary LAN Remote connection and playback on real devices.
4. From PowerShell run `& 'C:\your folder\bilikara\libav-smoke.ps1'` and retain
   its sanitized `libav-smoke-result.json`. This needs neither login nor Hi-Res media.
5. Also test `BILIKARA_MEDIA_BACKEND=legacy` in a fresh process, then remove that
   environment override. Check normal close/restart in the disposable home.
6. Record run/job/artifact results separately from device/model/playback results.

Ubuntu preparation cannot prove Windows compilation, loader behavior or package
startup. No local Windows compiler, Wine, VM or remote desktop is required or
installed. A runner pass is Windows x64 preview evidence only: no ARM64/macOS,
WebView playback, Hi-Res root cause, full native crash isolation or other-platform acceptance.
