# Native utility migration inventory

This inventory defines the boundary of Phase 1, the native utility layer. It
was produced by reviewing every Python module in `bilikara/`, including
module-level functions, static methods, regex helpers, parsers, normalizers,
URL builders, path helpers, scalar coercers, and archive recognizers.

`Pure` below means deterministic and free of filesystem, network, subprocess,
thread, and mutable-global interactions. Purity alone does not make a helper a
good FFI candidate: Python-object adapters, very small coercions, and business
policy remain in Python.

This is a historical inventory. Phase 2 is also complete. Its existing Python
references may remain frozen, but new backend/business functionality is now
Rust-authoritative and must not receive a new equivalent Python semantic
fallback. The v0.8 AppState cutover supersedes the Phase-2-era mutable-state
ownership descriptions below: Rust AppState is now the sole application-state
authority, while Python retains transport, persistence I/O, and external-tool
orchestration.

## Existing native utility domains

| Python module and helper | Category | Inputs → output | Dependencies | Pure | Phase 1 decision |
| --- | --- | --- | --- | --- | --- |
| `title_cleanup._py_clean_display_title`, `_clean_bracket_content`, `_remove_part_suffix` | regex/string normalization | title strings → display title | Python/Rust regexes | yes | Migrated as `title_cleanup`; helper pieces stay behind the existing public wrapper. |
| `updater._py_safe_filename` | filename normalization | object, fallback → string | regex | yes | Migrated as `filename`. |
| `updater._py_normalize_version_tag`, `_py_version_tuple`, `_py_version_sort_key` | version normalization/parsing | object → string/optional tuples | version regex | yes | Migrated as `version`. |
| `updater._py_normalize_machine_arch` | label normalization | object → architecture string | alias sets | yes | Migrated as `platform`. Runtime platform detection remains Python. |
| `updater._py_asset_tokens`, `_py_asset_has_*` | tokenization/classification | text/token set → set/bool | regex and alias sets | yes | Migrated as `asset_tokens`. Scoring and selection remain Python. |

## Approved remaining Phase-1 migrations

| Planned Rust module | Python helpers | Category | Inputs → output | Why migrate now |
| --- | --- | --- | --- | --- |
| `url_utils.rs` | `updater._release_list_api_from_latest`, `updater._format_download_proxy_url` | deterministic URL syntax/composition | two strings → string | Cohesive URL transformations with nontrivial placeholder, separator, trimming, and percent-encoding behavior; no request or fallback-order policy. |
| `archive.rs` | pure string core extracted from `updater._is_downloadable_archive` | deterministic archive recognition | name and URL strings → bool | Cohesive file-type recognition with query stripping and signature/checksum exclusions. The dictionary adapter remains Python. |

No other helper is approved for Phase 1. The tables below document why.

## Full module audit

