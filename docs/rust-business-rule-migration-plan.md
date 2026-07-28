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

Current overall status: **Phase 2 complete (8/8)**. All eight domains listed
below are implemented. No Phase-2 domain remains.

## Completed Phase-2 domains

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

Status: implemented and validated by the repository's native release gate.

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

Remaining risks are limited to future policy changes and are bounded by strict
native-response validation plus complete Python fallback equivalence tests.

### 4. Audio variant pairing and binding decisions

Status: implemented and validated after the full media-page gate passed.

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

- The deliberately broad English substring policy remains user-visible.
- Variant-ID construction is still duplicated in Python and was outside this
  migration's scope.

### 5. Download candidate planning

Status: **completed**. Item 5 uses three precise
typed domains because updater, media, and tool planners have materially
different normalization, duplication, source, and ordering semantics.

Migrated Python ownership:

- `bilikara/updater.py`: `_dedupe_urls`, `_latest_release_api_urls`,
  `_release_list_api_urls`, and `_download_url_candidates` now adapt explicit
  immutable inputs and invoke one updater-only plan operation.
- Complete independently executable references remain as `_py_dedupe_urls`,
  `_py_latest_release_api_urls`, `_py_release_list_api_urls`,
  `_py_download_url_candidates`, and
  `_py_plan_update_download_candidates`.
- `bilikara/rust_backend.py` owns the independently detected
  `plan_update_download_candidates` capability and validates the complete
  native response before `updater.py` uses it.
- `bilikara/cache.py`: `_dash_stream_urls`, preferred-audio URL flattening,
  `_tool_fallback_url`, tool fallback-asset construction, and
  `_download_tool_asset` now adapt explicit immutable values into one media or
  tool plan call. Complete `_py_*` references remain independently executable.
- Runtime platform/architecture and `TOOL_ASSET_BASE_URL` remain Python-owned
  facts and are passed explicitly. Tool release asset selection remains in the
  existing selection policy and is not part of candidate planning.

Typed domain model:

- Input: `UpdateDownloadPlanRequest { candidates:
  Vec<UpdateCandidateInput>, proxy: Option<UpdateDownloadProxy> }`.
- Each input carries `original_index`, URL, and an explicit `Primary`, `Mirror`,
  or `DerivedMirror` source.
- Output: `UpdateDownloadPlan { candidates: Vec<PlannedUpdateCandidate> }`;
  each planned candidate carries the originating input index/source, a
  `Direct` or `Proxy` route, and the normalized URL.
- Duplicate typed input indices are invalid. Empty or whitespace-only inputs
  produce a valid empty plan.
- The typed domain has no serde derives, raw pointers, Python, Tauri, I/O,
  configuration, or mutable state dependencies. It reuses the Phase-1
  `url_utils::format_download_proxy_url` transformation.
- Media input is `MediaDownloadPlanRequest { mode, stream_kind, streams }`.
  Each `MediaStreamUrlInput` carries an original stream index, primary URL,
  and ordered backups. Output candidates carry stream index, `Primary` or
  `Backup` source, optional backup index, and URL.
- Media `DashStreams` mode trims and removes empty URLs while preserving every
  duplicate. `PreferredAudio` mode accepts at most one audio descriptor and
  preserves the raw strings, empties, duplicates, and order used by the
  existing special path. Preferred audio descriptor selection is now owned by
  the separate Item 6 audio-ranking domain; URL flattening remains Item 5.
- Tool input is `ToolDownloadPlanRequest { tool, asset, fallback_bases }`.
  `ToolAssetInput` is either a supplied asset name/primary URL or a
  `DefaultForTarget` with explicit platform/architecture. Output includes the
  resolved asset name and candidates labeled `SuppliedPrimary`,
  `BuiltInPrimary`, or `ConfiguredFallback`, with the originating fallback
  index where applicable.
- Tool planning preserves primary-first order, constructs name-based fallback
  URLs using the existing `urllib.parse.quote`-equivalent rules (including
  slash preservation), skips empty configured bases, and performs exact-string
  stable first-occurrence deduplication without trimming.

JSON FFI schema:

- Additive ABI-v1 export:
  `rust_plan_update_download_candidates(request_json) -> owned response JSON or
  null`.
- Request fields are exactly `schema_version`, `candidates`, and nullable
  `proxy`. Candidate indices must be strictly increasing on the wire; sources
  are `primary`, `mirror`, or `derived_mirror`.
- Response fields are exactly `schema_version`, `status`, and `candidates`.
  Status is `planned` or `empty`; route is `direct` or `proxy`.
