# Developer review UI and D1 quota repair — local validation

Status: implemented and tested locally; **not deployed to Cloudflare**. Git
delivery is authorized as separate review-quota, developer-UI and validation
documentation commits from `kevinx96:dev` to `VZRXS:work/v0.8.0`; the PR records
the delivered commit IDs. No production D1 query, mutation, migration or quota
benchmark was run for this repair. No new dependency or media asset was added.

## Evidence and cause

The supplied Query Insights screenshot attributes **4.09 million rows read to
56 executions** of:

```sql
DELETE FROM browse_terms
WHERE video_count <= 0 OR NOT EXISTS (
  SELECT 1 FROM browse_term_videos
  WHERE browse_term_videos.term_id = browse_terms.term_id
)
```

That is approximately 73,000 rows read per execution. Every rejected/deleted
video invoked this global scan; reading through a DELETE still consumes read
quota. The screenshot also shows 917,620 reads for 30 full-record SELECTs.
The separate 7M dashboard total is a rolling 24-hour view, not proof that all
those reads belong to one UTC quota day.

The old Rust review flow independently called the full export on every page
refresh. Approval exported before and after append, and the compatibility path
deleted/reinserted still-pending videos before a third export. The delete API
now blacklists the video, making this fallback unsafe as well as expensive.
The earlier approximately 5% estimate covered **one** monthly-style export,
not repeated review refreshes, approval exports and global cleanup per video.