### `bilikara/bilibili.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_cookie_pair_name`, `_collect_cookie_pairs`, `_format_cookie_pairs` | cookie normalization; recursive heterogeneous dict/list adaptation | core pieces yes | Defer. They primarily adapt BBDown JSON/Python containers, so serialization and FFI cost exceed the string work. `cookie_from_bbdown_data` also reads the filesystem. |
| `_normalize_gatcha_uid`, `_normalize_gatcha_uid_list` | UID/space-URL syntax; project exceptions and list adaptation | core yes | Defer. Valuable parsing exists, but this is coupled to Chinese domain errors and Python list handling; migrate only with a future Bilibili identifier API design. |
| `_normalize_gatcha_profile(s)`, `_empty_*_payload`, `_is_legacy_gatcha_cache_payload` | dictionary/schema normalization | mostly | Defer: persistent-data adapters/schema policy, not a native string domain. |
| `_favlist_folder_uid`, `_favlist_folder_key`, `_favlist_browser_id`, `_split_favlist_browser_id`, `_gatcha_favlist_media_id`, `_gatcha_entry_dedupe_key` | identifiers composed from dictionaries | mostly | Defer: tiny Python operations or dictionary adapters; a custom FFI format would be more fragile than the implementation. |
| `_matches_gatcha_keywords`, `_matches_gatcha_favlist_title`, `_first_gatcha_text`, `_gatcha_duration_text` | text matching/coercion | mostly | Defer: application content policy and heterogeneous response adaptation. |
| `_extract_gatcha_entries`, `_extract_gatcha_favlist_entries`, profile/folder summary helpers | API payload parsing | yes after input exists | Defer: large Python dictionaries and Bilibili response schema, not syntax-only parsing. |
| `_dedupe_gatcha_entries`, `_merge_incremental_gatcha_entries`, `_merge_gatcha_entry_data` | dedupe/merge/selection | yes | Defer: state merge and preference policy. |
| `_selected_gatcha_favlist_folder_ids`, `_is_public_gatcha_favlist_folder`, `_is_expired_gatcha_entry` | validation/classification of Python values | yes | Defer: trivial adapters or domain policy; FFI adds no value. |
| `resolve_video_reference` | video identifier and URL parsing plus short-link HTTP resolution | no | Defer: the existing function performs a network request. Splitting its pure syntax half now risks changing public error and redirect behavior. |
| `parse_video_pages`, `_normalize_selected_pages` | heterogeneous API/list parsing | yes | Defer: Python object adaptation dominates. |
| `select_matching_pages`, `_is_better_cluster`, `_cluster_*`, `_preferred_or_first_page` | ranking and selection | yes | Migrated after Phase 1 as the typed `media_page_selection` business-rule domain; Python adaptation and complete fallback remain. Locally stabilized, with cross-platform confirmation required in the PR to `dev`. |
| `_variant_id` | normalized track identifier | yes | Remains Python. It is duplicated in cache/download planning and was intentionally neither consolidated nor migrated with audio binding. |
| `_part_keyword_match`, `_is_auto_dual_audio_pair`, `_auto_dual_audio_video_page`, `_requires_manual_binding` | media binding classification/policy | yes | Migrated after the media-page gate passed as the typed `audio_binding` business-rule domain. Independent `_py_*` references and legacy helpers remain; Python applies the result. |
| `get_mixin_key`, `enc_wbi` | request signing | yes | Defer to a later network/protocol phase; tightly coupled to request authentication. |
| All `_request_*`, `_fetch_*`, refresh, persistence, cache, browse, and background helpers | HTTP, filesystem, locks, state, scheduling | no | Outside Phase 1. |

### `bilikara/cache.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_quality_from_choice_index`, `_optional_video_quality`, `_normalize_video_quality` | quality label validation/defaulting | yes | Excluded from Phase 1; migrated together with consumer decisions as Phase 2 Item 6 `quality_policy`, with complete `_py_*` references. |
| `_normalize_download_source`, `_current_download_source`, `_download_source_label` | source normalization/label policy | yes | Excluded: source preference and cache policy. |
| `_bounded_cache_items` | integer coercion/clamping | yes | Defer: trivial scalar coercion tied to cache policy. |
| `_variant_id`, `_download_track_key`, `_download_track_label`, `_part_label_for_page` | download-track identifiers/labels | yes | Defer: tiny helpers embedded in download planning; `_variant_id` should first be consolidated with `bilibili.py`. |
| `_page_url`, `_build_media_url` | URL composition | yes | Defer: each is a trivial operation in downloader/local-serving code, not a reusable URL parsing domain. |
| `_normalize_output_line`, `_extract_progress`, `_compact_probe_error`, `_format_stage_bytes` | subprocess output cleanup/parsing | core yes | Excluded from this phase because their primary purpose is subprocess/progress handling. |
| `_dash_max_quality_id`, `_video_quality_priority`, `_ytdlp_max_height`, and stream selectors | quality lookup/ranking | yes | Excluded from Phase 1; deterministic decisions migrated as Phase 2 Item 6. BBDown/yt-dlp syntax and all execution remain Python. |
| `_dash_stream_urls`, `_current_platform_tokens`, release asset-name helpers | response adapters/platform selection | mostly | Excluded from Phase 1. The pure URL flattening and fallback asset construction were later migrated as Phase 2 Item 5; runtime detection and dictionary adaptation remain Python. |
| All command, downloader, archive extraction, file lookup, path-size, process, worker, retry, cache-window, and filesystem helpers | I/O, subprocess, state, scheduling, policy | no/mixed | Outside Phase 1 by definition. |

### `bilikara/config.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_looks_like_windows_virtual_adapter` | label classification | yes | Defer: runtime network-adapter policy, not application utility normalization. |
| `_pick_windows_physical_host` | address validation and candidate selection | yes | Excluded: runtime platform detection and ranking. |
| `_split_env_urls`, `_env_truthy` | environment string parsing | transformation yes | Defer: calls `os.getenv` and is trivial configuration adaptation. |
| `_resource_root`, `_frozen_runtime_home`, `_default_app_home`, `_default_host`, detection helpers | runtime path/platform detection | no/mixed | Outside Phase 1. |
| `_detect_app_version`, `ensure_directories` | Git/filesystem/subprocess setup | no | Outside Phase 1. |

