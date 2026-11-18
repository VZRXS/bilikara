# T7a session diagnostic contract (schema 1)

`SessionTrace` is an independent per-session service. It does not own playback,
run self-tests, change AppState, log inputs, or start background tasks. T5/T8
retain it and await their admitted workers before calling `finish(cancelled)`.
T8 supplies environment, samples, S0–S7 completion/skip status and user answers.
Unknown facts remain JSON `null`; missing measurements are never success.

## next integration boundary

The collector and its T2/T4/T9 adapters are ported from bilikara `b49e1ae`.
They coexist with next's `native_host/purek/trace.rs` until the owning Host
session is switched. `Report::artifact` is an explicit Rust assembly entry;
the current Host diagnostic endpoint does not automatically include this trace.
The `cast_platform` network facts are closed DTOs only at this boundary;
platform collection and selection of the active report remain caller work.

## Collection

1. Construct `SessionTrace::new(platform, target_kind, app_version, os_version)`.
   Entropy failure is explicit. Platform/target are enums. Version inputs accept
   only one to three numeric components and optional known release channels
   (`preview`, `alpha`, `beta`, `rc` plus a number); no IP/build/user/path text.
2. `begin_connection()` returns the connection attempt ID. In discovery's live
   callback forward each `DiscoveryUpdate` to `discovery(id, &update)`.
   `StagesDropped(n)` is cumulative per scan; repeated counts are not summed.
   Live `Stage` records still arrive after T2's returned stage buffer fills.
   `discovery_facts` supplies scan duration and before/after target presence.
   T8 must establish target identity using its admitted device/UDN evidence,
   then call `discovery_target_facts` alongside `discovery_facts` on the same
   connection. Pass T9's target context and only the T2 contexts explicitly
   matched before/after authorization. The report retains three session-HMAC
   cross-references (`target_device_key`, `matched_before_device_key`,
   `matched_after_device_key`); unmatched/unknown contexts stay null. This API
   records caller evidence, never infers a match from unrelated salted keys or
   merges device projections. T8 acceptance must check before/after presence
   booleans and these cross-references agree, including absent/unknown matches.
3. Forward T9 `PureKOperation.stages` via `record_purek_operation`, or each
   `PhaseResult` via `purek`. Parse, resolution, route, pre-auth description,
   registration, confirmation, announcement, health and revoke remain distinct.
   Pre/post service summaries retain known service kinds/version, and re-key
   unknown service digests. QR fields retain presence/count/class facts only.
4. Call `renderer(&renderer)` on discovered or QR-directed descriptions. This
   retains route/address-class/subnet facts and bounded metadata projections.
5. `begin_output(context, config)` returns a separate output ID. Forward T2
   control results using `record_operation(connection, Some(output), &op)`.
   Call `capabilities` with the query state and returned sink list; only MIME
   categories are retained. Report transport/position results through both the
   ordinary operation adapter (status/duration) and `transport` (typed values).
6. Capture `trace.elapsed()` immediately before endpoint bind. Feed its initial
   listener record once, then subscribe **before publication**. Await
   `receive_http(output, endpoint_origin, receiver, cancel)` in the owning worker,
   or forward events via `http_at(output, session_completion_offset, &event)`.
   The approximate pre-bind origin is for session ordering, not a first-byte
   latency benchmark. `HttpStageResult.elapsed` is endpoint uptime, not request
   duration; it is exported as `facts.endpoint_elapsed_ms`, with duration `null`.
   On cancellation the receiver continues collecting for up to 500ms, ending
   earlier on sender close, so late terminal BytesWritten/Disconnect survive.
   T5/T8 must concurrently shut down the endpoint, await the receiver, and only
   then complete the cell/finish the report. The deadline is shared, so traffic
   cannot extend the grace indefinitely; shutdown exceeding 500ms may still
   lose late events. Closing the sender after endpoint shutdown is preferred.
   The receiver counts broadcast lag throughout shutdown.
   Do not replay an endpoint snapshot already ingested through the subscription.
7. Use `first_ts_packet`, `failure`, `sample`, `environment`, `self_test_step`,
   `observations` and `complete_output` for facts owned by the media/T8 worker.
   Complete a cell before starting the next. Five unique cells are retained
   independently of the current/previous ordinary output pair. Completed-cell
   timing is frozen; later cells cannot turn an earlier result into a timeout.
8. `report().json()` returns `{ "diagnostics": { "cast": ..., "cast_self_test": ... } }`.
   Both sections have `schema_version: 1`. `report().text()` returns the safe
   readable summary. `report().artifact(&DiagnosticRequest)` uses the existing
   artifact assembler and adds `diagnostics.cast.json` and `diagnostics.cast.txt`
   to the ZIP. The cast attachment can only be supplied as an immutable `Report`,
   never arbitrary frontend JSON. T5 will connect the active session later.

Batch operations and live callbacks are **alternative** ingestion paths. Never
ingest the same T2 operation twice. T2 lacks absolute timestamps: the batch
adapter reconstructs sequential completions from durations, while live callers
may use `record_stage_at` for measured completion offsets. `purek` records receipt
offsets and preserves each operation duration. Events sort by completion offset,
then a locked sequence number. Distinct `device_key`s stay distinct: callers must
not assume T9's separately salted keys equal T2's discovery keys for one device.

