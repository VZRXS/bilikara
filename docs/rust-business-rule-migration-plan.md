# Rust business-rule migration plan

## Phase boundary

Phase 2 may migrate cohesive, deterministic business-rule domains after the
Phase-1 native utility layer. It is not an I/O-engine migration. A Phase-2
operation receives a complete immutable request, computes a result, and has no
authority to fetch, persist, execute, schedule, or mutate application state.

The preferred boundary is one coarse-grained call per domain, not one C ABI
symbol per small Python helper. JSON is appropriate here because the inputs are
already nested Python dictionaries/lists, the rules produce structured
results, and a documented request/response schema is safer than parallel arrays
or an unstable Rust struct layout.

Example shapes:

```text
select_update_asset(request_json) -> response_json
select_media_pages(request_json) -> response_json
decide_audio_binding(request_json) -> response_json
plan_download_candidates(request_json) -> response_json
```

Every migration must retain the complete Python implementation as a fallback.
Rust success, domain-level “no result”, invalid request syntax, and backend/FFI
failure must remain distinguishable. Additive exports remain ABI version 1.

## Explicit exclusions

Phase 2 must not contain:

- HTTP requests or redirect resolution;
- filesystem reads, writes, traversal checks, archive extraction, or deletion;
- subprocess construction or execution;
- worker loops, task scheduling, retries, or cancellation;
- mutable stores, persistence, or state transitions;
- thread creation, locks, condition variables, or synchronization;
- Tauri lifecycle or restart behavior;
- server routes, request parsing, SSE, or response writing.

Python must gather runtime data, perform I/O, and apply returned decisions. Rust
must only evaluate the supplied value model.

## Candidate domains

### 1. Update asset scoring and selection

Status: implemented and stabilized through the single `rust_select_update_asset` JSON export.

Ownership boundary:
- `bilikara/updater.py` adapts candidate asset dicts and target facts.
- `bilikara/rust_backend.py` handles FFI call, payload validation, and score vector verification.
- Python retains original dictionary objects and applies selection decisions.

Typed domain input/output:
- Input: `UpdateTarget { platform, arch }`, list of `AssetDescriptor { original_index, name, label, download_url, content_type }`.
- Output: `AssetSelection { status, selected_index, scores: Vec<AssetScore> }`.

JSON FFI schema:
- Export: `rust_select_update_asset(request_json) -> owned response JSON or null` (schema v1).

Fallback semantics:
- `_py_select_update_asset` executes if native library is missing, ABI is incompatible, request/response fails validation, or native panic occurs.
- A valid `no_match` response is accepted without fallback.

User-visible policy:
- Scoring based on target platform and architecture compatibility.
- Rejection of wrong-platform assets.
- Support for macOS universal assets and exact-architecture preference.
- Earliest original-index tie breaking for equal scores. Asset file size does not alter score.

Important invariants:
- Request original indices strictly increasing non-negative integers.
- Score list length equals input asset list length.
- `selected_index` points to the candidate with the highest non-negative score.

Test coverage:
- Direct Rust unit tests in `rust/src/asset_selection.rs`.
- Backend validation and fallback tests in `tests/test_updater.py`.
- Rust/Python equivalence tests over asset combinations.

Remaining risks:
- Low. Bounded to update asset selection logic.

### 2. Release filtering and stable/preview selection

Status: implemented and stabilized through the `rust_select_release` JSON export.

Ownership boundary:
- `bilikara/updater.py` adapts release dicts and orchestrates update checking.
- `bilikara/rust_backend.py` validates native payload invariants.
- Python retains full release metadata and coordinates user notification.

Typed domain input/output:
- Input: `ReleaseSelectionRequest { current_version, include_preview, releases: Vec<ReleaseCandidate> }`.
- Output: `ReleaseSelection::Selected { selected_index }` or `ReleaseSelection::NoMatch`.

JSON FFI schema:
- Export: `rust_select_release(request_json) -> owned response JSON or null` (schema v1).

