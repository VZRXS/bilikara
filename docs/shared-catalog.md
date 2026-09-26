# Shared catalog service

`rust-runtime/src/shared_catalog/` owns catalog business behavior for Python Host
through the runtime-service FFI, native Host, and both Internet Remote adapters.
Python `shared_catalog.py` retains configuration transport, public entry
signatures, native-result validation and the existing background enqueue adapter.
The service reuses `cloudflare_service` HTTP and bounded append scheduling.

## Providers and access

Cloudflare/D1 is primary for search, name/artist browse and category pagination.
A valid empty result is success. Only search transport/timeout/invalid-JSON/size
failures or explicit HTTP/service statuses 408, 429, 500, 502, 503 and 504 qualify
for read-only Sheets fallback. Authorization, validation, other semantic errors,
and local admission failures remain errors. Browse and privileged operations
never use Sheets. Search results are not automatically written back to D1.

The public catalog source is spreadsheet
`18IFzVZh7HhxgcKJP-1qzodFzBsJ4AXoF4ZA6lWSSvOk`, tab `gid=0`, consumed through
`https://docs.google.com/spreadsheets/d/18IFzVZh7HhxgcKJP-1qzodFzBsJ4AXoF4ZA6lWSSvOk/gviz/tq?gid=0&tqx=out:csv`.
It is a public catalog snapshot, not the rating backup or an Apps Script service.
Requests use GET without credentials or redirects; no returned script is evaluated.

Required CSV headers are `bvid`, `title`, `url`, `mid`, and `owner_name`.
Recognized optional metadata includes owner/cover URLs, `tag_1`–`tag_5`, rank,
played count and `preserved_1`–`preserved_5`. Missing optional values remain absent.
UTF-8, quoting, duplicate headers, row widths and field sizes are checked.
Both sources share checked BVID/Bilibili URL normalization and deduplication.
Sheets search matches all case-insensitive whitespace-separated tokens against
BVID, title, owner MID/name and tags, preserving snapshot order.

## Search pagination

Native local search returns `items`, `offset`, `next_offset`, `has_more` and the
filtered `matched_count`. The shared service preserves the provider's
`matched_count` (also accepting `total` or `total_count`) instead of discarding it.
A paged `/search` response must echo the requested `offset`; `has_more` may be
supplied explicitly or derived from the returned total. Totals describe the
keyword matches, not all records in a table. Invalid/ignored later offsets fail
explicitly rather than showing the first page again.

Host scrolling and Remote page navigation request only the needed range. Reads
stay within the existing per-request limit, cache, concurrency and outage bounds;
there is no polling, separate count request or growing-prefix/full-table query.
Remote keeps its current page while loading and reuses cached pages when going
back. The read-only Sheets fallback counts the already cached, filtered snapshot
without another network read.

Older providers that return only a list still expose their returned prefix.
The UI labels it as returned results; it cannot infer a complete match count or
fetch later pages from a provider that ignores `offset`. Those deployments need
the paged `/search` response above to enable shared searches beyond the prefix.

## Configuration and cache

The default D1 installation (`https://api.kevinx96.icu`) enables the verified
Sheets endpoint. Custom `BILIKARA_CF_API_URL` installations do not inherit it.
Host-owned `BILIKARA_CATALOG_SHEETS_URL`, or the additive FFI `sheets_url` field,
can select the exact verified URL, a loopback fixture URL, or an empty string to
disable fallback. Public HTTP/Internet clients cannot select providers or tabs.

D1 retains its short caller-specific read budgets, including the Python search
budget of 2 seconds. Sheets refresh has an independent 20-second HTTP budget,
a 32 MiB response bound, 100,000-row limit and 64 KiB field bound.

The existing AppState owns all transient catalog cache metadata:

- D1: 60-second TTL, 48 entries, 512 KiB per cached result, two distinct uncached
  reads in flight, and 30-second outage backoff. Identical reads share one result;
  other reads wait for a slot within their caller's deadline.
- Sheets: one shared normalized snapshot across keywords and adapters, 60-second
  TTL after fetch/parse completion, one refresh in flight and 30-second failure
  backoff. Competing refresh requests return `catalog_busy` and may retry.

Expired data is discarded and never served on error. Network, parsing and
keyword scanning run outside the AppState mutex. Mutation invalidation advances
a generation so earlier in-flight reads cannot publish or return invalidated
results. Fallback results do not enter the D1 query cache.

## Removal coverage

Confirmed delete-video/delete-invalid/review-reject and delete-MID operations,
and ambiguous service/transport write outcomes, record process-local BVID/MID
exclusions. Explicit authorization/validation rejections do not. Exclusions
survive cache refresh, are not undone by restore, and clear on process restart.
At 10,000 exclusions, additional exclusions disable Sheets rather than lose
coverage. D1 remains available for restored entries.

The public sheet has no verified deletion/blacklist flag; `tag_status` is not
interpreted as one. Upstream publication cadence and external exclusion
synchronization are unverified. Records removed elsewhere or before restart
may remain in a newly fetched sheet. Results identify `source: sheets`; raw read
responses also expose snapshot age bounds and the limited exclusion coverage.
No persistent blacklist authority or synchronization guarantee is implied.

## Compatibility and responsibilities

In-repo callers use `/api/catalog/search`; `/api/lark/search` is a thin alias.
Any `table` selector returns `410 catalog_table_retired`. Direct Feishu token,
table probing and search code are retired. Existing protocol fields such as
`feishu_queued` retain their upstream meanings.

Rust also owns module-level review/admin/rating/maintenance validation and
response interpretation. The separate monthly maintenance runner, local rating
identity ledger, login/cache lifecycle, UI flow and public permissions retain
their existing ownership. There is no parallel Android/desktop catalog backend.