### `bilikara/diagnostics.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `redact_text`, `redact_value` | regex redaction and recursive Python-object adaptation | text core yes | Defer: security-sensitive behavior and heterogeneous recursive structures should remain together until a dedicated diagnostics review. |
| `_browser_label`, `_json_code_block`, `_json_bytes`, `_connectivity_result` | scalar/dict formatting | yes | Defer: trivial Python adapters; FFI offers no benefit. |
| All artifact, snapshot, probe, config/log collection helpers | filesystem/network/system state | no | Outside Phase 1. |

### `bilikara/lark_pool_client.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_records_url`, `_fields_url` | URL composition | yes | Defer: two trivial f-strings coupled to the Lark HTTP client. |
| `_field_text`, `_record_to_item`, `_cloudflare_search_item(s)`, `_cloudflare_browse_tags`, `normalize_pool_entry`, `_normalize_pool_entries` | heterogeneous API object adaptation | mostly | Defer: Python dictionary/list handling dominates. |
| `_gatcha_keyword_matched`, `_is_pending_review_record` | domain classification | yes | Defer/exclude: content and review policy rather than syntax normalization. |
| `_require_success`, payload/table helpers | API schema and state policy | mixed | Defer to later protocol/business phases. |
| All request, search, cache, admin, mutation, and background helpers | network, mutable cache, persistence, scheduling | no | Outside Phase 1. |

### `bilikara/playlist_export.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_video_id` | BV/av extraction from entry fields | core yes | Defer: dictionary adapter with three-field precedence; consolidate with future Bilibili identifier parser rather than add a narrow FFI call. |
| `_text`, `_request_count`, `_timestamp`, `_format_time` | scalar coercion/formatting | mostly | Defer: one or two Python operations, locale/time dependency, or dictionary context. |
| `_calculate_time_range`, `_fit_text`, `_wrap_text`, text measurement/font helpers | presentation formatting | mixed | Frozen legacy Python export infrastructure for v0.7. `prewarm_playlist_export_fonts()` intentionally warms the same Pillow/font caches used by the renderer; do not add a meaningless Rust prewarm. Migrate the complete renderer/export pipeline together in future. |
| `_items_in_export_order`, `_playlist_export_sort_key` | ordering | yes | Excluded: ranking/selection. |
| `_parse_font_codepoints`, `_sfnt_offset`, `_font_table`, `_parse_cmap_*`, `_u16`, `_u32` | binary font parsing | yes | Defer: cohesive but belongs to rendering/font infrastructure, not the application native utility layer. |
| `_qr_matrix`, `_append_bits`, `_draw_format_bits`, Reed-Solomon/GF helpers | QR encoding | yes | Defer: cohesive rendering subsystem; no current safety/performance need and outside string/path utility scope. |
| Drawing/render/export helpers | UI/image/file output | no/mixed | Outside Phase 1. |

### `bilikara/remote_identity.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_token_digest` | trimmed SHA-256 identifier | yes | Defer: a single standard-library hash call; FFI would add complexity without benefit. |
| `_safe_timestamp` | float coercion | yes | Defer: trivial scalar coercion. |
| Other methods | secrets, filesystem, locks, mutable identity state | no | Outside Phase 1. |

### `bilikara/server.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_is_path_within` | resolved-path containment validation | no | Explicitly excluded: filesystem/path traversal validation. The file currently contains platform-specific definitions selected at import time. |
| `_port_probe_hosts`, `_network_access_urls`, `_build_remote_access_payload` | host/URL composition plus runtime policy | mixed | Excluded: network/runtime detection and user-visible access policy. |
| `_extract_bvid_from_add_body`, `_diagnostic_browser_info`, `_remote_identity_cookie`, `_guess_type` | request/dict/header adapters | mostly | Defer: trivial Python protocol adapters, MIME database dependency, or security context. |
| All route, SSE, serving, port binding, context, worker, and state helpers | network, filesystem, threads, state | no | Outside Phase 1. |