Fallback semantics:
- `_py_latest_release_for_current` is invoked if native library is unavailable, ABI mismatch occurs, or JSON/schema validation fails.
- A valid `no_match` response returns empty result `{}` without triggering fallback.

User-visible policy:
- Rejection of draft releases and malformed semver tags.
- Stable-over-preview version ordering unless `include_preview` is enabled.
- Stable version ordering by semver sort key tuple.

Important invariants:
- `selected_index` refers to a non-draft release within request list bounds.
- `status == "no_match"` yields explicit `selected_index: null` response.

Test coverage:
- Direct Rust domain tests in `rust/src/release_selection.rs`.
- Python backend fallback and validation tests in `tests/test_release_selection_backend.py`.
- Native release filtering equivalence tests.

Remaining risks:
- Low. Bounded to release filtering and semantic version ordering.

### 3. Media-page matching and ranking

Status: implemented and locally stabilized; cross-platform validation is
required in the pull request to `dev`.

Ownership boundary:
- `bilikara/bilibili.py` adapts `VideoPage` list into JSON descriptors and maps selected indices back to original `VideoPage` instances.
- `bilikara/rust_backend.py` validates response schema, status, and index set.
- Python retains Bilibili API querying, model creation, and state mutation.

Typed domain input/output:
- Input: `MediaPageSelectionRequest { preferred_page, tolerance_seconds, pages: Vec<MediaPageDescriptor> }`.
- Output: `MediaPageSelection::Selected { selected_indices }` or `MediaPageSelection::NoMatch`.

JSON FFI schema:
- Export: `rust_select_media_pages(request_json) -> owned response JSON or null` (schema v1).

Fallback semantics:
- `_py_select_matching_pages` executes if native execution fails, library is missing, ABI is incompatible, or native response violates response invariants.
- Native `no_match` is valid ONLY for an empty request (`pages = []`). Native `no_match` for a non-empty request is rejected and triggers Python fallback.

User-visible policy:
- Windowing search for candidate cluster within `tolerance_seconds`.
- Largest cluster size wins; ties broken by higher average representative duration, presence of `preferred_page`, smaller duration spread, and lexicographical page sequence.
- Stable sorting preserving original duration-sorted relative order for duplicate page numbers.

Important invariants:
- `status == "no_match"`: request pages must be empty and `selected_indices` must be `[]`.
- `status == "selected"`: request pages must be non-empty and `selected_indices` must be non-empty.
- Selected indices must be unique, non-Boolean integers within original request index set, and preserve original `VideoPage` object identities.

Test coverage:
- 23 direct typed Rust tests in `rust/src/media_page_selection.rs`, including
  typed-API duplicate-index rejection and unique non-monotonic indices.
- Policy and exact identity/order tests in `tests/test_media_page_selection_policy.py`.
- Backend validation, fallback, order mapping, and native equivalence tests in
  `tests/test_media_page_selection_backend.py`. CI runs the Python suite with
  `BILIKARA_REQUIRE_RUST_LIB=1`, so native equivalence cannot silently skip or
  use `_py_select_matching_pages` as fallback.

Remaining risks:
- Cross-platform confirmation remains required in the pull request to `dev`;
  local stabilization does not claim that PR validation has completed.

### 4. Audio variant pairing and binding decisions

Status: implemented and locally stabilized after the full media-page Stage A
gate passed. Cross-platform validation is required in the pull request to
`dev`; that PR validation has not yet occurred.

Ownership boundary:

- `rust/src/audio_binding.rs` owns the typed decision domain and its private
  schema-v1 serde wire adapter.
- `bilikara/rust_backend.py` owns strict request/response validation and the
  independently detected `decide_audio_binding` capability.
- `bilikara/bilibili.py` adapts `VideoPage` objects, maps original indices,
  and applies one coarse decision in `fetch_video_item`.
- Python retains Bilibili adaptation, `PlaylistItem` construction, all user
  errors, the manual-selection path, URL/embed construction, state changes,
  and the complete `_py_*` reference decision.

