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

Status: implemented as the first Phase-2 domain through the single
`rust_select_update_asset` JSON export. Python still owns input adaptation,
response validation, result construction, and the complete fallback.

Current Python ownership:

- `bilikara/updater.py`
- `_score_asset_for_target`
- `select_update_asset`
- `_asset_text` and `_coerce_asset_size` remain Python adapters; asset size is
  normalized only after selection and is not a scoring input;
- existing Phase-1 token classifiers and archive recognition supply utility
  semantics but do not own the scoring policy.

Input/output model:

```json
{
  "schema_version": 1,
  "assets": [
    {
      "original_index": 0,
      "name": "bilikara-v0.7.0-windows-x64.zip",
      "label": "",
      "browser_download_url": "https://example/file.zip",
      "content_type": "application/zip"
    }
  ],
  "target": {"platform": "windows", "arch": "x64"}
}
```

The response should be structured and explicit:

```json
{
  "schema_version": 1,
  "status": "selected",
  "selected_index": 0,
  "scores": [{"original_index": 0, "score": 140}]
}
```

`status` distinguishes `selected` from a valid `no_match`. Invalid request
syntax, an FFI failure, or an invalid response produces the backend-failure
signal and invokes the Python fallback. Returning original indices avoids
round-tripping or reconstructing arbitrary release dictionary fields.

User-visible policy:

- supported platform and architecture compatibility;
- rejection of cross-platform assets;
- universal macOS handling;
- exact-architecture preference;
- first-in-input tie breaking for equal scores.

The current Python selector does **not** use package size as a tie breaker.
`size` is added to the selected result only after selection, so changing asset
sizes must not change the chosen index.

Proposed Rust data structures:

```text
AssetDescriptor { original_index, name, label, download_url, content_type }
UpdateTarget { platform, arch }
AssetScore { original_index, score }
AssetSelection { status, selected_index, scores }
```

Proposed coarse FFI API:

```text
rust_select_update_asset(request_json) -> owned response JSON or null
```

Python fallback strategy: preserve the current scorer and selector together as
`_py_score_asset_for_target` and `_py_select_update_asset`. Use Python when the
symbol is absent, ABI is incompatible, input serialization fails, Rust returns
null/malformed JSON, or the response fails schema validation. A valid
`no_match` response must not trigger fallback.

Required golden/regression tests:

- current Windows x64 and ARM64 preference cases;
- macOS ARM64, Intel, and universal packages;
- Linux rejection under current auto-update support;
- wrong-platform and wrong-architecture rejection;
- checksum/signature/text assets and missing URLs;
- `x86_64` token behavior;
- invalid/missing/different sizes proving size has no effect;
- equal scores and stable original-order tie breaking;
- full snapshots of score vectors and selected indices;
- Rust/Python property equivalence over generated asset combinations;
- malformed JSON, null response, missing symbol, and Python fallback.

Risk: low-to-medium. Selection changes are user-visible, but the operation is
small, deterministic, isolated from downloading, and already has strong tests.

Recommended order: **first**.

### 2. Release filtering and stable/preview selection

Current Python ownership:

- `bilikara/updater.py`
- `_coerce_releases`
- `_latest_release_for_current`
- `is_release_version`
- `is_preview_version`
- `is_stable_version`
- `is_newer_version`
- `check_for_update` must remain Python because it coordinates fetched data and
  user-visible update results.

Input/output model: release descriptors containing original index, tag, draft
flag, and prerelease metadata; current version and `include_preview`; response
containing selected index or `no_match`. Python retains the original release
objects.

Dependencies: Phase-1 version normalization, tuple parsing, and sort keys.

User-visible policy: ignoring drafts/invalid tags, stable versus preview
eligibility, stable-over-preview ordering for equal semantic versions, and
behavior for development current versions.

Proposed Rust data structures:

```text
ReleaseDescriptor { index, tag, draft }
ReleaseSelectionRequest { current_version, include_preview, releases }
ReleaseSelection { selected_index, candidate_indices }
```

