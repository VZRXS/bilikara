# M3 explicit packet scan (Linux, FFmpeg 9.0.1)

`LibavMetadataProbe::scan_packets(path, ScanSelection { stream_index,
expected_kind }, &AtomicBool)` adds one developer capability to the existing
companion. `expected_kind` is explicitly Audio or Video; the exact index must
exist and match. One selected stream per call, including in a muxed MOV/MP4.
This is independent of the production single-track normalization contract.
No default routing, AppState, Python endpoint, retries, publication or playback
changes. The normal Runtime still has no FFmpeg build/load dependency.

From the repository root, reuse the accepted prefix and fixtures:

```bash
M3_PREFIX=/sunhonglin/bilikara/.tmp/m1-libav-9/ffmpeg-prefix
M3_FIXTURES=/sunhonglin/bilikara/.tmp/m1-libav-9/fixtures
M3_OUT=/tmp/bilikara-m3
python media-libav/build.py --prefix "$M3_PREFIX" --out "$M3_OUT/companion" --test
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
cargo run --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata -- \
  compare "$M3_OUT/companion/libbilikara_media_libav.so" "$M3_PREFIX" \
  "$M3_FIXTURES/av.mp4" synthetic-mux-audio --scan-stream 1 --scan-kind audio \
  --repeat 3 > "$M3_OUT/scan.jsonl" 2>/dev/null
```

Omitting both scan options preserves M2 metadata comparison; the old two-path
invocation preserves M1. Scan options must occur together, cannot combine with
`--pure-rust`, and never select the first stream implicitly. M2's public-label,
absolute trusted paths, self-contained read-only regular file, repeat (1–10),
reference timeout (1–60000 ms), signal and `--cancelled` contracts still apply.
Raw native diagnostics are not intercepted; redirect stderr when saving the
allowlisted stdout report, as above. No URLs, playlists, devices or subordinate
opens are added to M1's MOV/FLAC envelope.

M1 ABI v1 structs and exports are unchanged. The same companion has additive
`bm_scan_info_v1`, `bm_scan_packets_v1`, `bm_scan_release_v1` exports with an
independent schema/size check. An old/missing scan capability is `Unavailable`;
metadata remains usable and no CLI substitutes for the native call. AV objects
stay in C; results are copied/validated in Rust and freed by the allocating
companion while its library and callback are live.

Each call opens a fresh context with M1 discovery settings. It continues from
`find_stream_info` without flushing/seeking: the buffered prefix is returned by
`av_read_frame` exactly once. It then reads to the terminal result, unreferences
each packet and frees the last packet/context/AVIO on all exits. Project storage
is a bounded aggregate, not packet payloads or a packet list. FFmpeg's internal
buffering can use additional memory.

`PacketScan` reports depth, requested/observed identity, demuxed packet count,
selected packet count, sum of `AVPacket.size` payload bytes, selected and
incidental corrupt-packet counts, and optional min/max PTS/DTS in stream time
base ticks. These are packet counts, not frames/samples; bounds are observed
packet timestamps, not decode end or duration. Unknown remains null, negatives
are retained, and presentation reordering/key/discard flags are not corruption.
All count/byte additions are checked; overflow is an incomplete backend failure.

`terminal=Eof` records only the demuxer's observed end. `clean_eof()` additionally
requires selected packets, no error and no selected/incidental corrupt marks.
Corrupt marks persist even when enumeration continues to EOF. Empty selected
media is InvalidMedia; wrong/no-match selection is InvalidRequest. Non-EOF read
errors, AVIO errors, cancellation and backend failures remain incomplete with
explicit error and any partial evidence. Cancellation uses M1's atomic callback
before/after every read as well as native interrupts, including buffered reads;
there is no new native deadline or hard interruptibility promise. Reference
limits kill/reap the child and cannot count as completed parity.

The same M2 runner executes two explicit same-prefix references, both verified
against the companion's full 9.0.1 configuration and build/runtime versions:

- Inventory: `ffprobe -count_packets -select_streams INDEX -show_entries
  stream=index,codec_type,codec_name,time_base,nb_read_packets:error=code -of json`.
- Operational: the existing `bilikara/cache.py::_validate_demux_file` shape,
  `ffmpeg -nostdin -v error -xerror -i INPUT -map 0:INDEX -c copy -f null -`.

Both use the same discovery settings and a seekable `fd:` without filename
hint. The ffmpeg command leaves MOV-only `enable_drefs`/`use_absolute_path` at
their verified 9.0.1 defaults (zero); explicitly passing them rejects raw FLAC
as unused options. The fd-only protocol restriction stays explicit. The
companion enumerates incidental streams; ffprobe reports only the selected one.
The ffmpeg streamcopy path also imposes output/timestamp policy and is not the
same operation as demux iteration. Neither operation is full decoding and the
references share libav, so agreement is not independent decoder evidence.

Counts and identities compare exactly. Bytes/timestamp bounds are marked not
directly compared by inventory; a bounded 48-packet AAC spot-check and direct
accumulator tests cover them. Reference stderr is bounded, counted and discarded,
never parsed. Exit zero with diagnostics, two failures, or incomplete/unknown
counts cannot establish clean parity. Reports retain mismatch/execution evidence
and exit 1; only clean comparable runs exit 0. A concrete output-policy difference
needs a fixture explanation, not a null muxer in the companion or a tolerance.

The live suite extends M2, including its privacy and retained S3 rejection tests:

```bash
python media-libav/test_comparison.py \
  --driver /sunhonglin/bilikara/rust-runtime/target/debug/examples/libav_metadata \
  --companion "$M3_OUT/companion/libbilikara_media_libav.so" \
  --prefix "$M3_PREFIX" --fixtures "$M3_FIXTURES" \
  --long-fixture /tmp/bilikara_media_native_research_20260901_ijcpsG/fixtures/synthetic_hires_large.mp4 \
  --out "$M3_OUT/live" --packet-scan \
  --old-companion /sunhonglin/bilikara/.tmp/m1-libav-9/companion/libbilikara_media_libav.so \
  --shim-test "$M3_OUT/companion/test_shim"
```

No artifact-dependent live test skips. Healthy counts: H.264 60, AAC 48, FLAC
12, long FLAC-MP4 3520; muxed selected counts equal their single-track versions.
The four-second late-truncation fixture has successful metadata, 45 observed
packets and one corrupt mark, then apparent EOF. ffprobe exits zero with read
diagnostics; ffmpeg `-xerror` fails. This is retained problem evidence, not clean
parity. The old missing-mdat fixture still scans cleanly (48 packets) while
existing normalization rejects it: demux EOF cannot certify original file
completeness, structure or decodability. S3 remains unchanged.

Private C test injection after real reads covers non-EOF errors/corrupt flags;
Rust's existing callback seam covers cancellation and repeated ownership. These
are lifecycle evidence, not universal damaged-media rejection proofs. The suite
records Linux `wait4` maximum RSS of a paired driver process and native/reference
wall times; no speedup or constant-memory target follows. All generated media,
companions and reports go outside the repository.

API details were checked against installed 9.0.1 `avformat.h`, `packet.h` and
same-source `demux.c`, `mov.c`, `fftools/ffprobe.c`. Online context:
[demuxing](https://ffmpeg.org/doxygen/trunk/group__lavf__decoding.html),
[AVPacket](https://ffmpeg.org/doxygen/trunk/structAVPacket.html),
[ffprobe](https://ffmpeg.org/ffprobe.html), [ffmpeg](https://ffmpeg.org/ffmpeg.html).
Online documentation is not the ABI pin. No full-decode, transform, additional
format support or production promotion is included.