Typed domain input/output:

- Input: `AudioBindingRequest { tolerance_seconds, pages:
  Vec<AudioPageDescriptor> }`, where each descriptor contains only
  `original_index`, `page`, `duration`, and `part`.
- Output: `AudioBindingResult::Decided(AudioBindingDecision)` or
  `AudioBindingResult::NoMatch`.
- Modes are `Single`, `Automatic`, and `ManualRequired`; invalid negative
  tolerance or duplicate original indices return
  `AudioBindingError::InvalidRequest`.
- Domain structs have no serde derives. Tauri must eventually call this typed
  API directly instead of routing through JSON FFI.

JSON FFI schema:

- Export: `rust_decide_audio_binding(request_json) -> owned response JSON or
  null`, additive under ABI version 1.
- Request: schema version 1, non-negative tolerance, and strictly increasing
  wire indices.
- Response: `status` is `decided` or `no_match`; decided responses include one
  of the three modes, selected original indices, and an optional automatic
  video index.
- Empty input is a concrete `no_match` response. Malformed pointers, UTF-8,
  JSON, schemas, or invalid domain requests return null.

Preserved user-visible policy:

- Keyword matching is trimmed, lowercased substring matching for `on`, `off`,
  `人声`, `原唱`, and `伴奏`, including existing matches inside longer English
  words.
- Exactly two pages pair automatically when at least one label matches and
  their absolute duration difference is within the Python-supplied tolerance.
- Stable page-number sorting selects the P2 automatic-video override only for
  P1/P2 where P1 is unrecognized and P2 is recognized.
- More than two pages, or a non-automatic two-page set, requires manual
  binding. One page is `single`; empty input is `no_match`.
- Automatic selected indices preserve original input order.

Fallback and application semantics:

- `_py_part_keyword_match`, `_py_is_auto_dual_audio_pair`,
  `_py_auto_dual_audio_video_page`, `_py_requires_manual_binding`, and
  `_py_decide_audio_binding` never call Rust.
- Any missing symbol, missing/incompatible library, malformed response,
  impossible cardinality, unknown/duplicate index, null, or native exception
  invokes `_py_decide_audio_binding`.
- `fetch_video_item` calculates the decision once. Manual errors and supplied
  selections remain Python; automatic/single selected indices map to the same
  input `VideoPage` instances.
- `_variant_id`, `selected_audio_variant_id`, and all duplicated variant-ID
  construction remain Python and were intentionally not consolidated or
  migrated in this work.

Test coverage:

- Direct typed-domain and wire tests in `rust/src/audio_binding.rs`, plus FFI
  null/UTF-8/ownership/free/panic tests in `rust/src/ffi.rs`.
- Python golden policy tests in `tests/test_audio_binding_policy.py`.
- Strict backend validation, fallback, capability isolation, real native
  equivalence, identity, and ordering tests in
  `tests/test_audio_binding_backend.py`.
- `fetch_video_item` regressions cover single, automatic, P1/P2 override,
  two-/three-page manual binding, valid/invalid supplied selections, model
  fields, URLs, embed fields, variant defaults, and native/fallback equality.

Remaining risks:

- Cross-platform PR checks for `dev` remain outstanding.
- The deliberately broad English substring policy remains user-visible.
- Variant-ID construction is still duplicated in Python and was outside this
  migration's scope.

### 5. Quality and stream ranking

Status: next candidate, not started. No quality/stream selection, download
planning, BBDown, aria2, cache, or FFmpeg work was begun as part of the audio
binding migration.

Current Python ownership:

- `bilikara/cache.py`
- `_quality_from_choice_index`
- `_optional_video_quality`
- `_normalize_video_quality`
- `_dash_max_quality_id`
- `_video_quality_priority`
- `_select_dash_video_stream`
- `_select_dash_audio_stream`
- `_ytdlp_max_height` and `_ytdlp_format_selector` consume the policy but
  command creation remains Python.