- Malformed pointers, UTF-8, JSON, schemas, enums, fields, or indices return
  null. A valid empty plan is a concrete `empty` response.
- Additive ABI-v1 media export:
  `rust_plan_media_download_candidates(request_json)`. Request fields are
  exactly `schema_version`, `mode`, `stream_kind`, and `streams`; response
  fields are exactly `schema_version`, `status`, and `candidates`.
- Additive ABI-v1 tool export:
  `rust_plan_tool_download_candidates(request_json)`. Request fields are
  exactly `schema_version`, `tool`, tagged `asset`, and `fallback_bases`;
  response fields are exactly `schema_version`, `status`, `tool`,
  `asset_name`, and `candidates`.
- Both exports return Rust-owned JSON freed by `rust_free_string`, contain
  panics, reject null/invalid UTF-8/malformed JSON/unsupported schema or enums,
  and return concrete `empty` responses for valid empty plans.

Preserved updater policy and validation:

- URLs are trimmed; empty values are removed; the first occurrence wins; and
  relative primary/mirror/derived-mirror order remains stable.
- Proxy formatting preserves `{url_encoded}`, `{url}`, and suffix-separator
  behavior. An empty proxy or proxy output equal to the direct URL adds no
  candidate. Explicit `proxy_first` controls direct/proxy order.
- Python recomputes the only permissible plan from the request and rejects an
  unknown status/source/route, unknown fields, Boolean or out-of-range indices,
  source/index mismatches, empty or untrimmed URLs, duplicates, invented URLs,
  impossible proxy relationships, count violations, or ordering changes.
- Missing library/symbol, ABI incompatibility, null response, panic, malformed
  JSON, or any validation failure executes the complete Python reference.
- Python still performs every HTTP request, retry, timeout, download,
  installation, error translation, and state update.

Cohesion decision and completed boundary:

- Updater, media, and tool planning were intentionally **not unified into one
  schema**. The updater domain trims/deduplicates globally and supports proxy
  transformation; media preserves duplicates and has two normalization modes;
  tools use name-derived fallbacks and exact-string deduplication.
- The remaining pure candidate construction is covered by the three domains.
  Bilibili response parsing still constructs typed stream descriptors while
  handling an HTTP response; it is response adaptation rather than candidate
  ordering. FFmpeg/ffprobe have no download-URL candidate helper: their source
  discovery is filesystem/runtime I/O.
- HTTP, retries, timeout/error handling, redirect behavior, aria2/BBDown/
  yt-dlp/FFmpeg/ffprobe command construction and execution, extraction,
  filesystem publication, cache workers/mutation, cancellation, and download
  loops remain Python.
- Tool release asset scoring stays in its existing typed selection domain.
  Preferred-audio/video stream selection is separate from candidate URLs and
  is now completed by the Item 6 ranking domains above.

Test coverage:

- Typed Rust, wire, and FFI tests cover empty input, trimming, stable
  deduplication, source/index identity, both proxy orders and placeholders,
  suffix separators, equal/repeated proxy results, mirror order, cross-source
  duplicates, Unicode/encoded URLs, invalid requests, determinism, null/UTF-8,
  malformed JSON/schema/enums/indices, allocation/free repetition, and panic
  containment.
- Python golden-policy tests exercise only `_py_*` references. Backend tests
  cover capability isolation and every fallback/validation class. Strict-native
  fixed and generated fixtures compare the real release Rust library with the
  Python policy without permitting fallback.
- Media coverage includes primary/backup flattening, raw preferred audio,
  duplicate preservation, empty/whitespace strings, Unicode/encoded URLs,
  stream/backup identity, modes, invalid indices, ordering, and determinism.
- Tool coverage includes supplied and built-in primaries, multiple configured
  bases, platform/architecture mappings, unsupported targets, name encoding,
  empty bases, exact duplicate removal, tool/source/index identity, strict
  native validation, allocation/free repetition, and fallback behavior.

Remaining risk: ordering controls which external source is contacted first.
The strict reconstruction validators and complete independent references bound
this risk for all three domains. Cross-platform release-gate confirmation and
production variation in externally supplied URL strings remain the residual
risks; neither can move I/O or mutable state into Rust.

The domain was completed without redesigning these candidate schemas.

### 6. Quality and stream ranking

Status: **completed**. Item 6 uses four typed
domains so quality normalization, video ranking, regular-audio ranking, and
preferred-audio source binding retain their different invariants instead of
being hidden behind a generic scorer.

Migrated Python helpers and ownership:

- `bilikara/cache.py` retains complete independent references named
  `_py_quality_from_choice_index`, `_py_optional_video_quality`,
  `_py_normalize_video_quality`, `_py_dash_max_quality_id`,
  `_py_video_quality_priority`, `_py_ytdlp_max_height`,
  `_py_select_dash_video_stream`, `_py_select_dash_audio_stream`, and
  `_py_select_preferred_dash_audio`.
- Their public wrappers adapt immutable strings, integers, codec names, source
  availability, and original indices; each calls one native operation and maps
  accepted indices back to the original dictionaries. Any unavailable or
  invalid native result invokes the complete corresponding `_py_*` policy.
- Python still reads cache/client configuration under its existing locks,
  fetches DASH metadata, owns URLs, creates BBDown and yt-dlp syntax, performs
  downloads, runs subprocesses, validates files, and mutates cache state.

Typed domain APIs:

```text
decide_quality_policy(QualityPolicyRequest) -> QualityPolicyDecision
select_video_stream(VideoStreamSelectionRequest) -> VideoStreamSelection
select_audio_stream(AudioStreamSelectionRequest) -> AudioStreamSelection
select_preferred_audio_source(PreferredAudioSourceRequest) -> PreferredAudioSourceSelection
```

- `quality_policy` represents all historical Bilibili quality-ID labels while
  restricting configurable normalized choices to the current five labels. It
  returns normalized/optional/indexed quality identities, the exact raw-label
  DASH cap, effective yt-dlp maximum height, and ordered BBDown quality labels.
- `video_stream_ranking` receives original index, quality ID, integer bandwidth,
  and exact codec identity. It preserves the three current stages: constrained
  codec/quality/AVC selection, quality-only fallback, then uncapped fallback.
  Each chosen stage ranks descending quality ID, descending bandwidth, then
  stable original input order. Unknown codec strings retain exact identity;
  Bilibili's `7 -> avc`, `12 -> hevc`, and `13 -> av1` metadata normalization
  remains in the Python API parser.
- `audio_stream_ranking` ranks regular audio by the existing fixed order
  Dolby 30250, FLAC 30251, 192K 30280, 132K 30232, and 64K 30216. Bandwidth is
  deliberately ignored and original input order breaks ties. With Hi-Res off,
  Dolby/FLAC entries in the regular list are removed when a standard entry
  exists, but an all-Hi-Res regular list is retained as the existing fallback.
- `preferred_audio_source_binding` deliberately does not receive quality IDs or
  bandwidth and never ranks regular audio. It preserves the first supplied
  regular candidate exactly; with Hi-Res enabled FLAC overrides regular and
  Dolby overrides FLAC, while with Hi-Res disabled both separate sources are
  ignored. This is distinct from `_select_dash_audio_stream` ranking policy.

Additive ABI-v1 JSON exports and capabilities:

```text
rust_decide_quality_policy / decide_quality_policy
rust_select_video_stream / select_video_stream
rust_select_audio_stream / select_audio_stream
rust_select_preferred_audio_source / select_preferred_audio_source
```

All four return Rust-owned JSON freed by `rust_free_string`, reject null,
invalid UTF-8, malformed JSON, unsupported schemas, unknown fields, and invalid
or duplicate wire indices, and distinguish valid `no_match` from FFI failure.
The Python backend caps stream counts and UTF-8 label/codec lengths, rejects
Boolean-as-integer and out-of-range values, and reconstructs the entire expected
decision/ranking before accepting it. Selected and ranked indices, reasons,
quality/codec caps, preferred source, first-regular identity, and order must
match exactly.

Tests cover typed Rust policy, wire adapters, FFI panic/null/UTF-8/schema and
repeated allocation/free behavior; independent Python golden references;
missing-library/symbol/ABI and malicious native responses; and strict-native
fixed/generated equivalence across qualities, caps, codecs, permutations,
fallback stages, bandwidth ties, unsorted regular-audio inputs, object identity,
Dolby, FLAC, and Hi-Res combinations. Existing cache command regressions
confirm that only policy decisions changed ownership.

Remaining risk: source metadata can contain malformed scalar values. Such
requests fail closed to the original Python policy, preserving its behavior.
Cross-platform CI remains necessary because the JSON ABI is loaded through
platform-specific dynamic libraries. Downloader-specific selector strings and
arguments intentionally remain Python adapters rather than canonical policy.

### 7. Cache planning calculations

Status: **completed**.