Proposed FFI:

```text
rust_select_release(request_json) -> owned response JSON or null
```

Python fallback: preserve one Python selection entry point that composes the
existing version helpers. Treat a valid `no_match` as a completed Rust result.

Golden tests: all stable/preview transitions, uppercase tags, invalid tags,
draft filtering, empty releases, duplicate semantic versions, original-order
ties, non-release current builds, malformed responses, and equivalence against
the current check-for-update fixtures.

Risk: medium. A subtle change can offer the wrong release to every user, and
the current behavior is spread between parsing, filtering, and orchestration.

Recommended order: second, after asset selection establishes the structured
business-rule FFI pattern.

### 3. Media-page matching and ranking

Current Python ownership:

- `bilikara/bilibili.py`
- `parse_video_pages` remains Python initially because it adapts Bilibili
  dictionaries;
- `select_matching_pages`
- `_is_better_cluster`
- `_cluster_spread`
- `_cluster_representative_duration`
- `_preferred_or_first_page`.

Input/output model: normalized pages `{page, cid, duration, part}`, preferred
page, and tolerance seconds; response with ordered selected page indices and
optional ranking diagnostics.

Dependencies: integer ordering and duration arithmetic only after Python has
normalized the API response.

User-visible policy: choosing the largest duration cluster, preferring longer
representative duration, preserving a requested page, minimizing spread, and
deterministic page-number tie breaking.

Proposed Rust structures:

```text
MediaPage { page, cid, duration, part }
PageMatchRequest { pages, preferred_page, tolerance_seconds }
PageMatchResult { selected_pages, reason }
```

Proposed FFI:

```text
rust_select_media_pages(request_json) -> owned response JSON or null
```

Python fallback: retain the complete clustering algorithm. Python maps returned
page numbers to existing `VideoPage` objects and rejects unknown/duplicate
indices before accepting Rust output.

Golden tests: empty/single page, invalid short pages filtered by the Python
adapter, tolerance boundaries, multiple equal-size clusters, preferred-page
ties, duration/spread ties, shuffled inputs, duplicate page numbers, and all
existing multi-page fixtures.

Risk: medium. It is pure and bounded, but wrong output changes which video or
audio content is played and feeds later binding decisions.

Recommended order: third.

### 4. Audio variant pairing and binding decisions

Current Python ownership:

- `bilikara/bilibili.py`
- `_part_keyword_match`
- `_is_auto_dual_audio_pair`
- `_auto_dual_audio_video_page`
- `_requires_manual_binding`
- portions of `fetch_video_item` apply the decision and must remain Python;
- duplicated variant identifiers in `bilibili.py`, `cache.py`, and `store.py`
  should be consolidated before migration.

Input/output model: normalized selected pages with page number, duration, and
part label; response containing binding mode (`single`, `automatic`, or
`manual_required`), chosen video page, and proposed audio variants.

Dependencies: keyword normalization and duration tolerance plus the media-page
result. No fetch or downloader data may cross into the rule implementation.

User-visible policy: recognizing vocal/accompaniment labels, deciding when two
pages can pair automatically, and when the user must bind tracks manually.

Proposed Rust structures:

```text
AudioPage { page, duration, part }
BindingDecision { mode, video_page, audio_pages, reason }
```

Proposed FFI:

```text
rust_decide_audio_binding(request_json) -> owned response JSON or null
```

Python fallback: preserve the full decision group, validate returned page
references, and construct existing model payloads in Python.

Golden tests: single page; recognized Japanese/Chinese/English vocal labels;
P1/P2 automatic pairing; tolerance edges; reversed page order; unrecognized
two-page labels; three or more pages; and manual-binding exception regressions.

Risk: medium-to-high because the decision is directly visible during karaoke
playback and current logic is interleaved with model construction.

Recommended order: after media-page matching.

### 5. Quality and stream ranking

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