Input/output model: explicit quality preference, codec constraints, Hi-Res
flag, AVC cap, and normalized stream descriptors; output selected stream index
and a reason/rank vector. Python retains URLs, cookies, and download commands.

Dependencies: current quality constants, codec aliases, quality IDs, bandwidth,
and audio-quality ordering.

User-visible policy: maximum resolution, codec fallback, AVC caps, Hi-Res/Dolby
preference, and fallback when requested streams are unavailable.

Proposed Rust structures:

```text
VideoStream { index, quality_id, bandwidth, codec }
AudioStream { index, quality_id, bandwidth }
StreamPolicy { max_quality_id, codec, avc_cap, allow_hires }
StreamSelection { selected_index, ranked_indices, reason }
```

Proposed FFI:

```text
rust_rank_media_streams(request_json) -> owned response JSON or null
```

Python fallback: retain current selectors as a single policy group and validate
that selected indices refer to supplied streams before using Rust output.

Golden tests: every quality label/ID, cap boundaries, codec requested/missing,
bandwidth ties, Dolby/FLAC preference, Hi-Res disabled, empty streams, and
current BBDown/yt-dlp/DASH policy regressions without executing commands.

Risk: high. Small ranking changes affect bandwidth, compatibility, and media
quality, while several download sources consume related policy differently.

Recommended order: only after page and binding domains.

### 6. Download candidate planning

Current Python ownership:

- `bilikara/updater.py`: `_dedupe_urls`, `_download_url_candidates`;
- `bilikara/cache.py`: `_dash_stream_urls`, `_tool_fallback_url`, fallback asset
  helpers, and selected pure portions of URL/source planning;
- `_download_tool_asset`, `_download_url`, downloader commands, and retry loops
  are explicitly excluded.

Input/output model: primary URLs, mirrors, proxy configuration, proxy-first
flag, source kind, and explicit platform/architecture facts; output an ordered,
deduplicated candidate list with reason/source labels.

Dependencies: Phase-1 proxy URL formatting and explicit configuration values.
No function may read environment variables or global config inside Rust.

User-visible policy: proxy-first ordering, direct fallback, mirror priority,
duplicate removal, and possibly tool-source preference. Separate APIs may be
needed if updater and media-tool semantics are not actually identical.

Proposed Rust structures:

```text
Candidate { url, source, priority }
DownloadPlanRequest { primary, mirrors, proxy, proxy_first }
DownloadPlan { candidates }
```

Proposed FFI:

```text
rust_plan_download_candidates(request_json) -> owned response JSON or null
```

Python fallback: retain ordered candidate construction; Python performs every
request, retry, timeout, and error translation.

Golden tests: empty URLs, duplicate direct/proxy URLs, placeholder proxies,
proxy-first both ways, mirror stability, Unicode URLs, and current retry-order
fixtures. Tests must assert planning only and mock all network entry points.

Risk: medium-to-high. Although pure, ordering controls which external source is
tried first and therefore affects reliability and privacy expectations.

Recommended order: after update selection and only after updater/tool planners
are shown to share a stable schema.

### 7. Playlist ordering and deduplication

Current Python ownership:

- `bilikara/store.py`
- pure portions of `_insert_cycle_item_unlocked`,
  `_rebuild_cycle_items_unlocked`, `_requester_cycle_state_unlocked`,
  `_rotated_cycle_users_unlocked`, history/session dedupe-key logic, and queue
  ordering;
- all lock acquisition, model mutation, persistence, notifications, and public
  store methods remain Python.

Input/output model: immutable snapshots of users and queue items containing
stable IDs, requester, priority/manual flags, and current position; response is
an ordered list of existing IDs plus explicit dedupe decisions.

Dependencies: playlist fairness and session-history semantics. The Rust layer
must never receive live `PlaylistItem` objects or mutate the store.

User-visible policy: requester rotation, priority placement, duplicate request
handling, current-item retention, and stable ordering.