The complete independent Python reference is `_py_plan_cache_window`. It takes
frozen `CachePlanItem` and `CachePlanRequest` values and returns one frozen
`CachePlan`; it does not call Rust, inspect files, acquire locks, mutate the
manager/store, or operate worker threads. Python resolves filesystem readiness
before each bounded planning request. A synchronization can therefore resolve
readiness for both its state-plan snapshot and its later priority-plan snapshot.

Typed Rust API:

```text
CacheItem { original_index, item_id, cache_ready }
CachePlanRequest {
  items, max_items, retention_limit, active_item_ids,
  primary_active_item_id, urgent_item_ids
}
CachePlan { desired_ids, pending_order, retained_ids, preempt_ids }
plan_cache_window(CachePlanRequest) -> Result<CachePlan, CachePlanError>
```

The domain is deterministic and typed, uses input-order traversal, and performs
no I/O, locking, process control, scheduling, environment access, or global
mutation. `preempt_ids` is only a proposal reproducing the former
`_prioritize_cache_window` decision; it contains at most the primary active ID.

Additive ABI-v1 wire schema and capability:

```text
rust_plan_cache_window(request_json) -> owned response JSON or null
request = {
  schema_version: 1,
  items: [{ original_index, item_id, cache_ready }],
  max_items, retention_limit, active_item_ids,
  primary_active_item_id, urgent_item_ids
}
response = {
  schema_version: 1,
  desired_ids, pending_order, retained_ids, preempt_ids
}
```

The strict schema rejects null/invalid UTF-8, malformed JSON, unsupported
versions, unknown fields, Boolean numeric values, out-of-range indices,
oversized/empty/NUL IDs, duplicate IDs/indices/references, and unknown or
invalid active/urgent references. Rust owns the returned string until Python
calls `rust_free_string`; failures return null while an empty valid plan returns
a concrete response.

`try_plan_cache_window` independently validates both directions. It requires
known unique IDs, pending as ordered desired non-ready IDs, desired as the
ordered window, retained as desired plus no more than the configured number of
ready outside-window IDs in traversal order, and at most the permitted primary
preemption. Finally it recomputes `_py_plan_cache_window` and requires exact
field-for-field and order-for-order equality. Missing libraries/symbols, ABI
mismatch, native exceptions/panics, nulls, malformed or nonconforming JSON,
invented/missing/duplicate/reordered IDs, invalid retention/preemption, or any
result mismatch cause complete Python fallback; native and Python results are
never partially merged.

Each synchronization calculates one accepted state plan whose desired,
pending, and retained outputs own the state/window decision. After ensure/drop
operations that may change active or urgent runtime facts, Python calculates a
fresh priority plan. Immediately before applying a proposed preemption, Python
revalidates the live active item, pending order, urgent next item, and shutdown
state under the manager lock. Only then does it capture the matching processes;
queue insertion and process termination remain Python-owned and occur outside
that validation lock.

Filesystem readiness may therefore be evaluated for both bounded planning
snapshots. This additional check is intentional: the first plan owns
desired/pending/retained results, while the second refreshes priority and
preemption facts after queue/start work. The implementation must not be
described as one accepted plan total for the entire synchronization operation.
Python remains solely responsible for locks and state assignment, orphan
cleanup, filesystem readiness, cache creation/deletion, queue mutation,
interruption messages and process termination, retries, urgent/current-item
behavior, worker lifecycle, store updates, persistence, and notifications. The
retention buffer and cache-limit semantics are unchanged. Compatibility
wrappers retain the prior private method surface.

Tests cover Python-only policy matrices, typed Rust and strict wire behavior,
FFI null/UTF-8/schema/ownership/free/panic behavior, Python backend request and
response fallback classes, generated native equivalence across permutations,
limits, retention, ready masks, active items and urgent items, and existing
CacheManager queue/preemption/retry/reconciliation behavior without real media
downloads.

Residual risk is limited to cross-platform/runtime concurrency variation while
Python applies a validated immutable proposal. Exact Python reconstruction,
the fresh priority plan, and apply-time active/urgent validation bound that
risk. No scored priority lane, dynamic preemption policy, new worker, or extra
download concurrency was introduced.

### 8. Playlist ordering and deduplication

Status: **completed**. This is the eighth and final Phase-2 domain.

Independent Python references and value models:

- `_py_plan_playlist_order` accepts frozen `PlaylistOrderRequest` and
  `PlaylistOrderItem` descriptors and returns `PlaylistOrderPlan`.
- `_py_playlist_identity_key` preserves BVID-over-AID identity, video page,
  positive selected-audio pages in supplied order, and repeated pages.
