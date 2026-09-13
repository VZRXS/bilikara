# Shared Rust catalog migration — local, review deferred

Status: **CATALOG_SHEETS_RUST_LOCAL_VALIDATED_REVIEW_DEFERRED**. Shared Rust
catalog and read-only Sheets fallback are implemented and locally validated;
all required commands have passing final results. Independent review is deferred. This task
started on the clean integration tree `3f3d5a12efd3b36501fe2d6cf67e70bb00a5f3ae`
(`work/v0.8.0`). P05, P03, UI and PR109 integration are preserved. No independent
review, commit, amend, stash, branch, push, signing or deployment was performed.
The verified public Sheets source is now wired as a read-only fallback. The user
clarified that this is only a read-only fallback; no synchronization or write
service is part of this migration. Unverified external exclusion coverage is
documented below rather than treated as an additional source-approval request.

## Verified source and coverage limits

Source verification follow-up after the user supplied the spreadsheet:

- Verified public catalog: `https://docs.google.com/spreadsheets/d/18IFzVZh7HhxgcKJP-1qzodFzBsJ4AXoF4ZA6lWSSvOk/edit?gid=0`.
- Selected read interface: the same spreadsheet's `/gviz/tq` endpoint with
  `gid=0`, `tqx=out:csv`. A single unauthenticated GET using
  `tq=select * limit 3` returned HTTP 200 and `text/csv; charset=utf-8`.
  Only the header and three rows were read (under the 16 KiB inspection bound).
  Redirects were disabled. No credentials, private publishing, authentication
  page scraping, full-snapshot download, or write endpoint was used.
- Checked columns: `bvid`, `mid`, `title`, `url`, `owner_name`, `owner_url`,
  `tag_1` through `tag_5`, `tag_status`, `cover_url`, `rank`, `played_count`,
  and `preserved_1` through `preserved_5`. Rows contain catalog BVIDs, video
  titles/URLs, owner metadata and tags; this is not merely the rating backup.
  The tab is identified by gid; its display name and synchronization policy
  were not inferred. Existing rank/preserved column meanings were not invented.
- The public source has no explicit deletion/blacklist column. `tag_status` is
  not a deletion flag. Upstream snapshot publication cadence and exclusion
  synchronization are unverified. This is a documented coverage limitation,
  not a claim that a newly fetched sheet exactly mirrors D1.
- Rust consumes GViz CSV directly with GET only, no credentials, redirects or
  returned script evaluation. A snapshot refresh is bounded to 32 MiB, 100,000
  rows and a 20-second maximum HTTP timeout. Required headers, duplicate headers,
  UTF-8, quote boundaries, row widths and field sizes are checked. Missing
  optional tags/rank/scores remain absent. This source is not an Apps Script
  service, a private spreadsheet, or the separate rating backup.

The local-only discovery record below predates the supplied URL; its missing
source conclusions are historical and have been superseded by that verification.