## Bounds and loss

The event buffer retains the first 512 events by default (configurable 0–4096),
counting omissions in `dropped_stages`, like T2's returned stage retention.
It also retains 128 device projections, six connection summaries, two output
summaries, five matrix cells, 24 actions/output, 16 disconnects/output, 32
transport states/output, 32 interface classes and eight unique S0–S7 results.
Known MIME classes are a fixed enum set. Counters saturate. Output aggregate
counts and final classification continue updating even when stage retention
fills. Source-buffer omissions and broadcast lag are distinct fields
`source_dropped_stages` and `delivery_lagged_stages`; they do not claim that live
events were lost when T2 merely omitted them from its return value.
`dropped_device_observations` counts omitted observations;
`dropped_devices` counts distinct omitted device HMACs, deduplicated with a
4096-key bound. If that tracking set overflows, the exact count is unknown and
`dropped_devices` becomes null; `dropped_devices_lower_bound` remains 4097.
Repeated observations never inflate the distinct count. Stored device
projections still have their separate 128-device limit.

## Privacy

All raw device keys (including URL-derived unsalted keys without USN), UDN
digests and unknown-service digests are re-keyed with HMAC-SHA256 and a fresh
32-byte OS-random session key. The first 16 bytes identify an entry. Domain
separation keeps device/UDN/service/metadata namespaces separate. The key and
original identifiers never enter retained state, JSON, summary, Debug or logs.
Repeated snapshots of one session correlate; fresh sessions do not correlate.
The HMAC primitive has an RFC 4231 test vector. No new crypto dependency is used.

Before identification or hashing, manufacturer/modelName/modelDescription and
SERVER discard Unicode Cc controls and Cf format characters (including
RLO/LRO, ZWJ/ZWSP and BOM) and truncate to 256 Unicode characters; friendlyName
uses the stricter 64-character limit. T1/UI text is untouched. The existing
metadata fields still contain only `{digest, characters, truncated,
controls_removed}`. Device `identification` adds the approved readable S1
projection, in JSON and the text/ZIP summary:

| Field | Export and purpose |
| --- | --- |
| `identification.brands` | Fixed normalized whitelist names, or `["unknown"]`. Only manufacturer, modelName and SERVER provide product evidence. Room names and free-form modelDescription do not influence brands or receiver classification. |
| `identification.brand_matches` | Fixed `{field, rule}` enum pairs for those three product sources only. Shows which source matched which approved rule, without echoing its text. |
| `identification.model` | Conservative ASCII model projection, at most 48 characters. Keeps known public product words/brands and short uppercase product codes containing both letters and digits (at most four leading letters), plus the explicit public `MiTV-` prefix followed by such a code. Repeated aliases of one brand are emitted once. Whitespace becomes spaces and is compressed; other words, bare numbers, invalid characters and suspicious atoms become `*`. Empty input is `unknown`. |
| `identification.server_products` | Known canonical product/stack names and optional main version only; e.g. `{name:"Platinum",major:1}`. Linux always has `major:null`. Unknown products/extra text are omitted; no match gives `{name:"unknown",major:null}`. |
| `identification.rules` | Boolean/enum evidence: `is_purek_room`, `is_lebo_receiver`, `has_avtransport`, `has_rendering_control`, `declares_ts` and `server_stack`. Brand-based flags use only manufacturer/modelName/SERVER; service/capability facts use structured observations. Unknown facts stay null; a truncated service list cannot prove absence. |
| `friendly_name` | Session HMAC, length and truncation/control flags only. Never exports original or sanitized room/store/user text, and never participates in brand/stack matches or classification. |
| `manufacturer`, `model_name`, `model_description`, `server` | Retain bounded HMAC metadata for correlation, not raw text. Readable facts are exclusively in `identification`. |

The single extensible whitelist is the `RULES` table in `identification.rs`:
normalized name, public display name, aliases and brand/stack/system kind.
`chunk`/`ChunK` (including the whole word in `chunk.cn`) normalize to `purek`.
Matching ignores case and requires whole words for Latin spellings; explicit
Chinese spellings may adjoin Chinese prose, while a Latin suffix (e.g. K in
纯K) still has a word boundary. No generic substring guessing is used.
SERVER version parsing permits at most three digits immediately following a
known product and `/`; minor/build versions, hostnames and arbitrary suffixes
are discarded. Linux kernel versions are never retained.

Model atoms with six consecutive digits, eight consecutive hex digits, a
UUID/MAC/IP shape, sensitive labels, oversized words or recognizable encoded
payloads are replaced by `*`. Sensitive labels also suppress the next value.
IPv4-shaped sequences use any of `-._` as separators, including mixed separators
and sequences glued to product prefixes (`KD-192-168-1-5`, `IP192-168-31-86`).
This check runs before the `MiTV-` exception, which never bypasses privacy masks.
Path/URL/email, percent-encoding and key/value syntax suppress the entire model
field so isolated path or room-value components cannot survive. Unknown ordinary
words are masked rather than treating arbitrary usernames as public model names.
Only ASCII letters/digits, `-._` and spaces (plus the `*` redaction marker) remain.
The original device name and metadata are never logged. Brand/stack labels are
fixed vocabulary, not evidence that a raw model or description was safe to echo.