- `_py_decide_playlist_duplicate` accepts frozen active/history descriptors and
  returns `PlaylistDuplicateDecision` with only an identity key, active item ID,
  and history original index.
- The references do not acquire store locks, call Rust, use live model objects,
  mutate inputs, persist, notify, or read time/environment state.

Typed Rust APIs:

```text
plan_playlist_order(PlaylistOrderRequest)
  -> Result<PlaylistOrderPlan, PlaylistPlanError>
decide_playlist_duplicate(PlaylistDuplicateRequest)
  -> Result<PlaylistDuplicateDecision, PlaylistPlanError>
```

Ordering supports exactly `rebuild` and `insert_cycle`. Rebuild rotates the
registered requester order after the normalized current requester, assigns
eligible cycle occurrence keys by input traversal, and replaces only eligible
cycle positions. Priority, manual, and unregistered-requester cycle positions
remain fixed. Insert-cycle reproduces the prior traversal/insertion-point
algorithm rather than globally sorting the queue. Both operations conserve
unique IDs and Python maps them back to the exact existing objects; the current
item is never included in the ordered request or output.

Duplicate planning returns the canonical key and first matching references.
Current item precedes queued items, queue order is preserved, and history order
is represented by explicit original indices. Python still constructs entries,
returns detached public copies, increments request counts, removes the old
entry, inserts the newest entry at index zero, records played entries, and owns
all timestamps. Canonical and supplied history keys share an 8192-byte UTF-8
boundary, which covers the maximum legal 512-byte BVID, platform-sized video
page, and 256 positive signed-64-bit audio page values without accepting
unbounded history input.

Additive ABI-v1 capabilities:

```text
rust_plan_playlist_order / plan_playlist_order
rust_decide_playlist_duplicate / decide_playlist_duplicate
```

Wire requests and responses use exact schema-version-1 JSON fields. Typed
domain structures have no serde derives; separate strict wire structures reject
unknown fields, malformed enums and numeric types, duplicate IDs/indices/users,
candidate collisions, invalid operation/candidate combinations, oversized
collections/strings, and invalid identity values. Rust-owned strings use the
existing `rust_free_string` contract; ABI remains version 1.

Python validates requests before native calls, validates full response shape,
ID conservation and references, recomputes the only permissible result with
the independent Python reference, and requires exact field/order equality.
Missing library/symbol, ABI mismatch, exception/panic, null, malformed JSON,
schema/field/type failure, invented/missing/duplicate/reordered IDs, invalid
active/history references, wrong identity, or any result mismatch invokes the
complete Python fallback; results are never partially combined.

Store integration remains atomic under the existing RLock: Python normalizes
names, builds immutable descriptors, calls the bounded deterministic planner,
maps IDs to original objects, verifies conservation again, applies the list,
then performs the existing persistence and notification flow. All I/O, model
mutation, request-count/history/session mutation, current-item changes, server
errors, `allow_repeat`, cache resynchronization, and notifications remain
Python-owned.

Tests cover Python-only golden ordering and duplicate matrices; deterministic
generated ID-conservation/fixed-position cases; typed Rust and wire behavior;
FFI null/UTF-8/schema/ownership/free/panic cases; backend failure and malicious
response fallback; real strict-native equivalence; and existing Store/server
regressions including cycle fairness, priority/manual movement, user changes,
restore, history counts, detached copies, and unstarted-item behavior.

Residual risk is bounded to cross-platform JSON/FFI execution and future
changes to Store policy. Exact Python reconstruction and object-conservation
checks prevent a native result from silently changing fairness or identity.

## Completed Phase-2 migration sequence

1. Update asset scoring and selection.
2. Release filtering and stable/preview selection.
3. Media-page matching and ranking.
4. Audio variant pairing and binding decisions.
5. Download candidate planning using separate cohesive schemas where required.
6. Quality and stream ranking.
7. Cache planning calculations after mutation-free extraction.
8. Playlist ordering and deduplication after mutation-free extraction.

Phase 2 is complete (8/8). No Phase-2 domain remains. Python still owns all I/O
and application mutation, all native capabilities were additive, and ABI
version remains 1.

The AV-delay state machine added during v0.7.0 stabilization is an additional
typed Rust transition policy, not Phase-2 Item 9. Python continues to own its
mutable Store integration, persistence, strict native-response validation, and
complete compatibility fallback.

Phase 2 concerns deterministic immutable decisions. The future migration of
stateful runtime ownership is a different architectural project; see the
[version roadmap](version-roadmap.md) for the post-v0.7 convergence direction.

## Historical rationale for the first Phase-2 domain

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