Cloudflare describes the row-read accounting and daily limits in its
[D1 pricing documentation](https://developers.cloudflare.com/d1/platform/pricing/).

## Behavior changes

- Developer mode alone exposes **Expand** beside request navigation. It moves
  the existing request DOM into the shared floating surface, preserving inputs,
  scroll position and listeners; it does not move/recreate video or audio nodes.
  Close icon, backdrop and Escape restore the workspace and focus. Nested review
  confirmation closes before the request modal. Orientation changes restore the
  normal layout before its existing responsive rearrangement.
- **Reject this page** confirms a fixed snapshot of visible pending entries,
  never the entire database or subsequent pages. Requests are sequential, stop
  on the first failure and retain only unfinished entries for retry. A successful
  page gets one refresh. Single rejection and batch rejection accept Enter;
  IME composition/repeat/modifier keys and Enter on Cancel are protected.
- All affected browser-index cleanup is scoped to captured term IDs and is in
  the same transaction as rejection/deletion/reset. Shared terms are checked by
  their actual links, including schemas with foreign-key cascades.
- Approval updates only the existing review marker, without blacklist,
  append/reinsert, re-tagging, or FTS/browse rewrites. Review filtering remains
  authoritative in Rust. Python changes are wire-output validation only.

## Offline cost measurement

`bilikara-api/test/review-quota.spec.ts` uses workerd/Miniflare D1 with **49,682
videos and 35,533 terms**, existing indexes, FK cascades and projection triggers.
Counters are actual local `D1Result.meta.rows_read/rows_written`, not estimates
based on returned row count. The production runtime can differ; these are not
live billing measurements. The old cleanup is executed once, then the new
single-item rejection removes one video, so the subsequent snapshot has 49,681
records.

| Operation | Worker HTTP requests | D1 SQL statements | Rows read | Rows written |
| --- | ---: | ---: | ---: | ---: |
| Old global orphan-cleanup SQL alone | part of 1 rejection | 1 | 71,070 | 2 |
| New complete single-item rejection, including blacklist and cleanup | 1 | 7 | 34 | 10 |
| Old pending-review export, 5,000-row OFFSET batches | 1 | 10 | 274,682 | 0 |
| New narrow review snapshot | 1 | 1 | 49,681 | 0 |
| New 20-item detail page | 1 | 1 | 60 | 0 |
| New approval of 20 BVs, excluding next-page refresh | 1 | 2 | 160 | 20 |

The first two rows intentionally compare **only the former dominant cleanup
SQL** against the **entire new rejection**, not identical statement scopes.
Neither represents all possible tag/fan-out patterns. No row-count saving is
claimed for arbitrary-size MID deletion.

A pending-page refresh now uses **2 Worker HTTP requests instead of 1**, but
only **2 SQL statements instead of 10**, and reads **49,741 instead of 274,682**
rows in this fixture (about **82% less**; one-record population difference noted
above). Approving a nonempty next page uses **3 Worker requests** and **4 SQL
statements**, including one refresh; about **49,901 reads and 20 writes** here.
The former normal path used 3 Worker requests and two full exports (at least
549,364 reads at the initial population), and its fallback added one delete per
BV, another append and a third full export, including the costly global sweeps.

Counts are still exact Rust-filtered snapshot counts, so refresh is **O(catalog
size)**, not free. Refresh is not polled automatically, concurrent refresh clicks
are coalesced in the UI, and batch rejection refreshes only after completion.
No index creation, migration writes, global-version updates or new triggers are
part of this repair.

## Worker handoff and deployment order

The local `bilikara-api/` directory is ignored by the parent repository. Its two
changed files are therefore also preserved in the tracked patch
[`worker-patches/20260929-review-quota.patch`](worker-patches/20260929-review-quota.patch):

- `bilikara-api/src/index.js` (relative to the Worker project root).
- `test/review-quota.spec.ts` (new offline regressions and cost fixture).

The patch is **already applied locally**. Verified from the parent repo with:

```powershell
git apply --reverse --check --directory=bilikara-api docs/worker-patches/20260929-review-quota.patch
```

Worker source SHA-256 after repair:
`0AEDD304154F5E52DD93C3A23424C1D738949C26AADA4EB74A1BDCBFC1F49A64`.

**Worker deployment is planned for tomorrow, 2026-09-30 (Asia/Tokyo), as a
separate operation; it has not been executed or automatically scheduled.**
This commit/push/PR delivery does not deploy the Worker or apply the patch to
Cloudflare. Deploy the Worker before releasing the new Host review flow.
An old Worker returns an explicit unavailable-review error to
the new Host; there is **no fallback to full export or delete/reinsert**. Old
clients keep their existing public endpoints, but their approval flow remains
unsafe/expensive until upgraded. Do not use an old client's approval workflow
as a production acceptance test. No deployment is performed by this document.

## Files changed and architecture

Parent repository:

- `static/app.js`: developer modal lifecycle and guarded review actions.
- `static/index.html`: shared workspace modal and developer controls.
- `static/ui-surfaces.css`: shared-token responsive modal geometry.
- `static/host-layout.js`: close expansion before a layout transition.
- `static/i18n.json`: Chinese/English/Japanese action and failure copy.
- `rust-runtime/src/shared_catalog/operations.rs`: authoritative review policy,
  targeted administrative transport and post-commit refresh outcome handling.
- `bilikara/shared_catalog.py`: validation/forwarding of the new Rust wire
  outcome only; no Python review policy or fallback was added.
- `tests/test_shared_catalog.py`: loopback HTTP/C-ABI/native review regressions.
- `tests/developer_review_browser.cjs`: offline real markup/CSS/action tests.
- `docs/shared-catalog.md`, this report, and the Worker patch above.

Ignored Worker changes are the two files named in the previous section. Other
domains, mutable AppState ownership, downloader/media nodes, schema and public
catalog read contracts are unchanged.

## Validation

Commands run from the repository root unless a directory is specified:

| Command | Result |
| --- | --- |
| `node --check static/app.js` | Passed |
| `node --check static/host-layout.js` | Passed |
| `node --check tests/developer_review_browser.cjs` | Passed |
| `node --check bilikara-api/bilikara-api/src/index.js` | Passed |
| `cargo fmt --manifest-path rust/Cargo.toml --check` | Passed |
| `cargo clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings` | Passed |
| `cargo test --manifest-path rust/Cargo.toml --locked` | 228 passed |
| `cargo build --manifest-path rust/Cargo.toml --release --locked` | Passed |
| `cargo fmt --manifest-path rust-runtime/Cargo.toml --check` | Passed |
| `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --locked -- -D warnings` | Passed |
| `cargo test --manifest-path rust-runtime/Cargo.toml --locked shared_catalog --lib` | 12 passed |
| `cargo build --manifest-path rust-runtime/Cargo.toml --release --locked` | Passed |
| `cargo test --manifest-path rust-runtime/Cargo.toml --locked` | 327 passed, 1 failed, 5 pre-existing ignored tests |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Passed |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | Passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 90 passed, 1 pre-existing ignored test |
| `cargo build --manifest-path src-tauri/Cargo.toml --release --locked` | Passed |
| `$env:BILIKARA_REQUIRE_RUST_LIB='1'; python -m unittest tests.test_shared_catalog tests.test_blacklist_review_integration tests.test_host_build_review_repair -v` | 82 passed |
| `$env:BILIKARA_REQUIRE_RUST_LIB='1'; python -m unittest discover -s tests -v` | 1,790 run; 7 failures, 1 error, 128 skipped |
| `python -m compileall -q bilikara` | Passed |
| `python -m py_compile start_bilikara.py build_bundle.py` | Passed |
| `git diff --check` | Passed |
| `git apply --reverse --check --directory=bilikara-api docs/worker-patches/20260929-review-quota.patch` | Passed |
| In `bilikara-api`: `& .\node_modules\.bin\vitest.cmd run test/review-quota.spec.ts test/browse-projection.spec.ts test/index.spec.ts` | 53 passed |
| In `bilikara-api`: `& .\node_modules\.bin\vitest.cmd run` | 100 passed across 9 files |

Browser command (installed shared Playwright, no added package dependency):

```powershell
$env:NODE_PATH='C:\Users\kevin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:BILIKARA_TEST_BROWSER_CHANNEL='msedge'
$env:BILIKARA_TEST_SCREENSHOT_DIR='D:\bilikara\bilikara\.tmp\review-quota-20260929'
& 'C:\Users\kevin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tests/developer_review_browser.cjs
```

Passed at 1440px/Chinese, 900px/English and 390px/portrait/Japanese. Exercises
developer-only access, upper-right close geometry, unchanged media/input nodes,
restored tabs/scroll/focus, Escape/backdrop/icon close, IME-safe Enter, duplicate
submission protection, fixed-page scope, stop/retry on failure, one post-batch
refresh, Cancel by Enter and committed approval with failed refresh.

Full validation is **not green**:

- Runtime `networking::tests::live_windows_gateways_match_net_ip_configuration`
  fails on this machine: Windows reports `以太网 2` but the enumerated interface
  list does not contain that alias. It also failed outside the sandbox. No
  networking code was changed and the assertion was not weakened.
- Full Python suite: two bundle tests are affected by the configured Libav
  prefix; six BBDown tests resolve the existing `build/bbdown-vendor/bin/BBDown.exe`
  instead of their temporary fixture. Logs are in the ignored
  `.tmp/review-quota-20260929/python-tests.log`. No unrelated test was changed.
- Initial subprocess/temp-file permission failures were rerun with permission
  to use isolated local test processes. The final targeted checks passed.
- The local workerd version supports compatibility date `2026-03-10`, below
  the configured `2026-05-06`; tests warned and used the supported date.
- Distribution packaging (`npm ci` / `npm run build`) was not run: dependencies
  did not change, and the latter regenerates/deletes the existing
  `dist/bilikara` product tree. This task does not authorize replacing a release
  bundle. Rust release compilation is verified separately above. No APK/device
  or live Cloudflare acceptance test was performed.

At the validation checkpoint, no commit or push had occurred. Subsequent Git
delivery is recorded in the PR; no source changes beyond this deployment/status
documentation were made during PR preparation. Cloudflare deployment: **No**.
