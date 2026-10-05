Synthetic media for the shared BBDown executor boundary tests. No provider media,
credentials or tool output is included. `video.mp4` is the existing M6 synthetic
H.264 fixture; `audio.m4a` and `audio-flac.mp4` are the existing libav AAC sine and
96 kHz FLAC-in-MP4 synthetic fixtures. `video-hevc.mp4` is the existing two-second
64x64 synthetic HEVC media-taxonomy fixture, reused to check validated passthrough
and missing-mdat rejection without extending the copy-remux profile.
`audio-eac3.m4a` contains 64 frames of stereo silence at 48 kHz, encoded with the
existing libav 9 E-AC-3 library and muxed in process for this fixture (128 kbps).
It exercises default Host Dolby validation; no encoder or media executable is
added to the application or invoked by the tests.
The AAC and FLAC clips are about one second long. The H.264 fixture presents its single sample
for two seconds (mdhd timescale 256, mvhd/tkhd duration 2000 at timescale 1000). Playlist
metadata deliberately reports a different duration to guard against restoring
metadata-duration completeness checks. Tests copy these local bytes through the
controlled child in `tests/bbdown_fixture.rs`, then use real Runtime inspection,
normalization and publication. No media CLI is invoked by these tests.

`video-reordered-start.mp4` is a 2376-byte, 24-packet synthetic AVC timing
fixture (160x90, time base 1/16000). Its fragmented sample table has PTS bounds
336..15685 and DTS bounds -2334..13015: a positive presentation start with
decode preroll and reordered composition offsets. The libav regression requires
these independently specified bounds, payload length 1083, and unchanged decoder
configuration after ordinary faststart MP4 remux. This checks demux-visible
packet preservation, not a full-decoder or device-playback certificate.

The encoded solid-color samples were produced offline with the test-only
libx264 encoder (`color=c=0x354c62:s=160x90:r=24000/1001`, 24 frames,
`bframes=3:b-adapt=0:keyint=24:scenecut=0`, yuv420p), with MP4 options
`+frag_keyframe+delay_moov+default_base_moof`, `video_track_timescale=16000`,
`avoid_negative_ts=disabled`, `output_ts_offset=0.021`, `use_editlist=1`.
The timing table adds 1335 ticks to the media edit and composition offsets;
packet 4's composition offset is 3337 and packet 7's is 0, giving a signed-CTS
round trip with the stated bounds. No payload or decoder bytes were changed.
Tests use the committed bytes and require no encoder, CLI or network.

The DownKyi HEVC/Dolby passthrough test needs the packaged libav validator.
Build the libraries with `bash media-libav/build-posix-libraries.sh`, then run
`cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix "$BILIKARA_LIBAV_PREFIX" --out "$BILIKARA_LIBAV_PREFIX/bin" --test`
(using an absolute `BILIKARA_LIBAV_PREFIX`), and set
`BILIKARA_TEST_LIBAV_COMPANION` to the resulting
`bin/libbilikara_media_libav.so` when running the Linux Python suite. The test
loads that library in a subprocess so the other tests retain their independent
pure-Rust/legacy fallback configuration. CI provisions this prerequisite from
the existing signed source and verified cache.