Short codes such as `A12345` and `K8812` remain readable because they are also
ordinary public model identifiers needed to distinguish receiver behavior. The
conservative syntax cannot distinguish such a model from a room/asset code with
the same spelling. This exception applies only to modelName, never friendlyName;
six-digit runs, eight-digit hex runs, address/UUID/MAC shapes, sensitive labels
and encoded payloads still mask the atom. This is a diagnostic product-code
projection, not a general sanitizer for arbitrary private text.

Service-presence facts come from the renderer/T9 service summary or explicit
capability observations. `declares_ts` describes an actual reported sink list;
failed/not-yet-queried capabilities do not become false. Brand rules remain
diagnostic evidence, not admission policy. Existing `vendor_class` is preserved
independently, so whitelist evidence can reveal gaps in T1's classification.

## Result interpretation and upstream gaps

Priority follows the plan/next trace: preparation → control → pipeline →
before-play/starting → not-requested → zero-delivery → stopped →
delivered-unverified. No GET produces `cast_not_requested` only 10 seconds after
a successful Play; GET without body delivery produces `cast_no_delivery` only
after 10 seconds. Rejections are `cast_request_rejected`. Stop failure is kept
with status/Fault/disposition, but never becomes an output control failure.
Ignored/retrying failures do not override successful fallback actions. Terminal
T4 write-stall/peer-close/read/write failure maps to `cast_interrupted`; normal
EOF, cancellation and publication replacement do not prove receiver failure.
`write_error` is **not** relabeled `reset`, because T4 exposes no reset subtype.

`media_time_us` is retained unchanged as a **DTS watermark**, with its full
`live_start` basis; it is not PTS and may lead presentation by about 66.7 ms.
No synthetic correction is added. T4 emits first-byte once per generation and
byte counts at connection completion. Before completion, `bytes_written` is a
lower bound using the first successful write; terminal counts replace that
bound without double-counting the first write. `bytes_observed_ms` is receipt of the
terminal byte-count event, **not** the last successful write. Range request
counts, peer /24 relationship, actual last-write time and maximum simultaneous
GETs/preemptions are `null` until T8 supplies measurements via `RequestObservations`.
T4's `peer_mismatch` supports only a mismatch count. `header_preempted` counts
header-slot eviction only. T4 currently cannot
distinguish GET preemption from other replacement using its exposed facts.
These gaps do not justify changing reviewed T4 code in T7a.

The §7.6 conclusion uses user answers for learned modes/variants; delivery alone
never proves a visible picture. Unanswered/uncertain picture questions cannot
produce “received but did not decode.” Results and mode are report suggestions,
not persistent device preferences. No physical receiver is qualified by the
loopback tests. No T8 runner, UI or AppState state is implemented here.

S4 treats `video/mp2t` (any casing), `video/vnd.dlna.mpeg-tts`,
`video/x-mpegts`, `video/mpeg_ts`, `video/mpegts` and `video/mpeg-ts` as TS.
T1 also accepts `video/mpeg` for TS trial playback, but the same MIME denotes
program streams. Here `video/mpeg`/`video/x-mpeg` are TS only with an explicit
`DLNA.ORG_PN` beginning `MPEG_TS_`, `AVC_TS_`, `HEVC_TS_` or `VC1_TS_`;
otherwise they stay MPEG. These categories are diagnostic hints, not playback
admission rules. No profile/extension text is exported.

S6 action records include compact `result`: `ok`, `fault:<number>` (or
`fault:unknown`), `http:<class>xx`, `timeout`, `unreachable`, `cancelled`, or
`failed`. SOAP Fault takes precedence over HTTP status, including a Fault
without errorCode; either kind can match decision row 9. Missing actions have
no record (not attempted), and human questions retain their explicit
`unanswered`/`uncertain` values. Text summaries use the same action result.

### Interpretation of decision rows 3 and 4

The plan says row 3 covers “F×B or L×B” and stops at the first matching row,
which makes its row 4 (“only L×B”) unreachable. We interpret row 3 as **F×B
works**, whether or not L×B also works, and row 4 as **only L×B works**; any
working A cell still wins rows 1/2. This preserves the useful distinction
between video recoding alone and recoding plus mandatory live delivery. The
code already used this interpretation; this review documents it without
changing the plan itself. This interpretation has been confirmed by the orchestrator.

## Verification

`cargo test --manifest-path rust-runtime/Cargo.toml --locked --offline --features native-host --lib dlna::diagnostics::`
runs the real loopback discovery → registration/confirmation → Stop/Set/Play →
endpoint GET/body → revoke flow, ZIP/schema, privacy, HMAC correlation,
Unicode/control handling, stage priority, bounded/concurrent retention tests.
The three additive test-only module entries in T2/T4/T9 allow new fixtures to
use their private loopback policy without widening any production interface or
changing upstream logic/tests. No companion build or physical receiver is needed.