Proposed Rust structures:

```text
QueueItem { id, requester, priority, manual, original_index }
PlaylistPlanRequest { users, items, current_id, cycle_state }
PlaylistPlan { ordered_ids, cycle_state, duplicate_ids }
```

Proposed FFI:

```text
rust_plan_playlist_order(request_json) -> owned response JSON or null
```

Python fallback: calculate a complete proposed order in Python when native
execution fails. In either path, Python validates ID conservation and applies
the plan atomically under the existing lock, then persists/notifies normally.

Golden tests: all existing cycle/priority/manual/reorder cases, duplicate users
and songs, removed/current items, empty users, stable ID conservation, and
property tests proving no item is lost or duplicated.

Risk: very high. It changes core fairness and session behavior and sits next to
mutable state. It should be one of the last Phase-2 domains.

Recommended order: last, after a pure planning boundary is extracted and
extensively shadow-tested in Python.

### 8. Cache planning calculations

Current Python ownership:

- `bilikara/cache.py`
- `_cache_window_plan`
- `_retained_cache_ids`
- pure calculations within `_prioritize_cache_window`, `_is_in_cache_window`,
  and `_should_cache`;
- queue mutation, process interruption, worker behavior, retries, and file
  existence checks remain Python.

Input/output model: ordered immutable item descriptors with cache state,
current position, configured window size, in-flight IDs, and retention limit;
response contains desired IDs, ordered pending IDs, retained IDs, and proposed
preemption IDs.

Dependencies: cache-window and retention policy. Filesystem readiness facts
must be computed in Python and passed as booleans.

User-visible policy: which songs are prepared, which completed entries are
retained, and which active work may be deprioritized. No Rust result may itself
cancel a process.

Proposed Rust structures:

```text
CacheItem { id, position, state, ready, active }
CachePlanRequest { items, max_items, retention_limit, active_ids }
CachePlan { desired_ids, pending_order, retained_ids, preempt_ids }
```

Proposed FFI:

```text
rust_plan_cache_window(request_json) -> owned response JSON or null
```

Python fallback: preserve the existing calculations; validate that every
returned ID exists and every returned set satisfies configured bounds. Python
alone applies queue changes or interrupts work under current locks.

Golden tests: empty/current-only playlists, ready/pending/failed mixes, window
boundaries, retention buffers, priority changes, in-flight items, reordered
playlists, ID conservation, and all current cache planning regression tests.

Risk: high. The calculation is deterministic, but incorrect plans cause wasted
downloads or missing near-term media and interact with worker timing.

Recommended order: late, after pure planning has been extracted from mutation.

## Recommended migration sequence

1. Update asset scoring and selection.
2. Release filtering and stable/preview selection.
3. Media-page matching and ranking.
4. Audio variant pairing and binding decisions.
5. Download candidate planning, if updater/tool schemas can be unified safely.
6. Quality and stream ranking.
7. Cache planning calculations after mutation-free extraction.
8. Playlist ordering and deduplication after mutation-free extraction.

The exact sequence after the first domain should be re-evaluated using test
coverage and production behavior at that time. Only one domain should be
migrated per commit and each should be independently revertible.

## First Phase-2 implementation

The first implementation is **update asset scoring and selection**.

It is safer than the alternatives because:

- `tests/test_updater.py` already covers representative Windows x64/ARM64,
  macOS, universal, Linux rejection, and archive behavior;
- the complete input is a small immutable release-asset list plus an explicit
  target;
- it performs no runtime detection, HTTP, filesystem, subprocess, store, or
  thread work;
- an index-based response lets Python retain the original dictionaries and
  validate the native decision cheaply;
- failure can fall back before any download or installation begins;
- its blast radius is narrower than playback page/binding rules, stream quality
  policy, cache preparation, or playlist fairness.

Its validation includes score-vector golden fixtures and generated Rust/Python
equivalence coverage. Release selection, network fetching, download candidate
ordering, and installation remain outside this domain.
