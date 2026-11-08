# Isolated GStreamer renderer experiment

This crate is outside all production Cargo workspaces and package construction.
It links the existing pinned Signalsmith C ABI directly, without linking libav
or the application Runtime. Do not add its dependencies/plugins to normal
bundles as part of an experiment.

Use an explicitly installed/staged GStreamer development SDK, matching runtime
plugins and normal `pkg-config` discovery. The crate currently admits SDK API
1.20+, not proof of the requirements' newer stable-SDK product target. Lock the
actual SDK/plugin versions and hashes in external experiment evidence.

```bash
export CARGO_TARGET_DIR=/absolute/HDD/build/gst-target
export PKG_CONFIG_PATH=/absolute/sdk/lib/pkgconfig
cargo build --manifest-path research/media-gstreamer/Cargo.toml --locked -j 4
```

The trusted manifest contains synthetic local absolute video/audio file paths,
a complete program identity (see `docs/media-backend.md`) and optional private
PulseAudio server/device. Keep it outside the checkout; never use real user
media, credentials or authorization URLs as profiling fixtures. The executable
prints bounded, locator-free JSON observations. Control stdin uses `action`,
`expected_program`, `seq` and action parameters. It rejects stale identities;
sequence values correlate observations and are not a second Host FIFO protocol.

`--playbin3-probe` distinguishes a video-only control, an SDK-observed auxiliary
AAC input, a reopened auxiliary FLAC input restored by Seek, and a two-audio-stream
container selected through `GstStreamCollection` / `GST_EVENT_SELECT_STREAMS`.
It checks selected messages, active `filesrc` identities, sink-input PTS and real
PulseAudio PCM, including the selected second tone with pinned Signalsmith.
The DSP uses the documented `audio-filter` bin seam, not an assumption that
playbin has no way to attach DSP.

`suburi` is documented as the **next subtitle URI**, not a general immediate
external-audio replacement setter. The SDK-matched source also advertises
auxiliary audio. Those facts require version-specific testing, not either a
blanket rejection or a promise of arbitrary external-track hot swapping.
An unchanged current audio source after setting a *next* URI does not prove
playbin3 cannot switch streams. Container selection, replacing an auxiliary
input with a reopened/seek-restored player, and uninterrupted replacement on
one persistent audio/DSP clock are different capabilities. The last remains an
admission gate. The custom pipeline is retained for explicit independent-input,
generation, DSP-tail and surface instrumentation, not because the old setter
experiment established playbin3 was unsuitable.

Official references: [playbin3](https://gstreamer.freedesktop.org/documentation/playback/playbin3.html),
[stream selection](https://gstreamer.freedesktop.org/documentation/additional/design/stream-selection.html),
and the [SDK-era source](https://github.com/GStreamer/gstreamer/blob/1.20.1/subprojects/gst-plugins-base/gst/playback/gstplaybin3.c).

The instrumented pipeline uses one video decode, independent audio decode inputs
and an input selector on one PulseAudio-selected clock. It resamples to F32LE
48 kHz stereo before the existing Signalsmith processor. Processing is always
active, including unity pitch. Fixed DSP latency is explicit in video scheduling;
signed user delay uses sink timestamp offsets. The bounded DSP tail drains before
EOS; flush resets the processor. Appsink monitoring is secondary to a real
`pulsesink`; `ximagesink` supplies actual X11 output. Decoder factories, selected
clock, sink render/drop statistics and processed PCM are reported.

The monitor is non-authoritative and must not delay pipeline preroll/pause.
`diagnosticClockLost` exercises pause-intent preservation; normal clock loss
must not force playback after the user paused. Tail input is explicitly zeroed
before processing. `dsp-work` reports minimum vector allocations and explicit
copy bytes: this PoC allocates input/output vectors per processing chunk and may
also incur Gst buffer copies. Its resource cost is not an optimized native
engine's cost. Diagnostic initial key/delay and bounded soak duration belong
only to the trusted experimental manifest.

Controls exercise pause/play, accurate flush seek, gain/mute, pitch, signed delay,
an externally authorized new track generation and stop. The isolated Linux X11
adapter accepts `host`/`audience` surface tokens, retains the audio clock and
changes video caps to fit the destination. Native handles stay internal.
`surfaceProbe` inspects visible X11 pixels to distinguish assignment from actual
frame delivery. This is neither native platform hotplug nor mobile Surface proof.
A trusted renderer bridge is not a public control API,
and acceptance of a command is not timing/continuity qualification.

The Linux lab helper starts its own PulseAudio null sink and Xvfb; it does not
reconfigure a user's server. It is specific to the staged Linux SDK layout and
requires PulseAudio utilities/modules. All temporary state and evidence must be
on the selected HDD. For actual output/PCM functional checks:

```bash
CUDA_VISIBLE_DEVICES='' .tmp/local-build-run.sh node scripts/validate-gstreamer-round-a.mjs \
  --sdk /absolute/staged/sdk --binary /absolute/HDD/build/gst-target/debug/bilikara-media-gstreamer-poc \
  --video /absolute/synthetic/video.mp4 --audio /absolute/synthetic/440hz.m4a \
  --output /absolute/HDD/evidence/gst-functional
```

Use a 90-second H.264 video and 48 kHz AAC 440 Hz tone. The runner creates a
second 44.1 kHz FLAC 880 Hz track and observes actual audio-server PCM, including
the expected shifted tones. This is an audio output check, not a physical-speaker
or precise A/V drift/latency measurement. Missing window/audio plugins, decoder
errors and unsupported surface actions must remain visible.

Do not claim device acceptance from this Linux prototype. Opening/closing
boundaries, timestamp discontinuities, sample-accurate delay changes, arbitrary
track latency, real surface reassignment, OS interruptions, long-duration drift,
Native Host integration, all-platform SDK packaging and license review remain
production admission gates. Keep official SDK distribution/licensing review
separate from successful local compilation.

## Qualification limits discovered during review

On the isolated core 1.20.3 / playback plugin 1.20.1 SDK, auxiliary AAC/FLAC
actually reaches PulseAudio, and container StreamCollection selection plus
Signalsmith changes the observed PCM frequency. However, the coded independent
auxiliary input remains on its zero-based GstSegment after a primary Seek to
12 seconds: sink PCM identifies source seconds 2/3 rather than 12..15. This is a
version-specific capability failure, not a claim that every playbin3 or GStreamer
version lacks independent audio. Reopening a URI or accepting SELECT_STREAMS
alone does not qualify seamless runtime track replacement.

The custom pipeline has also exhibited an intermittent drained-EOS timeout after
track changes and seeks. A later passing repetition cannot resolve that failure.
Segment/EOS sequence numbers, DSP tail timestamps and pipeline clock/base-time
observations remain available to diagnose it. The selector already forwards
upstream Seek events to all inputs; sending duplicate seeks to inactive pads is
not a justified remedy. Normal continuous playback and its long-run timing do
not qualify this control/recovery gate. Round B remains blocked until this and
uninterrupted EOS-to-Next output have reliable independent evidence.

[Final validation](../../docs/round-a-validation.md) records actual repeated
resource/timing results, SDK-specific auxiliary Seek failure, the intermittent
EOS blocker and unqualified delayed native-event attribution. Latest functional
passes do not close those gates or qualify physical platforms.
