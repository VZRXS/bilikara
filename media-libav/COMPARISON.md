# M2 developer metadata comparison (Linux, FFmpeg 9.0.1)

This extends the accepted M1 driver and uses its real
`LibavMetadataProbe::load` / `probe_metadata` entry. Only an explicit `compare`
subcommand starts a reference process. No runtime startup/build dependency,
AppState mutation, cache sampling, routing, retry, publication or playback change.
The old two-argument driver and M1 ABI v1 remain unchanged.

## Run one authorized local sample

From the repository root, with the already accepted M1 prefix/companion:

```bash
cargo run --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata -- \
  compare /sunhonglin/bilikara/.tmp/m1-libav-9/companion/libbilikara_media_libav.so \
  /sunhonglin/bilikara/.tmp/m1-libav-9/ffmpeg-prefix \
  /sunhonglin/bilikara/.tmp/m1-libav-9/fixtures/aac.m4a synthetic-aac \
  --pure-rust audio --repeat 3 > /tmp/bilikara-m2-aac.jsonl 2>/dev/null
```

Paths must be absolute and explicitly trusted. The prefix selects exactly
`bin/ffprobe` and child-only `LD_LIBRARY_PATH=prefix/lib`; PATH is never searched
for the reference. The fixture must be a caller-authorized, self-contained,
stable regular local file. Opened input descriptors are read-only/nonblocking
and checked for regular-file type. No cache scan or Bilibili access occurs.

The label must be a non-sensitive public identifier of 1–64 ASCII letters,
digits, `_` or `-`; never put a media title or secret in it. Each iteration emits
one bounded, allowlisted JSON line. The tool itself does not persist reports.
`--repeat` accepts 1–10, default 1. `--pure-rust audio|video` explicitly requests
the existing read-only `probe_media` operation and its expected single-track
contract; omitting it leaves `pure_rust`/`secondary` null. It never normalizes
media. The existing normalization rejection is exercised only by the dedicated
live acceptance test, as in M1.

`--timeout-ms` (1–60000, default 5000) bounds each reference process, including
its identity call. SIGINT/SIGTERM and `--cancelled` set the same atomic flag used
by M1. Reference cancellation, timeout, oversized output and read errors kill
and reap the direct child. This is a synchronous local driver, not a scheduler
or subprocess sandbox. M1 remains cooperatively cancellable (no new hard native
timeout); the existing Pure Rust scan checks the flag before entry only.

Exit 0 means there is no unexpected comparable mismatch or execution error;
expected depth/contract and advisory differences may still be present. Exit 1
retains unavailable, cancelled, failed and mismatched results in JSON. Matching
malformed-input rejections also exit 1: they are expected negative evidence, not
successful parity. Exit 2 is a usage error. No result triggers a fallback.

## Reference and field contract

M1 still negotiates actual build/runtime versions and configurations before
libav struct access. The driver obtains structured ffprobe program/library
versions and compares its **entire configuration in memory** with M1's build and
all three runtime configurations. No reference media probe runs unless this
same-build check succeeds. Reports retain numeric library versions and a fixed
allowlist of configuration flags; prefix/other option values are omitted.
The existing upstream signature and dependency-origin evidence remain in
`.tmp/m1-libav-9/`; no hashes, new manifest or provenance system were added.

The metadata reference uses `-v error -of json -show_entries` with only:

- `format`: `format_name,duration,start_time,bit_rate`.
- `stream`: `index,codec_type,codec_name,width,height,sample_rate,channels,`
  `duration,start_time,time_base,bits_per_raw_sample,bit_rate`.
- `error`: numeric `code` only.

Both use format probe 65536 bytes, probe 1048576 bytes, analyzeduration 1000000
media microseconds, 256 probe packets, 32 streams, and disabled PTS duration
estimation. The CLI option is `-formatprobesize` (the installed 9.0.1 spelling).
Both read a seekable `fd:` without a filename hint. M1 explicitly pre-probes
before open; ffprobe probes within open. M1 rejects every subordinate `io_open`;
CLI uses only the fd protocol and `enable_drefs=0,use_absolute_path=0` in a
network-disabled build. Only self-contained local inputs are in scope.
Neither enumerates packets/frames. `find_stream_info` can read packets and do
limited decoding: this is stream-metadata discovery, not header-only I/O or
complete validation. Same-build agreement tests the shim/conversion/options and
field semantics; it is not independent decoder proof.

Comparison semantics live in Rust's experimental `comparison` module:

| Fields | Rule |
| --- | --- |
| Container family | Only the M1 MOV alias list, `mov`, `mp4`, `m4a` map to `mov_mp4`; raw `flac` stays separate. |
| Inventory | Exact count and actual unique index/type; missing/extra indices remain separate findings. Different types at one index are not paired for other fields. |
| Codec/dimensions/rate/channels/raw bits | Exact known values; no fuzzy codec matching. |
| Container duration/start | Separate fields in integer microseconds; exact (0 us tolerance), matching six-decimal CLI output units. |
| Stream duration/start | Separate fields; at most 1 us from tick-to-nearest-us versus CLI decimal rounding. No time-base tick or blanket percentage tolerance. |
| Time bases | Reduce positive rationals by GCD. Negative starts are retained. |
| Unknown fields | Absent/`N/A` stays null; known versus unknown is advisory; two unknowns are `not_comparable`, not equality evidence. Meaningful zero time stays zero. |
| Bitrate | Known estimates compared exactly, differing estimates are advisory, never integrity failures. |

`matching_comparable_metadata` concerns only comparable known fields. A report
can also contain `semantic_mismatch`, `depth_or_contract_difference`, `advisory`,
`backend_or_reference_error`, `potential_safety_mismatch` and `not_comparable`.
Each finding retains both field values and a reason. Stream failures are not
removed to make an inventory match. Generic exits/JSON failures/unknown numeric
reference errors remain errors; only pinned numeric INVALIDDATA/EOF classify
as invalid media. Stderr is discarded, never parsed for Unsupported.

The Pure Rust API exposes kind, codec and maximum sample decode end, but no
stream index, dimensions/rate/channels/start/time base. Association is justified
only by a successful exactly-one-requested-track contract. Its sample-end time
is preserved separately from AVStream presentation duration: edit-list effects
cannot be resolved from that API, even when the numbers happen to match.
AAC here reports 1021333 us versus 1000000 us; this is an explicit timeline
contract difference, not a tolerance widened to make them equal.

Enumeration success, requested stream contract satisfaction and complete media
validation are separate facts. The report explicitly says complete validation
is not established. Multi-stream enumeration can succeed while Pure Rust
rejects its single-track request. Raw FLAC is outside that operation's MP4
input contract. The old missing-mdat fixture succeeds in both read-only probes;
existing `normalize_media` still returns `InvalidMedia`, disallows fallback,
and publishes nothing. The dedicated `normalization-contract.json` records
that stricter result without changing S3 or adding a normalization mode.

## Explicit live acceptance

Build the driver once, then run the suite (no missing-artifact skips):

```bash
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
python media-libav/test_comparison.py \
  --driver /sunhonglin/bilikara/rust-runtime/target/debug/examples/libav_metadata \
  --companion /sunhonglin/bilikara/.tmp/m1-libav-9/companion/libbilikara_media_libav.so \
  --prefix /sunhonglin/bilikara/.tmp/m1-libav-9/ffmpeg-prefix \
  --fixtures /sunhonglin/bilikara/.tmp/m1-libav-9/fixtures \
  --long-fixture /tmp/bilikara_media_native_research_20260901_ijcpsG/fixtures/synthetic_hires_large.mp4 \
  --out /tmp/bilikara-m2-live
```

The supplied long fixture is the existing approximately 300-second, 96 kHz,
24-bit stereo FLAC-in-MP4 synthetic sample. The corpus uses M1/S3 fixtures:
H.264 MP4, AAC M4A, two-stream H.264/AAC MP4, raw FLAC, FLAC MP4, unknown-duration
FLAC, missing mdat, truncated header and malformed header. Three sequential
runs per sample distinguish first-in-process from repeated runs; this is not a
cold-cache benchmark. JSON measures companion setup, identity subprocess,
M1 call, reference startup+probe+cleanup, optional Pure Rust sample scan, and
normalization/comparison separately. Per-call/run times exclude report
serialization/output; cumulative process time includes earlier report output.
Pure Rust sample scanning is different work; no speedup target or memory/leak
claim follows from these timings.

The Python suite orchestrates the executable and asserts Rust decisions. It
also invokes the existing M1 AppState/default isolation test and the explicit
Rust normalization-rejection test, verifies missing artifacts and active-child
cancellation/reaping, and creates one synthetic tagged copy outside the repo
for privacy testing. Raw tags, private input/config paths, signed URL strings,
auth/cookie/room strings and error text are excluded from reports. No raw
ffprobe JSON or unfiltered stderr is persisted. An old M1 invocation with a
poison PATH ffprobe verifies that it still does not request a comparison.

Focused tests (no companion needed for the ordinary tests):

```bash
cargo test --manifest-path rust-runtime/Cargo.toml --locked --lib experimental_libav::comparison
cargo test --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
```

Comparator tests deliberately alter codec, stream count/index/type, times and
known/unknown values; cover rational/alias normalization, negative/zero times,
malformed numeric data, advisory bitrate, identity mismatch and privacy; and
separate retained stricter rejection from a hypothetical successful single-track
contract bypass. The example test checks deadline/cancellation/output bounds
and reaping. The one new artifact-dependent Rust test is ignored in ordinary
Cargo runs and is explicitly executed by the live suite.

Windows/macOS companion loading/packaging, authenticated Hi-Res samples,
full decode, WebView/device playback, automatic production observation and
v0.8's observation period remain outside this developer slice. The 9.0.1 local
experiment does not migrate release bundles on other platforms.