### `bilikara/store.py` and `bilikara/models.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `PlaylistStore.normalize_session_user_name`, `_normalize_session_user_name` | name trimming/validation | transformation yes | Excluded for now: user-visible identity/business validation and store policy. |
| `_variant_id`, `_session_file_label`, `_split_state_path` | identifiers/path labels | mostly | Defer: dictionary/model/store adapters and persistence naming. |
| `_history_key` and queue/cycle/history policy | identity, ordering, and duplicate decisions | mixed | Excluded from Phase 1; deterministic playlist ordering and duplicate identity decisions were later migrated as Phase 2 Item 8. Python retains locks, model mutation, persistence, timestamps, and notifications. |
| `_load_*` scalar settings, `_session_started_at_from_payload` | scalar coercion | yes | Defer: trivial persistent-payload adaptation. |
| Model `from_dict`/serialization and backup sanitization | Python object/schema adaptation | mostly | Defer: custom serialization would outweigh native work. |
| Queue/cycle/history/session methods | ordering, state transitions, persistence, locks | no/mixed | Mutable Store state remains excluded. Only the immutable deterministic ordering and duplicate decisions were migrated in Phase 2 Item 8. |

### `bilikara/updater.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_release_list_api_from_latest`, `_format_download_proxy_url` | URL syntax/composition | yes | **Migrate now** as `url_utils.rs`. |
| `_dedupe_urls`, `_latest_release_api_urls`, `_release_list_api_urls` | ordered fallback construction | yes | Excluded from Phase 1; later migrated as the updater portion of Phase 2 Item 5. |
| `_download_url_candidates` | ordered proxy/direct candidates | yes | Excluded from Phase 1; later migrated as the updater portion of Phase 2 Item 5. |
| Version, architecture, asset-token, safe-filename helpers | normalization/parsing | yes | Already migrated; Python fallbacks retained. |
| `is_release_version`, `is_preview_version`, `is_stable_version`, `is_newer_version` | classification/comparison | yes | Intentionally remain Python composition over migrated parse results; migration would duplicate trivial policy. |
| `_asset_text` | release asset dictionary → text | yes | Defer: Python dictionary adapter; no useful native work. |
| `_coerce_asset_size` | dictionary scalar coercion | yes | Defer: too trivial for FFI. |
| `_is_downloadable_archive` | dictionary adapter plus archive recognition | core yes | **Migrate only the string recognition core** as `archive.rs`; keep dictionary extraction in Python. |
| `_score_asset_for_target`, `select_update_asset`, `_latest_release_for_current` | scoring/ranking/selection | yes | Explicitly excluded business policy. |
| `_coerce_releases` | heterogeneous response adapter | yes | Defer: Python container filtering. |
| `_safe_version_dir` | composition over migrated filename sanitizer | yes | Defer: already benefits from native filename core; another FFI boundary adds nothing. |
| `_coerce_positive_pid`, `_restart_launch_executable_name` | scalar/path coercion | yes | Defer: trivial and coupled to restart behavior. |
| `_download_url_to_path`, `_safe_extract_zip`, payload-root/app lookup, install-root, restart-script and manager helpers | download, filesystem, extraction, subprocess, update installation | no/mixed | Outside Phase 1. |
| Fetch/check/support/detect helpers | HTTP, release policy, runtime platform detection | no/mixed | Outside Phase 1. |

### Infrastructure-only modules

| Module | Audit result |
| --- | --- |
| `bilikara/rust_backend.py` | FFI infrastructure only. Its lookup, capability, ABI, string transport, and call helpers are not business migration candidates. |
| `bilikara/launcher.py` | Environment checks, runtime paths, stream/log installation, exception hooks, and startup orchestration; no Phase-1 candidate worth an FFI call. |
| `bilikara/__init__.py`, `bilikara/__main__.py` | Package marker and launcher entry point; no utility candidates. |

## Final Phase-1 migration list

The remaining work is deliberately limited to:

1. `url_utils.rs`: release-list URL derivation and download-proxy URL formatting.
2. `archive.rs`: ZIP asset recognition from already-normalized name and URL strings.

After those groups, all reviewed candidates are either already migrated or
intentionally deferred above. Phase 1 does not include scoring, selection,
runtime detection, filesystem/path traversal checks, downloader behavior,
network calls, persistence, scheduling, or UI/rendering.

## Final Phase-1 architecture

Phase 1 is complete with one Cargo crate, one `bilikara_rust` `cdylib`, and the
following domain modules:

```text
rust/src/
├── archive.rs
├── asset_tokens.rs
├── ffi.rs
├── filename.rs
├── lib.rs
├── platform.rs
├── title_cleanup.rs
├── url_utils.rs
└── version.rs
```

