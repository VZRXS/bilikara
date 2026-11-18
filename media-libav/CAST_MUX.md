# T3 cast mux contract (schema 2)

Native libav operation on a Runtime worker thread. No AppState, renderer controls,
HTTP, ring buffer, subprocess, Python fallback, video encoder or pitch/offset DSP.

## Provenance

Adapted from bilikara-next at `7750dca707286e74616a7e08ed5df506b9809b6f`:
`media-libav/live_ts.c` (L0 selection, backward keyframe seek, DTS merge, BSF and
CBR), `media-libav/live_audio.c` (decoder, resampler, bounded sample cache and AAC
encoder only), and `rust-runtime/src/experimental_libav/live_ts.rs` (callback
boundary). Sibling project, same authors; Copyright (c) 2026 bilikara contributors,
MIT. The complete permission/warranty notice is in repository LICENSE. No
signalsmith, two-track mixing or L1 DSP render callback was imported. The 4-second
GOP refusal was removed; long GOPs are reported, never silently re-encoded.

The cast implementation is ported from bilikara R1 T3 at `b49e1ae`.
It coexists with next's unchanged `live_ts.c`, `live_audio.c` and Signalsmith
pipeline in the same companion. Cast helpers use `cast_*`, `CastInput` and
`CastWriter`; L0/L1 keep their original names and independently negotiated ABI.
The cast module does not itself wire Host startup, clear-cache or HTTP routes;
those consumers are integrated by the separate session/endpoint port.

## ABI

Negotiate `bm_cast_info_v1(sizeof(BmCastInfo), &info)` before use. Require schema 2
and exact request/result/start sizes. Schema 1 is rejected before invocation; the
new request appends a CBR switch and a mandatory start callback. M1/scan/remux layouts remain unchanged. Missing
exports or mismatched sizes/capabilities return Rust `ProbeError::Unavailable`.
Capability requires matching pinned libav/swresample builds, TS/MP4 muxers,
h264_mp4toannexb and the built-in AAC encoder. All platform recipes now link
swresample. Source/rebuild kits include cast_mux.c, cast_audio.c and this document.

`bm_cast_preflight_v1(BmRequest*, BmCastResult*)` reads the full video packet stream
without decoding. It reports H.264 avcC profile_idc/level_idc (-1 if unknown), dimensions, B-frame evidence,
maximum observed GOP interval, source start and duration. GOP zero means fewer
than two keyframes; Rust exposes None. B-frame evidence uses codec delay and
reordered PTS/DTS. It is not a TV decoder compatibility certificate.

`bm_cast_mux_v1(BmCastRequest*, BmCastResult*)` is synchronous. The caller owns the
fixed-size result; no allocation/release export is needed. Nonzero function status
means invocation failure; otherwise inspect result.status. Success also requires
complete=1. All descriptors, paths, callbacks, result memory and the loaded library
live through return. C frees every libav allocation/handle. No AV types cross ABI.
Rust validates results and catches visitor panic rather than unwinding into C.

Inputs are read-only regular descriptors, each containing one stream: cached
H.264 MP4, plus selected audio in MP4/M4A or native FLAC. Subordinate IO/external
references/network IO are denied. H.264 is copied with h264_mp4toannexb for TS and
kept as AVC for MP4. HEVC/AV1 return BM_UNSUPPORTED_CODEC (5), mapped to
UnsupportedCodec; the caller must report unsupported casting, without a fallback.
Only AAC-LC with 1-2 channels at 44.1/48 kHz is copied with its configuration.
Other AAC profiles, channel counts and rates use the conversion path.
FLAC, E-AC-3, AC-3, MP3 and
Opus in those containers decode to 48 kHz stereo via swresample and encode with
native AAC-LC at 192 kbps. Missing decoders fail explicitly. Source audio is
bounded to 8-192 kHz / 1-8 channels. Corrupt/encrypted packets, malformed timestamps
and changing codec configuration fail instead of publishing uncertain media.

Seeking selects the preceding video keyframe and reports its actual presentation
start. DTS rebasing uses a common origin, preserving relative A/V timing and
B-frame offsets. Copy-path audio before that presentation start is skipped. The transcoder keeps
its preceding 1024-sample AAC priming packet so decoder overlap is preserved,
including after seeking. TS emits the first video IDR before this priming packet
even when video has no B-frame decode lead; per-stream PTS/DTS are unchanged.
Both tracks run
to EOF: short audio is not extended to video length, long audio is not truncated.
The final AAC frame can add at most 1024 samples of padding. Transcoding ends at decoded EOF, regardless of unknown or inaccurate container
duration/FLAC total samples. The six-hour bound is checked on actual decoded
samples. Decoder/demux errors still reject truncated sources. Seeking beyond usable audio fails rather
than silently generating video-only media. The inherited sample-clock validation
is not a general timestamp repair engine.

## Outputs and T4

output_kind=0 is callback TS: borrowed chunks <=188*128 bytes, TS-aligned,
monotonic emitted decode-time watermark in microseconds (relative to
timestamp_origin_us). key=1 marks the FIRST chunk of an IDR group,
including PAT/PMT before its video PES. Chunks may begin with PSI/null packets;
the first video PES is a keyframe. T4 copies bytes into its bounded ring, retains
at least ten seconds of whole groups and their offsets, and handles per-reader
continuity/discontinuity. Arbitrary chunk boundaries are not join points.

