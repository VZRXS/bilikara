# Playback execution boundary

Rust AppState remains the business authority. A media backend executes one
authorized program; it never owns a playlist, selects Next, admits artifacts,
changes history, or substitutes a renderer clock for a business generation.
The default backend is the existing WebView split player. Experimental renderers
under `research/` are not imported by Host, Remote or native product packages.

## Current ownership

| Responsibility | Current owner and boundary |
| --- | --- |
| Intent entry | Host controls in `static/app.js`; Remote HTTP controls; desktop/iOS/Android presentation commands and native media-session callbacks |
| Admission and business commit | `rust-runtime/src/app_state.rs` and its native-session adapters under the serialized AppState authority; queue version and playback generation protect Next/order changes |
| Renderer binding | `createHostPlaybackSession`, exact program claim and `mountHostPlaybackSessionElements` in `static/app.js`; one existing video/audio pair, one artifact owner |
| Local media execution | HTML video plus independent HTML audio in that pair; `setSplitPlaybackIntent`, `seekHostPlayer`, existing startup recovery and `syncSplitPlayer` |
| DSP and volume | `ensureAudioPitchSource`, `applyKeyShiftToAudio`, `static/pitch-player.js` and pinned Signalsmith; native element volume or the existing Web Audio gain path |
| Local time mapping | Video remains the navigation/readiness reference. Split synchronization relates it to offset-adjusted audio. Captured Web Audio paths additionally use `static/audio-clock.js` output segments and DSP/alignment latency; an element's read-ahead cursor alone is not audible time |
| Readiness and success | Exact session claim, both metadata/readiness checks and `commitHostPlaybackSessionReadyPaused`; actual playing observation is separate from a successful `play()` Promise |
| EOS and failure | Existing startup watchdog/recovery and `handleSplitAudioEnded`; capture, pitch and alignment tails drain before the existing Host generation-checked transition. The backend only observes EOS |
| Ordinary independent Audience | Separate muted video in `static/controller.js`, following Host clock publications through `static/presentation-sync.js`; it cannot choose Next or write history |
| Native HLS preview | `static/native-output.js` consumes the Rust generation/period/lease-bound output timeline using admitted MSE or system HLS. In independent output the Audience may own the stream's audio while Host preview is muted; this differs from ordinary split output |
| DLNA L0/L1 | Rust Native Host Pure K/output services and the admitted receiver transport. L0 packet delivery and L1 audio processing/TS timestamps are not equivalent to local WebView execution. `experimental_libav/live_audio.rs` is an existing L1 PCM/TS service, not a local platform audio sink |
| Window/display lifecycle | Desktop presentation WebView; iOS independent WKWebView scene; Android HostPresentation WebView. OS mirroring and independent extended output remain distinct |
| UI and transport | Host/Remote controls, QR, overlay composition, presentation session/heartbeat, native audio-session policy and authorized network protocols remain outside a replaceable media engine |

The reusable pieces are immutable program identity, exact artifact lifetime
claims, application settings, backend observations, the shared clock-correction
policy and pinned DSP assets. Existing WebKit startup/seek/readiness execution is
implementation-specific and is not a portable media engine.

## Minimal LegacyPlaybackAdapter contract (MEDIA-ARCH-01/02/07)

`static/media-backend.js` exposes `createLegacyPlaybackAdapter`. It is a thin,
generation-bound facade over callbacks owned by the existing playback session.
It creates no media, timer, command queue, artifact claim or AppState mirror.
Production uses it for loading an already-mounted pair after the original claim;
other ports are available without rerouting the entire existing control graph.

Every operation supplies the complete immutable program identity:

```js
{
  playback_generation, item_id, item_incarnation_id,
  selected_audio_variant_id, artifact_set_id
}
```

The session validates it against current AppState and the exact existing pair.
A stale identity or disposed facade throws synchronously before delegation.
Owners of asynchronous operations retain their existing checks after awaits.
The facade returns a delegated synchronous value or the exact delegated Promise;
it does not turn an immediate user-gesture operation into an asynchronous queue.
New observation callbacks run after the owner's synchronous commit on a
microtask, with another identity/disposal check; a callback cannot retire a
session halfway through its readiness commit. This does not queue commands.

| Operation | Domain contract |
| --- | --- |
| `load(identity)` | Start binding/loading the authorized, already-owned program; existing owner admits artifacts and handles readiness |
| `play(identity, options)`, `pause(identity)` | Existing intent and autoplay/manual-start behavior; no readiness or playing guarantee from command return alone |
| `seek(identity, seconds)` | Video-program timeline in seconds; existing asynchronous settlement/cancellation semantics |
| `setVolume(identity, gain, muted, options)` | Existing normalized gain (1 = 100%) and mute/settings orchestration |
| `setKeyShift(identity, semitones)` | Existing pitch control, processing and settings admission |
| `setAvDelay(identity, milliseconds)` | Existing signed AV Delay and settings admission; not a guessed IPC latency |
| `selectAudioVariant(identity, variantId)` | Existing exact-incarnation Host action; Rust decides the resulting generation/artifact selection |
| `snapshot(identity)` | Program navigation `timeSeconds` (same timeline as seek), separate `audioTimeSeconds` with `audioTimeBasis`, phase/readiness/observed-playing/duration/settings; no media element or native pointer. Neither reported media time nor an output segment is physical microphone/photodiode proof |
| `subscribe(callback)` | Unsubscribe function; observers cannot authorize Next or interfere with execution |
| `stop(identity)`, `dispose()` | Stop through the existing session's retirement; disposal revokes observers once. Existing session teardown owns nodes, DSP, pending work and lease release |

Capabilities describe the adapter's implemented operations, not a promise that
every engine/device can activate them. Existing capability probes and explicit
unavailable/manual-start states still apply. `ready`, observed `playing`, generic
playback `error`, phase changes and drained `eos` are distinct observations.
EOS is not acknowledged by the facade; the existing Host remains responsible for
generation validation, history and exactly-once advancement.

## Experimental admission and rollback (MEDIA-ARCH-03..06)

The Audio-First route exists only in an explicit test harness. It keeps Host audio
and DSP, publishes an audio-output timeline and attaches a video follower only
when a surface needs video. It does not patch or pause production Host video.
Its contract is deliberately narrower than product qualification. Signed-delay
openings retain both streams from zero: positive offset uses actual audio
silence/delay and negative offset holds frame zero. Flushed output segments
rebase on the element's `playing` transition, preserving DSP latency and output
tails. Cross-process experimental clocks are calibrated against a monotonic
clock; the shipping presentation protocol is unchanged. Precise PCM-aligned
seek/track recovery, uninterrupted output, OS interruptions and physical hotplug
still require their own acceptance evidence.

The isolated GStreamer executable has a trusted test stdin bridge and no native
Host API, Next algorithm or persistent business state. A real playback-service
adapter and platform surface/audio-session integration remain separate work.
Its Linux virtual audio/window tests cannot qualify Windows, macOS, iOS, Android,
AirPlay, DLNA or packaged plugin/license compatibility.

Rollback consists of retaining the original default WebView path. Neither
prototype is selected by production settings, startup or capability detection.
GStreamer must not become a packaged/default backend without functional timing,
single-decoder surface and cross-platform packaging gates in the requirements.
See [the experimental runner](../research/media-gstreamer/README.md) and
[measurement rules](playback-performance.md).

Review outcome and explicit remaining synchronization/EOS gates are recorded in
[Round A validation](round-a-validation.md). Functional tests do not qualify
physical playback; both prototypes remain isolated and the Legacy path default.