Fresh searches covered the local code/config/docs, cached PR109 source at
`/tmp/bilikara-pr109-concurrency/pr-source`, and the existing companion locations
`/sunhonglin/Kirakara-Show`, `/sunhonglin/kara_ws`, and `/sunhonglin/StrangeUtaGame`.
The earlier all-local-Git-history search recorded in
[the integration report](pr109-integration-concurrency.md#sheets-来源与尚留-python)
is historical evidence, not a newly executed history scan.

- Public catalog snapshot: no URL, sheet/tab ID or catalog schema found.
- Rating backup: README's Google Sheets reference concerns D1 rating backup;
  it provides no catalog endpoint or schema and is not a search source.
- Private spreadsheet: no verified catalog source found; none was published or
  opened. No authentication pages were requested or scraped.
- Apps Script/GViz/CSV/API: no applicable endpoint found. No replacement URL,
  service-account secret, tab mapping or production schema was invented.
- PR109 `native_host/catalog.rs` contained a D1-only read implementation. This
  implementation was extracted and reused, along with existing Cloudflare HTTP
  and append services; there is no second Android/desktop catalog backend.

The supplied gid and schema are verified, and the GViz CSV parser/cache/fallback
are implemented and exercised against local HTTP fixtures. No full production
snapshot or live write endpoint was needed for validation.

## Implemented boundaries

`rust-runtime/src/shared_catalog/` is the one service, exposed through the
existing additive schema-v1 runtime-service FFI command `shared_catalog` and a
Rust `execute_catalog` API. No C ABI symbol was removed or changed.

Rust now owns the former module's D1 search, name/artist browse, category tags,
pagination, BVID/URL/result normalization and deduplication, source/error
mapping, read-only Sheets snapshot parsing/search/cache, export parsing, pending-review classification, approval update sequence,
blacklist/admin request validation and interpretation, rating submission, and
module-level maintenance dispatch. The existing privileged approval compatibility
sequence (append, re-export, authorized delete/reappend only when still pending)
is preserved and tested solely against loopback fixtures. Upstream protocol keys
including `feishu_queued` and approval `fallback_*` counters remain unchanged.

Python `lark_pool_client.py` (1,414 active lines at the starting HEAD) is removed.
`shared_catalog.py` retains 185 lines of public entry signatures, configured
endpoint/timeout/keyword transport, FFI result checks, error adaptation and the
existing best-effort background enqueue adapter. It contains no catalog parsing,
review classification, provider policy or semantic fallback. Python's separate
Internet public-field projection and local-status annotation remain adapters.

Shared consumers now wired:

- Python Host HTTP search/browse routes pass raw queries to Rust; Python no longer
  separately clamps catalog query parameters or converts upstream errors to empties.
- Python Internet Remote effects use the same FFI service and cache; public
  projection and existing permissions stay intact.
- Native Host HTTP and native Internet effects use the same Rust service.
- Native rating admission/identity bookkeeping remains in its existing AppState
  ledger; submission now uses the shared catalog request/response policy.
- Append consumers reuse the existing bounded Cloudflare queue and normalizer.
  Append execution invalidates the shared query cache on start and completion.

In-repo HTTP callers use `/api/catalog/search`. `/api/lark/search` is only a thin
alias for deployed clients. Any `table` selector, including an empty value,
returns `410 catalog_table_retired`; it is never interpreted as a Sheets tab.
Unused table-search JS functions and five-table constants are removed. Existing
UI layouts, busy guards, DOM/i18n identifiers and the unrelated historical Gatcha
public parameter remain compatible; none provides Feishu access.

## Read/error/cache contract

A valid D1 empty array is successful and cacheable; it never triggers fallback.
Malformed response shapes remain errors. BVIDs use checked ASCII identity or a
recognized Bilibili video URL, and public result URLs are canonical Bilibili
URLs. Invalid/duplicate records are filtered. Optional tags and scores stay
absent when absent; Unicode titles are preserved.

Only public-read transport/timeout/invalid-JSON/response-size failures and
explicit HTTP/service statuses 408, 429, 500, 502, 503 and 504 are marked eligible
for Sheets search fallback. Browse/category pagination stays on D1. Unknown semantic rejections, other 4xx, redirects,
validation/FFI/state failures and concurrency admission failures are ineligible.
401/403/400/422 retain distinct status/code mapping, including Internet adapters.
All administration, rating, review, maintenance and append failures are excluded
from fallback. No read result is automatically written back to D1.

The PR109 60-second, 48-entry, 512-KiB-per-result cache and two-inflight limit
now live under the existing shared AppState, available without `native-host`.
Cache identity includes configured D1 base URL and canonical query; the old and
new HTTP paths share entries. Identical in-flight reads return a bounded busy
error; there is no second queue. Eligible outages back off for 30 seconds;
authorization/validation failures do not poison subsequent public reads.
Network, JSON interpretation and result-size computation occur outside AppState.

Expired entries are discarded and never served on failure. Mutation invalidation
advances a generation: an earlier in-flight read cannot publish or return its
pre-mutation result after that change. External D1 edits may still be visible
through an existing fresh query cache for at most 60 seconds; no external
invalidation protocol has been asserted. Sheets snapshot/filter coverage remains
unverified. The read-only fallback exposes source and coverage metadata; it does
not imply that remote removals have reached the published snapshot.

Cloudflare HTTP reuses its current transport with bounded responses (32 MiB
success, 4 KiB error preview) and no redirects, including privileged POSTs.
No returned script is evaluated. Request timeouts remain bounded by the existing
HTTP service. These limits apply to D1; the Sheets bounds are described above.

## Sheets snapshot and exclusion policy

The default D1 installation uses the verified gid=0 GViz CSV endpoint. Custom
`BILIKARA_CF_API_URL` installations do not automatically inherit this separate
catalog. Host-owned `BILIKARA_CATALOG_SHEETS_URL` (or the additive FFI
`sheets_url` field) can select the exact verified URL, a loopback fixture URL,
or an empty string to disable fallback. HTTP/Internet clients cannot select
arbitrary sources or tabs. This is not a generic provider interface.

A single normalized snapshot lives in shared AppState via an `Arc`; it is shared
across keywords, Python FFI, native Host and Internet consumers. At most one
snapshot refresh runs at a time; competing requests return `catalog_busy` and
can retry. Snapshot TTL is 60 seconds after fetch/parse completion. Expired rows
are discarded before refresh, never served on error. Failed refreshes use a
30-second backoff. Neither keyword searches nor cached reads redownload the
whole sheet. Network, CSV parsing, normalization and keyword scanning occur
outside the AppState mutex. Generation checks reject results invalidated by a
concurrent mutation. D1 is retried after its existing outage backoff; fallback
results never enter the D1 query cache or get appended to D1.

Search matches all whitespace-separated, case-insensitive tokens against title,
BVID, owner MID/name and tags, preserving snapshot order and normalized limits.
Each item has `source: sheets`; raw read responses also declare snapshot max age
and `exclusion_coverage: process_local_only; upstream_snapshot_sync_unverified`.
Existing Internet public projection adds its normal item ID/local-status fields.
The frontend retains its normal flow and does not mislabel Sheets owners as
followed users. Upstream `feishu_queued` response fields stay unchanged.

Confirmed delete-video/delete-invalid/review-reject and delete-MID operations
record conservative process-local BVID/MID exclusions; ambiguous service/transport
write outcomes do too. Explicit authorization/validation rejections do not.
These exclusions survive refresh/invalidation, are checked before returning
Sheets rows, and are intentionally not undone by a restore operation (D1 remains
available for restored entries). The bound is 10,000 exclusions; overflow fails
closed for Sheets. This is transient catalog cache policy under AppState, not a
second persistent blacklist authority. Process restart clears exclusions.
**Records removed elsewhere, or before restart, may still appear in a newly
fetched sheet if its upstream snapshot has not removed them.** No external
blacklist coverage, synchronization SLA or persistent tombstone feed is claimed.
No stale-on-error data is served and no fallback results are written back.

## Validation and limits

Command results and the complete 47-file task inventory are recorded below.
All new mutation tests use local non-production HTTP fixtures. The complete test
gate additionally sets every HTTP proxy variable to a refusing loopback address
and exempts only localhost/127.0.0.1/::1, preventing live HTTP write endpoints.
Native diagnostic HTTP validation uses the existing rejecting proxy harness,
which records zero externally forwarded requests. No production provider writes
were used to verify the migration.

Implementation-specific Feishu token/probe/table tests are removed with those
retired consumers. Useful D1 behavior is covered by real Python→FFI→Rust→loopback
HTTP contracts, rather than mocks of deleted Python parsing helpers. Existing
background append copying, queue acceptance/rejection, duplicate-path avoidance
and redacted error assertions remain. PR109 normalization/pagination assertions
were moved into the shared service; cache/backoff tests now cover all consumers.

Platform limits: this is Linux x86_64 compilation, tests and local transport
validation. Native Host fixture results are not Android device, cross-network,
Wi-Fi/cellular/NAT, Windows or macOS acceptance. The Linux npm build may produce
local deb/rpm/AppImage artifacts as part of the repository gate; none is deployed.
Sheets-specific transport, parser, concurrency, expiry and fallback checks use
local fixtures. Production snapshot size/refresh cadence and external exclusion
synchronization are not asserted by those fixtures.

## Global progress and retained scope

P05 DASH/DownKyi, P03 Rust export, UI integration, C01 Rust append and the existing
Rust AppState/FIFO/AV-delay authority remain preserved and independently reviewable
in the eventual batch. The catalog task is a separate uncommitted scope; it is
not a new architectural phase. The Sheets read fallback shares that same service.

Remaining Python responsibilities include HTTP/SSE/cookies/public projection,
startup/environment/path handling, Rust-snapshot persistence, other Bilibili
metadata and Gatcha/maintenance WBI adapters, the separate monthly maintenance
runner, local rating/remote identity ledger, updater adapters and retained
BBDown/yt-dlp/aria2c/FFmpeg orchestration. No new Python mutable authority exists.
The monthly runner changed only its import to the neutral wrapper module.

Remaining PR-only desktop replacement candidates include native login,
`native_session`/`native_host` transport and preferences, updates,
`native_persistence` and `native_video` callers outside the migrated P05/catalog
slices. Their presence/native-feature compilation is not desktop production
migration. Android's separate export renderer and signing-related integration
candidates remain outside this task; D0 is still unimplemented. No unknown P-ID
mapping is invented. Independent reviews for this task and P03/P05/UI stay batched.

## Executed validation commands

All paths below are relative to `/sunhonglin/bilikara`. The authoritative stage
log index is `/tmp/bilikara-catalog-sheets-validation/results.json`, supplemented
by `retry-results.json` for the exact npm retry; each stage
has a same-named `.log`. `python /tmp/bilikara-catalog-sheets-validation/run.py`
runs these exact commands sequentially and records each exit code independently.
Test environment: `BILIKARA_REQUIRE_RUST_LIB=1`,
`BILIKARA_HOME=/tmp/bilikara-catalog-sheets-validation/fixture-home`,
`TZ=Asia/Tokyo`. For the Python/default Rust/native unit/catalog-fixture test
stages, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lowercase forms are
`http://127.0.0.1:1`; `NO_PROXY` and `no_proxy` are `localhost,127.0.0.1,::1`.
The native HTTP harness supplies its own refusing loopback proxy.

| Directory | Exact command | Result | Log |
| --- | --- | --- | --- |
| `rust` | `cargo fmt --check` | PASS (exit 0) | `rust-fmt.log` |
| `rust` | `cargo clippy --all-targets --locked -- -D warnings` | PASS (exit 0) | `rust-clippy.log` |
| `rust` | `cargo test --locked` | PASS (exit 0) | `rust-test.log` |
| `rust` | `cargo build --release --locked` | PASS (exit 0) | `rust-build.log` |
| `rust-runtime` | `cargo fmt --check` | PASS (exit 0) | `rust-runtime-fmt.log` |
| `rust-runtime` | `cargo clippy --all-targets --locked -- -D warnings` | PASS (exit 0) | `rust-runtime-clippy.log` |
| `rust-runtime` | `cargo test --locked` | PASS (exit 0) | `rust-runtime-test.log` |
| `rust-runtime` | `cargo build --release --locked` | PASS (exit 0) | `rust-runtime-build.log` |
| `src-tauri` | `cargo fmt --check` | PASS (exit 0) | `src-tauri-fmt.log` |
| `src-tauri` | `cargo clippy --all-targets --locked -- -D warnings` | PASS (exit 0) | `src-tauri-clippy.log` |
| `src-tauri` | `cargo test --locked` | PASS (exit 0) | `src-tauri-test.log` |
| `src-tauri` | `cargo build --release --locked` | PASS (exit 0) | `src-tauri-build.log` |
| `.` | `python -m unittest discover -s tests -v` | PASS (exit 0) | `python-tests.log` |
| `.` | `python -m compileall -q bilikara` | PASS (exit 0) | `python-compileall.log` |
| `.` | `python -m py_compile start_bilikara.py build_bundle.py` | PASS (exit 0) | `python-entrypoints.log` |
| `.` | `npm ci` | PASS (exit 0) | `npm-ci.log` |
| `.` | `npm run build` | Initial FAIL (exit 1), exact retry PASS (exit 0) | `npm-build.log`, `npm-build-retry.log` |
| `rust-runtime` | `cargo clippy --all-targets --features native-host --locked -- -D warnings` | PASS (exit 0) | `runtime-native-clippy.log` |
| `rust-runtime` | `cargo test --features native-host --lib --locked` | PASS (exit 0) | `runtime-native-lib-test.log` |
| `rust-runtime` | `cargo build --features native-host --example native_host_alpha --locked` | PASS (exit 0) | `runtime-native-example.log` |
| `.` | `python -m tests.run_catalog_native` | PASS (exit 0) | `native-catalog-fixture.log` |
| `.` | `python tests/run_native_host_http.py` | PASS (exit 0) | `native-http-fixture.log` |
| `.` | `git diff --check` | PASS (exit 0) | `diff.log` |

Current code test totals: Rust core 218 passed; Runtime 212 passed and 15
existing ignores; native-feature Runtime 257 passed and 15 existing ignores;
Tauri 77 passed; Python 1,616 tests (1,601 passed, 15 existing skips); native
catalog fixtures 2 passed (D1 and Sheets through native HTTP/Internet); existing
native HTTP fixture 1 passed. Platform/fixture limitations are listed below.

Packaging follow-up: the first exact `npm run build` exited 1 at AppImage
`linuxdeploy`, after compilation and deb/rpm packaging. Disk space was sufficient.
`npm run tauri -- build --verbose --bundles appimage -- --locked` then passed
without code/configuration changes (`appimage-diagnostic.log`). The initial
failure's root cause is unconfirmed; an exact npm build retry is recorded in
`retry-results.json` and `npm-build-retry.log`, retaining the failed first log.
The exact retry passed (exit 0), generating local deb/rpm/AppImage bundles. It
emitted a Tauri `__TAURI_BUNDLE_TYPE` marker warning on the reused binary;
packaged updater behavior is not validated or claimed by this catalog task.
The existing `.app` bundle-identifier warning also remains. No package was
signed, published or deployed; these local build results are not release
acceptance for the retained packaging/updater work.

Sheets follow-up targeted commands (repository root):

- `cargo fmt --manifest-path rust-runtime/Cargo.toml`: PASS.
- `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --locked -- -D warnings`: PASS.
- `cargo test --manifest-path rust-runtime/Cargo.toml --locked shared_catalog --lib`: PASS, 11 tests.
- `cargo build --manifest-path rust-runtime/Cargo.toml --release --locked`: PASS.
- `BILIKARA_REQUIRE_RUST_LIB=1 BILIKARA_HOME=/tmp/bilikara-sheets-targeted HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1 ALL_PROXY=http://127.0.0.1:1 NO_PROXY=localhost,127.0.0.1,::1 python -m unittest tests.test_shared_catalog -v`: initial FAIL, 1 of 32 tests expected identical Internet/HTTP envelopes. Internet's existing public projection adds item IDs/local flags and omits URL; the fixture now asserts matching catalog fields plus retained projection and absent scores.
- Same environment with `python -m unittest tests.test_shared_catalog -q`: PASS, 32 tests after the fixture correction.

The following targeted command history is retained from the preceding D1/module
migration; its smaller counts predate the implemented Sheets tests.

Targeted checks run during development (before the settled full gate):

| Exact command (repository root unless a manifest is given) | Observed result |
| --- | --- |
| `cargo check --manifest-path rust-runtime/Cargo.toml --locked` | PASS |
| `cargo fmt --manifest-path rust-runtime/Cargo.toml` | PASS; formatter applied only to this Runtime change |
| `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --locked -- -D warnings` | Initially FAIL: items after test modules; fixed and full gate PASS |
| `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --features native-host --locked -- -D warnings` | Initially FAIL: collapsible `if`; fixed and full gate PASS |
| `cargo test --manifest-path rust-runtime/Cargo.toml --locked shared_catalog -- --test-threads=1` | Initially FAIL: redirect eligibility, then PASS, 7 tests after corrections |
| `cargo test --manifest-path rust-runtime/Cargo.toml --locked shared_catalog::tests::ffi_request -- --nocapture` | FAIL exposed serde flatten/unknown-operation rejection; corrected, now exercised by passing shared/full suites |
| `cargo build --manifest-path rust-runtime/Cargo.toml --release --locked` | PASS after each Runtime correction |
| `cargo build --manifest-path rust-runtime/Cargo.toml --features native-host --example native_host_alpha --locked` | PASS |
| `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_shared_catalog -v` | Initially failed on FFI wire parsing and fixture header casing; latest targeted run PASS, 27 tests |
| `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-catalog-targeted-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_shared_catalog tests.test_internet_remote tests.test_server tests.test_remote_search_expansion tests.test_rust_runtime -v` | 221 tests; initial FAIL on expected old log prefix; assertion migrated, full suite PASS |
| `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-catalog-recheck-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_shared_catalog tests.test_internet_remote_frontend -v` | Development FAIL on fixture response-key lookup; corrected, full suite PASS |
| `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-catalog-focused-final-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_shared_catalog tests.test_internet_remote_frontend -v` | Development FAIL with an older loaded FFI build; rebuilt, full suite PASS |
| `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-catalog-adapter-final-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_shared_catalog tests.test_internet_remote_frontend tests.test_internet_remote tests.test_server -v` | PASS, 238 tests |
| `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-catalog-contract-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_shared_catalog -v` | PASS, 27 tests, after final legacy-response corrections |
| `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-catalog-native-test-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m tests.run_catalog_native` | PASS, 1 real native Host/Internet HTTP fixture |
| `git diff --check` | PASS throughout; rerun after this report |

Earlier full-gate logs are retained at `/tmp/bilikara-catalog-validation/`:
its Python stage failed on a source-shape allowlist assertion after adding the
alias. The implementation now retains the explicit comparisons; the assertion
was not deleted or weakened. Intermediate all-green gates are retained at
`/tmp/bilikara-catalog-final-validation/` and
`/tmp/bilikara-catalog-adapter-validation/`. The settled gate above supersedes
those builds after the final response-contract preservation fix.

## Skips and unavailable checks

No mandated local gate command is omitted. The Python suite keeps its 15
existing conditional skips; exact test names and technical reasons follow.

- `test_sync_copies_current_remote_html_dependencies (test_internet_remote_deployment.InternetRemoteDeploymentTest.test_sync_copies_current_remote_html_dependencies)` — 'PowerShell is required to execute the actual asset sync'

- `test_backend_ready_handshake_and_graceful_shutdown (test_macos_backend_smoke.MacOSBackendSmokeTest.test_backend_ready_handshake_and_graceful_shutdown)` — 'Backend executable not found at /sunhonglin/bilikara/dist/bilikara.app/Contents/MacOS/bilikara; skipping smoke test.'

- `test_packaged_bbdown_restores_offline_vendor_to_clean_runtime (test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_bbdown_restores_offline_vendor_to_clean_runtime)` — 'Packaged BBDown smoke test requires macOS'

- `test_packaged_ffmpeg_and_runtime_copy_execute (test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_ffmpeg_and_runtime_copy_execute)` — 'Packaged FFmpeg smoke test requires macOS'

- `test_packaged_https_uses_macos_system_trust (test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_https_uses_macos_system_trust)` — 'Packaged HTTPS smoke test requires macOS'

- `test_packaged_macos_aria2_prepares_on_demand_with_minimal_path (test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_macos_aria2_prepares_on_demand_with_minimal_path)` — 'Full aria2c download is reserved for the package validation gate'

- `test_packaged_native_runtime_loads_from_bundle (test_macos_backend_smoke.MacOSBackendSmokeTest.test_packaged_native_runtime_loads_from_bundle)` — 'Packaged native smoke test requires macOS'

- `test_tauri_resolves_backend_and_completes_ready_handshake (test_macos_tauri_smoke.MacOSTauriSmokeTest.test_tauri_resolves_backend_and_completes_ready_handshake)` — 'Tauri application smoke test requires macOS'

- `test_real_known_metadata_profile_limitation_uses_one_cli (test_media_default_routing.LiveMediaRoutingTests.test_real_known_metadata_profile_limitation_uses_one_cli)` — 'live suite requires explicitly provisioned accepted companion and fixtures'

- `test_real_normal_callers_default_legacy_and_missing (test_media_default_routing.LiveMediaRoutingTests.test_real_normal_callers_default_legacy_and_missing)` — 'live suite requires explicitly provisioned accepted companion and fixtures'

- `test_real_source_rejection_precedes_legacy_timestamp_transform (test_media_default_routing.LiveMediaRoutingTests.test_real_source_rejection_precedes_legacy_timestamp_transform)` — 'live suite requires explicitly provisioned accepted companion and fixtures'

- `test_module_snapshot_identifies_the_loaded_windows_system_library (test_windows_libav_preview.WindowsPreviewTests.test_module_snapshot_identifies_the_loaded_windows_system_library)` — 'Windows module enumeration requires Win32'

- `test_module_snapshot_preserves_unicode_loaded_library_path (test_windows_libav_preview.WindowsPreviewTests.test_module_snapshot_preserves_unicode_loaded_library_path)` — 'Windows module enumeration requires Win32'

- `test_msvc_license_collection_selects_product_and_requires_records (test_windows_libav_preview.WindowsPreviewTests.test_msvc_license_collection_selects_product_and_requires_records)` — 'PowerShell is required for installed MSVC license collection'

- `test_smoke_wrapper_bounds_wait_and_rejects_failed_results (test_windows_libav_preview.WindowsPreviewTests.test_smoke_wrapper_bounds_wait_and_rejects_failed_results)` — 'PowerShell is required for the preview smoke wrapper'

The Rust Runtime suites keep their existing 15 explicit ignores. These require
separately provisioned companion/artifact/fixture or subprocess harnesses;
this catalog task did not provision or claim them. Exact reasons from the log:

- cache_runtime::tests::live_default_media_through_native_track ... ignored, requires same-build companion and synthetic fixtures; run in a fresh test process

- experimental_libav::comparison::tests::live_existing_missing_mdat_normalization_rejection ... ignored, requires real M1 artifacts and an absolute report path outside the repository

- experimental_libav::remux::package_tests::packaged_cancellation_and_collision ... ignored, requires extracted same-build package artifacts

- experimental_libav::remux::tests::live_flac_publication_cancellation_and_late_errors ... ignored, requires real FLAC companion and shared M5 fault companion

- experimental_libav::remux::tests::live_old_companion_does_not_remux ... ignored, requires accepted M3 companion without remux capability

- experimental_libav::remux::tests::live_publication_cancellation_and_late_errors ... ignored, requires real M5 companion, private fault companion and accepted fixtures

- experimental_libav::scan::tests::live_old_companion_keeps_metadata_without_scan ... ignored, requires accepted M1 companion without scan exports

- experimental_libav::scan::tests::live_scan_lifecycle_and_selection ... ignored, requires explicitly built real scan companion and fixtures; no live skips

- experimental_libav::tests::live_cancellation_and_repeated_cleanup ... ignored, requires explicit live artifacts; also used under ASan/LSan

- experimental_libav::tests::live_input_scope_and_errors ... ignored, requires explicit live artifacts

- experimental_libav::tests::live_loader_negotiation_in_subprocesses ... ignored, controlled fake loader boundaries run in child processes; needs C compiler

- experimental_libav::tests::live_metadata_is_separate_from_normalization_contracts ... ignored, requires explicit live artifacts

- experimental_libav::tests::live_metadata_matches_same_build_ffprobe ... ignored, requires explicit trusted companion, same-build ffprobe and generated fixtures

- media_backend::tests::export_extended_aac_fixture_for_m5 ... ignored, exports the accepted extended AAC fixture for explicit M5 integration

- media_routing::tests::live_application_routing_contracts ... ignored, requires accepted real companion and fixtures; missing inputs fail

`rustup target list --installed` reported `x86_64-unknown-linux-gnu`,
`aarch64-apple-darwin`, `aarch64-pc-windows-msvc`, and `x86_64-pc-windows-msvc`.
Installed targets alone do not prove OS execution or packaging. No Android
Rust target/device was available in that list. Windows/macOS/Android execution,
cross-network and device acceptance were not run on this Linux host. No signing
or deployment was attempted. Browser screenshot/visual acceptance was not rerun
for this API-only UI change; existing frontend/Node behavior tests ran in the
full suite. Sheets access and headers were verified separately with the minimal
three-row read; full snapshot production performance and external exclusion
synchronization remain unverified. Parser/fallback/expiry/concurrency tests now
exercise the implemented Sheets source with non-production fixtures.

## Complete file list and classification

`A` means added, `M` modified and `D` removed. This includes the full catalog-task
diff, including mechanical in-repo consumer/test changes. Unchanged P03/P05/UI
integration files outside these listed API/import changes are not included.

| Change | File | Classification |
| --- | --- | --- |
| M | `bilikara/bilibili.py` | Import/call-name adaptation only; retained workflow/policy unchanged |
| M | `bilikara/internet_remote.py` | HTTP/Internet adapters, shared Rust calls and error projection |
| D | `bilikara/lark_pool_client.py` | Removed active Python catalog policy and retired Feishu code/credentials |
| M | `bilikara/rust_runtime.py` | Additive Python native-service transport/result validation |
| M | `bilikara/server.py` | HTTP/Internet adapters, shared Rust calls and error projection |
| M | `docs/android-host-alpha.md` | Migration/protocol/progress documentation |
| M | `docs/host-shell-v0.8-design.txt` | Migration/protocol/progress documentation |
| M | `docs/internet-remote-v1-protocol.md` | Migration/protocol/progress documentation |
| M | `docs/mobile-host-rust-architecture.md` | Migration/protocol/progress documentation |
| M | `docs/pr109-integration-concurrency.md` | Migration/protocol/progress documentation |
| M | `docs/rust-native-utility-inventory.md` | Migration/protocol/progress documentation |
| M | `monthly_gatcha_d1_refresh.py` | Import/call-name adaptation only; retained workflow/policy unchanged |
| M | `rust-runtime/src/app_state.rs` | Move transient catalog cache under shared AppState authority |
| M | `rust-runtime/src/app_state/native_session.rs` | Move transient catalog cache under shared AppState authority |
| M | `rust-runtime/src/cloudflare_service.rs` | Existing Rust HTTP/append I/O, response bounds and cache invalidation |
| M | `rust-runtime/src/ffi.rs` | Additive Runtime module/FFI registration |
| M | `rust-runtime/src/lib.rs` | Additive Runtime module/FFI registration |
| M | `rust-runtime/src/native_host/api.rs` | Native Host/Internet/rating/append adapters to existing shared services |
| M | `rust-runtime/src/native_host/catalog.rs` | Native Host/Internet/rating/append adapters to existing shared services |
| M | `rust-runtime/src/native_host/catalog_append.rs` | Native Host/Internet/rating/append adapters to existing shared services |
| M | `rust-runtime/src/native_host/internet.rs` | Native Host/Internet/rating/append adapters to existing shared services |
| M | `rust-runtime/src/native_host/ratings.rs` | Native Host/Internet/rating/append adapters to existing shared services |
| M | `scripts/dev_smoke_test.py` | Existing smoke-script HTTP path update |
| M | `static/app.js` | UI transport names/routes; obsolete selector removal; no layout rewrite |
| M | `static/remote-transport-client.js` | UI transport names/routes; obsolete selector removal; no layout rewrite |
| M | `static/remote.js` | UI transport names/routes; obsolete selector removal; no layout rewrite |
| M | `tests/live_android_portrait.js` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/live_host_ui_browser.js` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/live_native_library.js` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/live_remote_request_workspace_browser.js` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/live_transport_concurrency.js` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/test_internet_remote_frontend.py` | Fixture/contract validation or mechanical consumer-path update |
| D | `tests/test_lark_pool_client.py` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/test_remote_search_expansion.py` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/test_rust_runtime.py` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/test_server.py` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/test_store_and_bilibili.py` | Fixture/contract validation or mechanical consumer-path update |
| M | `tests/test_transport_concurrency.py` | Fixture/contract validation or mechanical consumer-path update |
| A | `bilikara/shared_catalog.py` | Python configuration/FFI/result validation and enqueue wrappers only |
| A | `docs/catalog-rust-local-migration.md` | Migration/protocol/progress documentation |
| A | `rust-runtime/src/shared_catalog/mod.rs` | Rust authoritative catalog application service, typed operations, wire normalization/policy/tests |
| A | `rust-runtime/src/shared_catalog/operations.rs` | Rust authoritative catalog application service, typed operations, wire normalization/policy/tests |
| A | `rust-runtime/src/shared_catalog/sheets.rs` | Rust read-only CSV transport, parsing, search, bounded snapshot cache and exclusion policy |
| A | `rust-runtime/src/shared_catalog/read.rs` | Rust authoritative catalog application service, typed operations, wire normalization/policy/tests |
| A | `rust-runtime/src/shared_catalog/tests.rs` | Rust authoritative catalog application service, typed operations, wire normalization/policy/tests |
| A | `tests/run_catalog_native.py` | Fixture/contract validation or mechanical consumer-path update |
| A | `tests/test_shared_catalog.py` | Fixture/contract validation or mechanical consumer-path update |

Commit created: **No** (no SHA/message for this task). Starting/current HEAD:
`3f3d5a12efd3b36501fe2d6cf67e70bb00a5f3ae`,
`docs: record PR109 integration and validation status`.
Remote push: **No**. Amend/stash/branch/tag/signing/deployment: **No**.
Independent review: **deferred to the eventual batch**, with catalog kept as
its own task scope. No separate approval, signing or deployment work is implied.

---

> **独立评审页脚（2026-09-13，评审者追加，未修改上方原文）**
> 本文档的 `CATALOG_SHEETS_RUST_LOCAL_VALIDATED_REVIEW_DEFERRED` 到此关闭。
> 结论见 [批次独立评审记录](batch-review-2026-09-13.md)：本范围
> **CHANGES_REQUIRED**。共享服务边界、D1 优先/空结果不回退、回退资格分类、
> 排除与失效策略、锁外网络均已复核通过；一项必须修复：
> 快照刷新实际沿用调用方的 D1 读超时（搜索路径 2 秒），
> 与本文 “20-second maximum HTTP timeout” 的承诺不符，
> 已用 loopback 探针复现（3 秒 CSV 在 2.01 秒失败，10 秒预算下 3.01 秒成功）。
> 代码就绪、自动化平台验证、设备/生产快照验证仍是三件分开的事实：
> 后者未执行，外部删除/黑名单同步覆盖仍未验证。

---

> **实现者 F1 修复跟进（2026-09-13）**
> 已将 Sheets HTTP 刷新预算与 D1 读取预算分离，固定为 20 秒；
> D1 搜索仍为 2 秒。新增 3 秒延迟 CSV 的真实 FFI/HTTP 回归。
> 本地验证详情见 [F1 修复记录](catalog-f1-fix-2026-09-13.md)。
> 此跟进不覆盖上方独立评审结论：F1 待复审，F2 未修改，批次尚未通过。

---

> **独立复审页脚（2026-09-13，评审者追加）**
> 上方评审页脚的 `CHANGES_REQUIRED` 由本节取代：本范围**复审通过**。
> F1 已修复（`sheets.rs` 的 `SNAPSHOT_TIMEOUT = 20 秒` 与 D1 读预算分离）并经独立探针复验，
> 本文 “20-second maximum HTTP timeout” 的承诺现已与实现一致。
> 详见 [F1 修复记录](catalog-f1-fix-2026-09-13.md) 与
> [批次独立评审记录](batch-review-2026-09-13.md) 的「复审更新」。
> 生产快照体积/发布节奏与外部删除、黑名单同步覆盖仍未验证，不在本次通过范围内。