`ffi.rs` is the sole owner of raw C pointers, `CStr`/`CString` conversion,
panic containment, failure sentinels, and Rust-owned string freeing. Domain
modules contain pure transformations and their unit tests. `lib.rs` only
declares modules and re-exports the ABI.

### C ABI, version, and compatibility

ABI version `1` is additive: new symbols may be added without changing the
version. The version changes only if an existing symbol's signature, ownership
rule, success value, or failure meaning changes.

The final exports are:

```text
rust_backend_abi_version
rust_clean_display_title
rust_safe_filename
rust_normalize_version_tag
rust_version_tuple
rust_version_sort_key
rust_normalize_machine_arch
rust_asset_tokens
rust_asset_has_windows
rust_asset_has_macos
rust_asset_has_linux
rust_asset_has_x64
rust_asset_has_arm64
rust_asset_has_universal
rust_release_list_api_from_latest
rust_format_download_proxy_url
rust_is_downloadable_archive
rust_free_string
```

Every pointer-accepting export validates null and UTF-8 input and is contained
by `catch_unwind`. String results are Rust-owned and must be released through
`rust_free_string`. `rust_backend_abi_version` takes no pointers, allocates
nothing, and returns `0` only if its protected operation fails.

### Python capabilities and fallback conventions

`bilikara.rust_backend` detects these independently usable capabilities:

```text
title_cleanup
safe_filename
normalize_version_tag
version_tuple
version_sort_key
normalize_machine_arch
asset_tokens
asset_has_windows
asset_has_macos
asset_has_linux
asset_has_x64
asset_has_arm64
asset_has_universal
release_list_api_from_latest
format_download_proxy_url
is_downloadable_archive
```

A missing symbol disables only its capability. A missing library, incompatible
ABI, null result, invalid UTF-8 result, call exception, or documented failure
sentinel causes the Python caller to use its preserved `_py_*` implementation.
Normal source execution never requires Cargo or the library. Release packaging
still uses `BILIKARA_REQUIRE_RUST_LIB=1` to reject an omitted native library.

Optional parses use tri-state results: `(True, value)` means Rust completed a
valid parse, `(True, None)` means Rust completed and rejected the syntax, and
`(False, None)` means the backend could not complete the call. Boolean archive
recognition uses `1` for true, `0` for a valid false, and `-1` for failure.
These conventions prevent invalid input or false from being mistaken for a
fallback condition.

Asset tokens use sorted newline-separated ASCII at the FFI boundary. Their
grammar is `[a-z0-9]+`, so a token cannot contain newline; an empty payload is
a successful empty set. Classifier results use Rust-owned strings `"1"` and
`"0"`, with null or any other payload treated as failure.

### Post-Phase-1 typed business-rule status

The canonical APIs for later Tauri use are typed Rust functions. Their JSON C
exports are temporary Python adapters and remain additive under ABI version 1.
Missing optional symbols disable only their matching capabilities.