TS carries H.264 0x1B and AAC ADTS 0x0F. PCR belongs to video PID, requested period 20 ms;
PAT/PMT period 50 ms plus video frames. Actual intervals include bounded TS packet
quantization/PSI insertion for live CBR, checked against the byte clock. File VBR
emits PCR on video frames (e.g. 41.7 ms at 24 fps), without null-packet padding.
Live CBR muxrate follows next: twice known input
bitrates plus 1 Mbps (bounded source bitrate), allowing PCR between video frames.
Audio PES aggregation is disabled to preserve tail duration probing for unequal
tracks. CBR does not make copied high-profile/long-GOP input a uniform encoder.

Rust cast_ts accepts FullSpeed or Realtime { burst }; the default burst is five
seconds. It paces on a monotonic clock with cancellation polling <=10 ms. It never
waits on individual HTTP clients. Visitor false cancels the entire producer; T4
must not return false merely because one reader disconnected. A max_bytes limit
applies to the whole generation. File TS uses the same producer at full speed with ts_cbr=0; live callbacks use
ts_cbr=1 even in FullSpeed test mode. Pacing and mux rate are independent.

output_kind=1 is a private empty staging file, seekable bounded IO, faststart MP4
with unsigned CTS (ctts v0) and edit lists for B frames. Only that exact path may reopen read-only for faststart.
No byte visitor is used (the start event is still delivered). Write/seek/trailer/flush/close errors propagate. MP4 is
file-only, not fragmented live MP4.

`cast_ts_with_events` reports CastEvent::Start before the first Data event. It
contains source_start_us (actual video presentation start), timestamp_origin_us
(common packet time origin), AVC profile/level, dimensions, B-frame evidence and
whether audio was transcoded. T4 can initialize position mapping/ring state
without waiting for EOF. Start callback false cancels, and a panic is contained
like a byte callback. The original cast_ts byte-only convenience method remains.

## Storage

CastSession::new(cache_root, max_bytes) receives runtime/data/cache or its explicit
override. It makes a random 128-bit exclusive directory under .cast (POSIX 0700).
Inputs remain read-only. Generators serialize within a session; retained files
share a total byte quota. Cancelled/failed .part files are removed. Successful
files are synced, size-checked and renamed to unique final names inside that
exclusive directory. No hard link is used. Android uses the shared renameat2(RENAME_NOREPLACE)
syscall helper (no dependency on the API-30 bionic symbol). Callers cannot
choose a publication destination that overwrites cached media.

CastFile is a lease: keep it until the last reader closes, especially on Windows.
Drop removes the file and frees its quota. Drop session and last lease to remove
the owned directory. Failed deletions do not free quota prematurely. Each directory holds an exclusive OS .lease lock until the last reader lease
ends. The stable .cast/.lock serializes recovery/creation; it is never unlinked.
CastSession::recover scans only direct, 32-hex session directories in .cast,
rejects a linked root/lock and skips linked session directories. It removes only
unlocked orphans, including a crash before .lease creation. Rust recursive removal
does not follow child links. Host startup, clear-cache and new session creation
invoke recovery; .cast is excluded from cache_metrics. Clear-cache retains live
sessions/readers. Recovery is best effort per entry: a busy/inaccessible orphan or
invalid lease is retained while other orphans are reclaimed. `recover` returns
`CastRecovery` (collected, retained_live, skipped and counts by fixed stage/reason),
and logs path-free summary diagnostics when anything is skipped. Even an invalid
cast root cannot fail Host startup or clear-cache; creating a new session still
requires a safe root and its exclusive gate. The empty .lock remains after normal cleanup.
The existing loader is packaged for Windows/macOS/Linux. Android without that
optional loader returns Unavailable; the storage implementation uses portable
rename rather than Android-forbidden hard links.

## Tests

Run npm run test:libav-wrapper. With an actual native prefix, set
BILIKARA_TEST_LIBAV_COMPANION=<prefix>/bin/<companion> and run
npm run test:libav-prerequisites. It rebuilds in isolated output, runs C shim and
all ignored experimental_libav::cast_mux::tests with the new test
companion; it never modifies the supplied prefix. For a direct Runtime run, set
BILIKARA_TEST_CAST_COMPANION to that test companion and filter experimental_libav::cast_mux::tests:: with --ignored --test-threads=1.
The test shim has explicit fault-injection state; these tests run serially.
The non-ignored ABI=0 regression builds `tests/fixtures/libav_incompatible.c`
with the native C compiler and verifies rejection before cast negotiation.

Coverage: AAC copy, 96 kHz FLAC/E-AC-3 conversion, short/long audio, TS/faststart
MP4, B frames, preflight, keyframe seek/midstream joins, PSI types/PCR PID,
PCR/PAT intervals, <=0.1 second duration error, quota, cancellation, callback panic and lease cleanup.
Three GOPs are made by remuxing the existing 24-frame H.264 fixture, without a
video encoder or download. Native inspection exports exist only in test_shim.
Review regressions cover unknown/overstated/understated FLAC sample counts,
5.1 and 32 kHz AAC conversion, Main/HE-AAC copy-gate refusal (C shim), priming on
B-frame/intra-only video and seek, start-before-data/cancellation, VBR size and
CBR clocks, unsigned MP4 CTS, empty/truncated/wrong-stream inputs, injected decoder
IO propagation, cancellation after a nonempty .part, and Unicode input paths.
Non-media Rust tests cover crash-process orphan recovery with a live reader lease,
startup and clear-cache integration, and metrics exclusion. Windows regressions
use actual delete-sharing denial, an invalid lease directory and an access-denied
ACL; they verify independent orphan cleanup, live reader protection, path-free
diagnostics, new-session creation and real Host startup with a loopback listener. Native Main/HE-AAC
conversion is not exercised: no fixture/encoder for those profiles is available.
Windows native evidence does not qualify macOS/Linux builds, Android packaging
or real receivers. T4 ring/HTTP acceptance remains separate.
