# Native utility migration inventory

This inventory defines the boundary of Phase 1, the native utility layer. It
was produced by reviewing every Python module in `bilikara/`, including
module-level functions, static methods, regex helpers, parsers, normalizers,
URL builders, path helpers, scalar coercers, and archive recognizers.

`Pure` below means deterministic and free of filesystem, network, subprocess,
thread, and mutable-global interactions. Purity alone does not make a helper a
good FFI candidate: Python-object adapters, very small coercions, and business
policy remain in Python.

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
| `select_matching_pages`, `_is_better_cluster`, `_cluster_*`, `_preferred_or_first_page` | ranking and selection | yes | Excluded: business selection policy. |
| `_variant_id` | normalized track identifier | yes | Defer: small operation duplicated in cache/download planning; consolidate Python ownership before considering FFI. |
| `_part_keyword_match`, `_is_auto_dual_audio_pair`, `_auto_dual_audio_video_page`, `_requires_manual_binding` | media binding classification/policy | yes | Excluded: user-visible audio binding policy. |
| `get_mixin_key`, `enc_wbi` | request signing | yes | Defer to a later network/protocol phase; tightly coupled to request authentication. |
| All `_request_*`, `_fetch_*`, refresh, persistence, cache, browse, and background helpers | HTTP, filesystem, locks, state, scheduling | no | Outside Phase 1. |

### `bilikara/cache.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_quality_from_choice_index`, `_optional_video_quality`, `_normalize_video_quality` | quality label validation/defaulting | yes | Intentionally defer. They are tiny Python membership checks and the default is cache policy; FFI overhead exceeds the work. |
| `_normalize_download_source`, `_current_download_source`, `_download_source_label` | source normalization/label policy | yes | Excluded: source preference and cache policy. |
| `_bounded_cache_items` | integer coercion/clamping | yes | Defer: trivial scalar coercion tied to cache policy. |
| `_variant_id`, `_download_track_key`, `_download_track_label`, `_part_label_for_page` | download-track identifiers/labels | yes | Defer: tiny helpers embedded in download planning; `_variant_id` should first be consolidated with `bilibili.py`. |
| `_page_url`, `_build_media_url` | URL composition | yes | Defer: each is a trivial operation in downloader/local-serving code, not a reusable URL parsing domain. |
| `_normalize_output_line`, `_extract_progress`, `_compact_probe_error`, `_format_stage_bytes` | subprocess output cleanup/parsing | core yes | Excluded from this phase because their primary purpose is subprocess/progress handling. |
| `_dash_max_quality_id`, `_video_quality_priority`, format selectors and stream selectors | quality lookup/ranking | yes | Excluded: download policy, scoring, ranking, and selection. |
| `_dash_stream_urls`, `_current_platform_tokens`, release asset-name helpers | response adapters/platform selection | mostly | Excluded: source/download planning or heterogeneous dictionaries. |
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
| `_calculate_time_range`, `_fit_text`, `_wrap_text`, text measurement/font helpers | presentation formatting | mixed | Outside Phase 1: UI/export layout behavior and font/filesystem interaction. |
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
| `_variant_id`, `_history_key`, `_session_file_label`, `_split_state_path` | identifiers/path labels | mostly | Defer: dictionary/model/store adapters, persistence naming, or duplicated media identifier logic. |
| `_load_*` scalar settings, `_session_started_at_from_payload` | scalar coercion | yes | Defer: trivial persistent-payload adaptation. |
| Model `from_dict`/serialization and backup sanitization | Python object/schema adaptation | mostly | Defer: custom serialization would outweigh native work. |
| Queue/cycle/history/session methods | ordering, state transitions, persistence, locks | no/mixed | Excluded: playlist policy and mutable store state. |

### `bilikara/updater.py`

| Helpers reviewed | Category / dependencies | Pure | Decision and reason |
| --- | --- | --- | --- |
| `_release_list_api_from_latest`, `_format_download_proxy_url` | URL syntax/composition | yes | **Migrate now** as `url_utils.rs`. |
| `_dedupe_urls`, `_latest_release_api_urls`, `_release_list_api_urls` | ordered fallback construction | yes | Defer/exclude: ordered fallback and source preference policy. The pure URL transform used inside is migrated separately. |
| `_download_url_candidates` | ordered proxy/direct candidates | yes | Explicitly excluded: ordered download fallback policy. |
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