| Typed Rust domain | Optional JSON export / Python capability | Status and retained Python ownership |
| --- | --- | --- |
| `media_page_selection` | `rust_select_media_pages` / `select_media_pages` | Implemented and locally stabilized. Cross-platform confirmation remains for the PR to `dev`. Python retains Bilibili adaptation, object mapping, and fallback. |
| `audio_binding` | `rust_decide_audio_binding` / `decide_audio_binding` | Implemented only after the strict media-page gate passed. Python retains model construction, errors, manual selection, URLs, and fallback. |
| `download_candidate_planning` (updater) | `rust_plan_update_download_candidates` / `plan_update_download_candidates` | Implements updater API/direct/proxy construction with trimming, stable deduplication, explicit sources/routes, and complete Python fallback. |
| `media_download_candidate_planning` | `rust_plan_media_download_candidates` / `plan_media_download_candidates` | Implements DASH primary/backup flattening and preferred-audio URL flattening. DASH trims/drops empties and preserves duplicates; preferred audio preserves raw strings and duplicates. Python retains descriptor selection, all I/O, and complete `_py_*` references. |
| `tool_download_candidate_planning` | `rust_plan_tool_download_candidates` / `plan_tool_download_candidates` | Implements supplied/built-in primary plus configured fallback ordering, tool/target fallback asset identity, name quoting, and exact stable deduplication for BBDown, yt-dlp, and aria2c. Python retains runtime detection, asset scoring, downloads, installation, and complete `_py_*` references. |
| `quality_policy` | `rust_decide_quality_policy` / `decide_quality_policy` | Implements active-label normalization, all historical DASH quality IDs, choice-index mapping, AVC-cap evaluation, yt-dlp maximum-height intent, and BBDown ordered quality intent. Python retains configuration, selector/argument syntax, and complete `_py_*` references. |
| `video_stream_ranking` | `rust_select_video_stream` / `select_video_stream` | Implements exact codec/quality/AVC filtering, current two fallback stages, descending quality/bandwidth ranking, stable ties, and selected/ranked original indices. Python retains DASH fetching, stream dictionaries, URLs, and fallback. |
| `audio_stream_ranking` | `rust_select_audio_stream` / `select_audio_stream` | Implements only regular audio quality ordering and Hi-Res filtering/fallback. Bandwidth remains intentionally irrelevant and equal quality preserves input order. Python retains DASH fetching, stream dictionaries, and complete fallback. |
| `preferred_audio_source_binding` | `rust_select_preferred_audio_source` / `select_preferred_audio_source` | Implements preferred-source binding without regular ranking: the first supplied regular candidate is retained, then FLAC and Dolby override it in that order only when Hi-Res is enabled. Python retains object mapping, URLs, file extension/application, and complete fallback. |
| `cache_planning` | `rust_plan_cache_window` / `plan_cache_window` | Phase-2 Item 7. Plans desired, pending, retained, and preempted cache IDs from an immutable snapshot. Python retains external-tool files/workers and operational scheduling; playlist-item cache state is committed through Rust AppState. |
| `playlist_planning` | `rust_plan_playlist_order`, `rust_decide_playlist_duplicate` / matching capabilities | Phase-2 Item 8. Plans queue ordering and duplicate identity from immutable descriptors and is now used internally by Rust AppState. Python retains wire adaptation and persistence I/O, with no stateful fallback. |

The following typed policies were added during v0.7.0 stabilization and are
not additional Phase-2 items or a new "Phase 3":

| Typed Rust policy | Optional JSON export / Python capability | Status and retained Python ownership |
| --- | --- | --- |
| `av_delay` | `rust_apply_av_delay_action` / `apply_av_delay_action` | Canonical pure lock, unlock, adjust, reset, clamping, and button-state transitions, now applied inside Rust AppState. Python retains legacy-file adaptation and persistence I/O, with no stateful fallback. |
| `playback_selector_policy` | `rust_decide_playback_selector_policy` / `decide_playback_selector_policy` | Rust-authoritative valid/default selector modes, explicit validation, and persisted-mode normalization, now committed by Rust AppState. Python supplies explicit capability facts, persists Rust snapshots, and formats warnings. An explicitly configured Python playback-rule mode is not an alternate AppState authority. |
| `tool_prepare_policy` | `rust_decide_tool_prepare_policy` / `decide_tool_prepare_policy` | Rust-authoritative prepare routing from immutable override/install/refresh/version facts. Python retains chmod, metadata and subprocess I/O, release HTTP, download, validation, extraction, and publication. No Python semantic fallback is introduced. |

Audio binding transports only original index, page number, duration, and part
label. It does not transport CID or arbitrary Bilibili metadata. The Rust
domain preserves the existing broad keyword substring policy and returns
`single`, `automatic`, `manual_required`, or domain-level `no_match`.

Variant-ID construction remains entirely in Python and was not consolidated.
Phase 2 later completed all eight domains. Candidate planning, quality policy,
video ranking, regular-audio ranking, preferred-source binding, cache planning,
and playlist ordering/duplicate identity remain separate because their
normalization, fallback, and ordering policies are intentionally different.
Downloader execution, mobile plugin work, and FFmpeg migration were not
started.

### Criteria for future Rust ownership

New backend/business work must start under Rust ownership when its required
domain is ready. Preserve public compatibility APIs where needed, expose
independently detectable capabilities, and distinguish invalid values from
backend failures, but do not create new Python semantic counterparts. Existing
Python I/O and orchestration may adapt Rust commands and persist Rust
snapshots. New stateful features must extend the existing Rust AppState.

The intentionally deferred helpers in the audit remain deferred. In
particular, Bilibili short-link resolution, download-source defaults,
path traversal checks, persistent schema adapters, rendering utilities, and all
filesystem/network/subprocess/thread behavior are not part of Phase 1.
Candidate planning, quality/stream ranking, cache planning, and playlist
planning are the later completed Phase-2 Items 5 through 8 documented in the
business-rule migration plan.
