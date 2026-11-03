# Selected-stream packet scan contract

`LibavMetadataProbe::scan_packets(path, ScanSelection { stream_index,
expected_kind }, &AtomicBool)` is an explicit companion operation. `expected_kind` is explicitly Audio or Video; the exact index must
exist and match. One selected stream per call, including in a muxed MOV/MP4.
This is independent of the production single-track normalization contract.
No default routing, AppState, Python endpoint, retries, publication or playback
changes. The normal Runtime still has no FFmpeg build/load dependency.

From the repository root, supply a matching native test prefix and local
synthetic fixtures. Use a private directory for generated outputs:

```bash
SCAN_PREFIX=/absolute/test-prefix
SCAN_FIXTURES=/absolute/fixtures
SCAN_OUT=/tmp/bilikara-scan
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix "$SCAN_PREFIX" --out "$SCAN_OUT/companion" --test
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
cargo run --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata -- \
  compare "$SCAN_OUT/companion/libbilikara_media_libav.so" "$SCAN_PREFIX" \
  "$SCAN_FIXTURES/av.mp4" synthetic-mux-audio --scan-stream 1 --scan-kind audio \
  --repeat 3 > "$SCAN_OUT/scan.jsonl" 2>/dev/null
```

Omitting both scan options runs metadata comparison; the two-path invocation
runs the metadata probe. Scan options must occur together, cannot combine with
`--pure-rust`, and never select the first stream implicitly. The comparison public-label,
absolute trusted paths, self-contained read-only regular file, repeat (1–10),
reference timeout (1–60000 ms), signal and `--cancelled` contracts still apply.
Raw native diagnostics are not intercepted; redirect stderr when saving the
allowlisted stdout report, as above. No URLs, playlists, devices or subordinate
opens are added to the MOV/FLAC envelope.

The metadata ABI v1 structs and exports remain compatible. The same companion has additive
`bm_scan_info_v1`, `bm_scan_packets_v1`, `bm_scan_release_v1` exports with an
independent schema/size check. An old/missing scan capability is `Unavailable`;
metadata remains usable and no CLI substitutes for the native call. AV objects
stay in C; results are copied/validated in Rust and freed by the allocating
companion while its library and callback are live.

Each call opens a fresh context with the metadata discovery settings. It continues from
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
explicit error and any partial evidence. Cancellation uses the probe atomic callback
before/after every read as well as native interrupts, including buffered reads;
there is no new native deadline or hard interruptibility promise. Reference
limits kill/reap the child and cannot count as completed parity.

The same comparison runner executes two explicit same-prefix references, both verified
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
directly compared by inventory; a bounded AAC spot-check and direct
accumulator tests cover them. Reference stderr is bounded, counted and discarded,
never parsed. Exit zero with diagnostics, two failures, or incomplete/unknown
counts cannot establish clean parity. Reports retain mismatch/execution evidence
and exit 1; only clean comparable runs exit 0. A concrete output-policy difference
needs a fixture explanation, not a null muxer in the companion or a tolerance.

Run packet checks together with metadata privacy and normalization-rejection checks:

```bash
npm run test:media -- \
  --companion "$SCAN_OUT/companion/libbilikara_media_libav.so" \
  --prefix "$SCAN_PREFIX" --fixtures "$SCAN_FIXTURES" \
  --long-fixture /absolute/fixtures/synthetic_hires_large.mp4 \
  --out "$SCAN_OUT/live" --packet-scan \
  --old-companion /absolute/previous-metadata-companion.so \
  --shim-test "$SCAN_OUT/companion/test_shim"
```

Artifact-dependent live tests require all declared inputs. Check truncated and
missing-mdat fixtures separately: apparent EOF, successful metadata or a zero
reference exit with read diagnostics cannot certify file completeness,
structure or decodability. The existing normalization envelope remains stricter
than packet enumeration.

Private C test injection after real reads covers non-EOF errors/corrupt flags;
Rust's existing callback seam covers cancellation and repeated ownership. These
are lifecycle evidence, not universal damaged-media rejection proofs. The suite
records Linux `wait4` maximum RSS of a paired driver process and native/reference
wall times; no speedup or constant-memory target follows. All generated media,
companions and reports go outside the repository.

Use the pinned 9.0.1 `avformat.h`, `packet.h` and same-source `demux.c`,
`mov.c`, `fftools/ffprobe.c` as the API authority. Online context:
[demuxing](https://ffmpeg.org/doxygen/trunk/group__lavf__decoding.html),
[AVPacket](https://ffmpeg.org/doxygen/trunk/structAVPacket.html),
[ffprobe](https://ffmpeg.org/ffprobe.html), [ffmpeg](https://ffmpeg.org/ffmpeg.html).
Online documentation is not the ABI pin. No full-decode, transform, additional
format support or production promotion is included.
